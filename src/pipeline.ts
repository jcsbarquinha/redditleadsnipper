/**
 * Full pipeline: user input → AI keywords (10 by default) → Reddit search (100 posts/keyword, dedupe) → comments → DB.
 */

import { randomUUID } from "node:crypto";
import { getKeywordsForInput, DEFAULT_KEYWORD_COUNT } from "./ai-keywords.js";
import { classifyPostWithComments } from "./ai-intent.js";
import { insertRun, updateRunStatus, insertPost, insertComments, insertPostIntent } from "./db/index.js";
import { search } from "./reddit-search.js";
import { fetchComments } from "./reddit-comments.js";
import type { RedditPost } from "./types.js";

const DEFAULT_MAX_PAGES_PER_KEYWORD = 4; // 100 posts per keyword
const DEFAULT_DELAY_MS = 500; // 0.5s between requests (min 0.5s to reduce rate-limit risk)

/** Only process posts from the last 30 days (per PRD; relevance search, then filter by date). */
const MAX_POST_AGE_DAYS = 30;

/** Skip LLM for posts with too little content (cost protection per PRD). */
const MIN_CONTENT_LENGTH = 20;

function isPostWithinMaxAge(post: RedditPost): boolean {
  const created = post.created_utc;
  if (created == null || typeof created !== "number") return false;
  const cutoff = Math.floor(Date.now() / 1000) - MAX_POST_AGE_DAYS * 24 * 3600;
  return created >= cutoff;
}

function hasEnoughContentForIntent(post: RedditPost): boolean {
  const title = (post.title ?? "").trim();
  const body = (post.selftext ?? "").trim();
  return title.length >= 1 || body.length >= MIN_CONTENT_LENGTH;
}

export interface PipelineOptions {
  userInput: string;
  includeComments?: boolean;
  maxPagesPerKeyword?: number;
  delayMs?: number;
  /** Number of AI-generated keywords (default 10 for broader coverage; use 4 for faster runs). */
  keywordCount?: number;
}

export interface PipelineResult {
  runId: string;
  keywords: string[];
  totalPosts: number;
  totalComments: number;
  /** Number of posts with intent classified (one rating per post, 0-100). */
  totalPostIntents: number;
}

/** Dedupe by reddit post id; track which keywords matched each post */
function dedupePosts(
  keywordResults: { keyword: string; posts: RedditPost[] }[]
): Map<string, { post: RedditPost; matchedKeywords: string[] }> {
  const byId = new Map<string, { post: RedditPost; matchedKeywords: string[] }>();
  for (const { keyword, posts } of keywordResults) {
    for (const post of posts) {
      const id = post.id ?? "";
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        if (!existing.matchedKeywords.includes(keyword)) {
          existing.matchedKeywords.push(keyword);
        }
      } else {
        byId.set(id, { post, matchedKeywords: [keyword] });
      }
    }
  }
  return byId;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const {
    userInput,
    includeComments = true,
    maxPagesPerKeyword = DEFAULT_MAX_PAGES_PER_KEYWORD,
    delayMs = DEFAULT_DELAY_MS,
    keywordCount = DEFAULT_KEYWORD_COUNT,
  } = options;

  const runId = randomUUID();
  const keywords = await getKeywordsForInput(userInput, keywordCount);
  insertRun(runId, userInput, keywords, "running");

  try {
    const keywordResults: { keyword: string; posts: RedditPost[] }[] = [];
    for (const keyword of keywords) {
      const posts = await search(keyword, {
        maxPages: maxPagesPerKeyword,
        delayMs,
        exactPhrase: true,
      });
      keywordResults.push({ keyword, posts });
    }

    const uniquePosts = dedupePosts(keywordResults);
    let totalComments = 0;
    let totalPostIntents = 0;

    for (const { post, matchedKeywords } of uniquePosts.values()) {
      if (!isPostWithinMaxAge(post)) continue;

      if (includeComments && post.subreddit && post.id) {
        try {
          post.comments = await fetchComments(post.subreddit, post.id, { delayMs });
        } catch {
          post.comments = [];
        }
      } else {
        post.comments = [];
      }
      insertPost(runId, post, matchedKeywords);
      insertComments(runId, post, post.comments);
      totalComments += post.comments.length;

      const postId = `${runId}_${post.id ?? ""}`;
      try {
        if (!hasEnoughContentForIntent(post)) {
          insertPostIntent(postId, "low", 0, null, null, false);
          totalPostIntents++;
        } else {
          const commentBodies = post.comments.map((c) => c.body ?? "");
          const intent = await classifyPostWithComments(
            userInput,
            post.title,
            post.selftext ?? "",
            commentBodies,
            post.created_utc
          );
          insertPostIntent(
            postId,
            intent.label,
            intent.score,
            intent.explanation,
            intent.suggested_reply,
            intent.is_high_intent
          );
          totalPostIntents++;
        }
      } catch (err) {
        console.warn(`Intent skip (post ${postId}):`, err instanceof Error ? err.message : err);
      }
    }

    updateRunStatus(runId, "completed");
    const recentCount = [...uniquePosts.values()].filter(({ post }) => isPostWithinMaxAge(post)).length;
    return {
      runId,
      keywords,
      totalPosts: recentCount,
      totalComments,
      totalPostIntents,
    };
  } catch (err) {
    updateRunStatus(runId, "failed");
    throw err;
  }
}
