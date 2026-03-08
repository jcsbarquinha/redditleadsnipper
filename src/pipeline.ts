/**
 * Full pipeline: user input → AI keywords (10 by default) → Reddit search (100 posts/keyword, dedupe) → comments → DB.
 */

import { randomUUID } from "node:crypto";
import { getKeywordsForInput, DEFAULT_KEYWORD_COUNT } from "./ai-keywords.js";
import { classifyPostWithComments } from "./ai-intent.js";
import { insertRun, updateRunStatus, insertPost, insertComments, insertPostIntent } from "./db/index.js";
import { search } from "./reddit-search.js";
import { fetchComments, fetchPostEngagement, fetchPostEngagementFromLink } from "./reddit-comments.js";
import type { RedditPost } from "./types.js";

const DEFAULT_MAX_PAGES_PER_KEYWORD = 4; // 100 posts per keyword
const DEFAULT_DELAY_MS = 500; // 0.5s between requests (min 0.5s to reduce rate-limit risk)

/** Only process posts from the last 30 days (per PRD; relevance search, then filter by date). */
const MAX_POST_AGE_DAYS = 30;

/** Skip LLM for posts with too little content (cost protection per PRD). */
const MIN_CONTENT_LENGTH = 20;

/**
 * If input looks like a URL, return a short product/domain hint for keyword generation.
 * Avoids sending long UTM URLs to the AI so we get useful Reddit search phrases.
 */
function normalizeUserInputForKeywords(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    if (url.hostname && url.hostname !== "localhost") {
      const domain = url.hostname.replace(/^www\./i, "");
      return domain;
    }
  } catch {
    // not a URL, use as-is
  }
  return trimmed;
}

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
  const keywordInput = normalizeUserInputForKeywords(userInput);
  const keywords = await getKeywordsForInput(keywordInput, keywordCount);
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
          const { comments, postScore, numComments } = await fetchComments(post.subreddit, post.id, { delayMs });
          post.comments = comments;
          if (postScore != null) post.score = postScore;
          if (numComments != null) post.num_comments = numComments;
          if (postScore == null && numComments == null) {
            const fallback = await fetchPostEngagement(post.subreddit, post.id, { delayMs: 0 });
            if (fallback.postScore != null) post.score = fallback.postScore;
            if (fallback.numComments != null) post.num_comments = fallback.numComments;
          }
          if (post.score == null && post.num_comments == null && post.full_link) {
            const fromLink = await fetchPostEngagementFromLink(post.full_link, { delayMs: 0 });
            if (fromLink.postScore != null) post.score = fromLink.postScore;
            if (fromLink.numComments != null) post.num_comments = fromLink.numComments;
          }
        } catch {
          post.comments = [];
          try {
            const fallback = await fetchPostEngagement(post.subreddit, post.id, { delayMs });
            if (fallback.postScore != null) post.score = fallback.postScore;
            if (fallback.numComments != null) post.num_comments = fallback.numComments;
          } catch {
            /* keep search listing values */
          }
          if ((post.score == null || post.num_comments == null) && post.full_link) {
            try {
              const fromLink = await fetchPostEngagementFromLink(post.full_link, { delayMs });
              if (fromLink.postScore != null) post.score = fromLink.postScore;
              if (fromLink.numComments != null) post.num_comments = fromLink.numComments;
            } catch {
              /* keep whatever we have */
            }
          }
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
