/**
 * Full pipeline: validate input → AI keywords → Reddit search → shortlist → post-centric ranking → top-post comment enrichment → DB.
 */

import { randomUUID } from "node:crypto";
import { getKeywordsForInput, DEFAULT_KEYWORD_COUNT } from "./ai-keywords.js";
import { classifyPostIntent, explainPostWithComments, type IntentLabel } from "./ai-intent.js";
import {
  insertRun,
  updateRunStatus,
  insertPost,
  insertComments,
  insertPostIntent,
  updatePostEngagement,
} from "./db/index.js";
import { search } from "./reddit-search.js";
import { fetchComments } from "./reddit-comments.js";
import { InvalidSearchInputError, validateUserInput } from "./input-validation.js";
import type { RedditPost } from "./types.js";

const DEFAULT_MAX_PAGES_PER_KEYWORD = 10;
const DEFAULT_DELAY_MS = 500;
const MAX_POST_AGE_DAYS = 30;
const MIN_CONTENT_LENGTH = 20;
const SEARCH_KEYWORD_CONCURRENCY = 2;
const INTENT_CONCURRENCY = 4;
const COMMENT_ENRICHMENT_CONCURRENCY = 2;
const MAX_AI_RANKED_POSTS = 80;
const TOP_POST_COMMENT_ENRICHMENT_COUNT = 10;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
  "how",
  "what",
  "into",
  "tool",
  "service",
]);

interface CandidatePost {
  post: RedditPost;
  matchedKeywords: string[];
  shortlistScore: number;
}

interface RankedCandidate extends CandidatePost {
  baseIntentScore: number;
  finalScore: number;
  label: IntentLabel;
  isHighIntent: boolean;
  explanation: string | null;
  suggestedReply: string | null;
}

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

function postRowId(runId: string, redditId: string | null): string {
  return `${runId}_${redditId ?? ""}`;
}

function clampScore(score: number): number {
  if (score < 0) return 0;
  if (score > 100) return 100;
  return Math.round(score);
}

function scoreToLabel(score: number): IntentLabel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function isHighIntent(score: number): boolean {
  return score > 70;
}

function getPostAgeDays(post: RedditPost): number {
  if (post.created_utc == null || typeof post.created_utc !== "number") return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(Date.now() / 1000 - post.created_utc) / 86400);
}

function isPostWithinMaxAge(post: RedditPost): boolean {
  return getPostAgeDays(post) <= MAX_POST_AGE_DAYS;
}

function hasEnoughContentForIntent(post: RedditPost): boolean {
  const title = (post.title ?? "").trim();
  const body = (post.selftext ?? "").trim();
  return title.length >= 1 || body.length >= MIN_CONTENT_LENGTH;
}

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  )];
}

function computeShortlistScore(post: RedditPost, matchedKeywords: string[], userInput: string): number {
  const title = (post.title ?? "").toLowerCase();
  const body = (post.selftext ?? "").toLowerCase();
  const haystack = `${title} ${body}`.trim();
  const normalizedInput = userInput.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").trim();
  const userTerms = tokenize(userInput);
  const exactPhraseBoost = normalizedInput && haystack.includes(normalizedInput) ? 20 : 0;
  const termMatchCount = userTerms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
  const termBoost = Math.min(24, termMatchCount * 6);
  const keywordBoost = Math.min(18, matchedKeywords.length * 6);
  const contentBoost = Math.min(15, ((post.title ?? "").length / 16) + ((post.selftext ?? "").length / 140));
  const ageDays = getPostAgeDays(post);
  const recencyBoost = Number.isFinite(ageDays) ? Math.max(0, 30 - ageDays) : 0;
  const votes = Math.max(0, post.score ?? 0);
  const numComments = Math.max(0, post.num_comments ?? 0);
  const engagementBoost = Math.min(12, Math.log1p(votes) * 1.5 + Math.log1p(numComments) * 2.7);
  return exactPhraseBoost + termBoost + keywordBoost + contentBoost + recencyBoost + engagementBoost;
}

function applyFinalScoreAdjustments(rawScore: number, post: RedditPost): number {
  const ageDays = Math.min(MAX_POST_AGE_DAYS, getPostAgeDays(post));
  const recencyMultiplier = Number.isFinite(ageDays) ? 1.18 - ageDays * 0.012 : 0.82;
  const votes = Math.max(0, post.score ?? 0);
  const numComments = Math.max(0, post.num_comments ?? 0);
  const engagementBonus = Math.min(8, Math.log1p(numComments) * 2.2 + Math.log1p(votes) * 0.8);
  return clampScore(rawScore * recencyMultiplier + engagementBonus);
}

function finalizeIntent(score: number, explanation: string | null, suggestedReply: string | null) {
  return {
    score,
    label: scoreToLabel(score),
    is_high_intent: isHighIntent(score),
    explanation,
    suggested_reply: suggestedReply,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export interface PipelineOptions {
  userInput: string;
  includeComments?: boolean;
  maxPagesPerKeyword?: number;
  delayMs?: number;
  keywordCount?: number;
}

export interface PipelineResult {
  runId: string;
  keywords: string[];
  totalPosts: number;
  totalComments: number;
  totalPostIntents: number;
}

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
        if (!existing.matchedKeywords.includes(keyword)) existing.matchedKeywords.push(keyword);
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

  await validateUserInput(userInput);

  const runId = randomUUID();
  const keywordInput = normalizeUserInputForKeywords(userInput);
  const keywords = await getKeywordsForInput(keywordInput, keywordCount);
  insertRun(runId, userInput, keywords, "running");

  try {
    const keywordResults = await mapWithConcurrency(
      keywords,
      SEARCH_KEYWORD_CONCURRENCY,
      async (keyword) => ({
        keyword,
        posts: await search(keyword, {
          maxPages: maxPagesPerKeyword,
          delayMs,
          exactPhrase: true,
        }),
      })
    );

    const uniquePosts = dedupePosts(keywordResults);
    const recentCandidates: CandidatePost[] = [...uniquePosts.values()]
      .filter(({ post }) => isPostWithinMaxAge(post))
      .map(({ post, matchedKeywords }) => ({
        post: { ...post, comments: [] },
        matchedKeywords,
        shortlistScore: computeShortlistScore(post, matchedKeywords, userInput),
      }));

    for (const candidate of recentCandidates) {
      insertPost(runId, candidate.post, candidate.matchedKeywords);
    }

    const shortlisted = recentCandidates
      .slice()
      .sort((a, b) => b.shortlistScore - a.shortlistScore)
      .slice(0, MAX_AI_RANKED_POSTS);

    const rankedCandidates = await mapWithConcurrency(
      shortlisted,
      INTENT_CONCURRENCY,
      async (candidate): Promise<RankedCandidate> => {
        const rowId = postRowId(runId, candidate.post.id);

        if (!hasEnoughContentForIntent(candidate.post)) {
          const fallback = finalizeIntent(0, "Post is too thin to show a clear buying signal.", null);
          insertPostIntent(
            rowId,
            fallback.label,
            fallback.score,
            fallback.explanation,
            fallback.suggested_reply,
            fallback.is_high_intent
          );
          return {
            ...candidate,
            baseIntentScore: 0,
            finalScore: 0,
            label: fallback.label,
            isHighIntent: fallback.is_high_intent,
            explanation: fallback.explanation,
            suggestedReply: null,
          };
        }

        try {
          const intent = await classifyPostIntent(
            userInput,
            candidate.post.title,
            candidate.post.selftext ?? "",
            candidate.post.score,
            candidate.post.num_comments,
            candidate.post.created_utc,
            candidate.matchedKeywords
          );
          const finalScore = applyFinalScoreAdjustments(intent.score, candidate.post);
          const finalized = finalizeIntent(finalScore, intent.explanation, intent.suggested_reply);
          insertPostIntent(
            rowId,
            finalized.label,
            finalized.score,
            finalized.explanation,
            finalized.suggested_reply,
            finalized.is_high_intent
          );
          return {
            ...candidate,
            baseIntentScore: intent.score,
            finalScore: finalized.score,
            label: finalized.label,
            isHighIntent: finalized.is_high_intent,
            explanation: finalized.explanation,
            suggestedReply: finalized.suggested_reply,
          };
        } catch (err) {
          console.warn(`Intent fallback (post ${rowId}):`, err instanceof Error ? err.message : err);
          const fallbackScore = clampScore(Math.min(60, candidate.shortlistScore));
          const fallback = finalizeIntent(
            fallbackScore,
            "Relevant recent post with a likely pain point; detailed AI ranking was unavailable.",
            null
          );
          insertPostIntent(
            rowId,
            fallback.label,
            fallback.score,
            fallback.explanation,
            fallback.suggested_reply,
            fallback.is_high_intent
          );
          return {
            ...candidate,
            baseIntentScore: fallback.score,
            finalScore: fallback.score,
            label: fallback.label,
            isHighIntent: fallback.is_high_intent,
            explanation: fallback.explanation,
            suggestedReply: null,
          };
        }
      }
    );

    let totalComments = 0;

    if (includeComments) {
      const topForEnrichment = rankedCandidates
        .slice()
        .sort((a, b) => b.finalScore - a.finalScore)
        .filter((candidate) => Boolean(candidate.post.subreddit && candidate.post.id))
        .slice(0, TOP_POST_COMMENT_ENRICHMENT_COUNT);

      await mapWithConcurrency(topForEnrichment, COMMENT_ENRICHMENT_CONCURRENCY, async (candidate) => {
        if (!candidate.post.subreddit || !candidate.post.id) return;
        const rowId = postRowId(runId, candidate.post.id);
        try {
          const { comments, postScore, numComments } = await fetchComments(candidate.post.subreddit, candidate.post.id, {
            delayMs,
          });
          candidate.post.comments = comments;
          if (postScore != null) candidate.post.score = postScore;
          if (numComments != null) candidate.post.num_comments = numComments;

          updatePostEngagement(rowId, candidate.post.score ?? null, candidate.post.num_comments ?? null);
          insertComments(runId, candidate.post, comments);
          totalComments += comments.length;

          const enrichedExplanation = comments.length > 0
            ? await explainPostWithComments(
              userInput,
              candidate.post.title,
              candidate.post.selftext ?? "",
              comments.map((comment) => comment.body ?? ""),
              candidate.post.created_utc
            )
            : candidate.explanation;

          const refreshedFinalScore = applyFinalScoreAdjustments(candidate.baseIntentScore, candidate.post);
          const finalized = finalizeIntent(
            refreshedFinalScore,
            enrichedExplanation ?? candidate.explanation,
            candidate.suggestedReply
          );
          candidate.finalScore = finalized.score;
          candidate.label = finalized.label;
          candidate.isHighIntent = finalized.is_high_intent;
          candidate.explanation = finalized.explanation;

          insertPostIntent(
            rowId,
            finalized.label,
            finalized.score,
            finalized.explanation,
            finalized.suggested_reply,
            finalized.is_high_intent
          );
        } catch (err) {
          console.warn(`Comment enrichment skip (post ${rowId}):`, err instanceof Error ? err.message : err);
        }
      });
    }

    updateRunStatus(runId, "completed");
    return {
      runId,
      keywords,
      totalPosts: recentCandidates.length,
      totalComments,
      totalPostIntents: rankedCandidates.length,
    };
  } catch (err) {
    updateRunStatus(runId, "failed");
    if (err instanceof InvalidSearchInputError) throw err;
    throw err;
  }
}
