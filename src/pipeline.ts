/**
 * Full pipeline: validate input → AI search queries → Reddit search → shortlist → post-centric ranking → top-post comment enrichment → DB.
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

const DEFAULT_MAX_PAGES_PER_KEYWORD = 1;
const DEFAULT_DELAY_MS = 500;
const MAX_POST_AGE_DAYS = 30;
const MIN_CONTENT_LENGTH = 20;
const SEARCH_KEYWORD_CONCURRENCY = 1;
const INTENT_CONCURRENCY = 10;
const COMMENT_ENRICHMENT_CONCURRENCY = 2;
const TOP_POST_COMMENT_ENRICHMENT_COUNT = 10;
const MAX_PAGES_PER_QUERY = 2;


const PROMO_CALL_TO_ACTION_PATTERN =
  /\b(find it here|check it out|try it|try this|sign up|signup|get started|learn more|visit|available here|here's my|here is my|our tool|our product|my tool|my product|i built|we built|i made|we made)\b/i;
const SELF_PROMO_IDENTITY_PATTERN =
  /\b(i built|we built|i made|we made|my tool|my product|our tool|our product|my startup|our startup|my app|our app)\b/i;
const PRODUCT_OWNER_PATTERN =
  /\b(i am the owner of|i'm the owner of|owner of|founder of|cofounder of|co-founder of|creator of|maker of|maintainer of|i'm building|i am building|we're building|we are building|i launched|we launched|i created|we created)\b/i;
/** Only exclude when post clearly shares author's own setup/tutorial, not "looking for" or "does X work with". */
const PRODUCT_USER_TUTORIAL_PATTERN =
  /\b(full breakdown|here's exactly how|heres exactly how|my setup|step by step|self hosted|self-hosted|how it works)\b/i;
const DISCOUNT_RESELLER_PATTERN =
  /\b(dm me|whatsapp|join my community|instant delivery|payment methods|discount|annual subscriptions|secure your slot|lifetime deal)\b/i;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/ig;
const MARKDOWN_LINK_PATTERN = /\[[^\]]+\]\((https?:\/\/|www\.)[^)]+\)/i;

interface CandidatePost {
  post: RedditPost;
  matchedKeywords: string[];
}

interface RankedCandidate extends CandidatePost {
  baseIntentScore: number;
  finalScore: number;
  label: IntentLabel;
  isHighIntent: boolean;
  explanation: string | null;
  suggestedReply: string | null;
}

function isLikelyUrlInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return Boolean(url.hostname && url.hostname.includes("."));
  } catch {
    return false;
  }
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

function normalizeDomain(input: string): string | null {
  const candidate = input.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate.startsWith("http://") || candidate.startsWith("https://") ? candidate : `https://${candidate}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function getInputBrandTokens(input: string): string[] {
  if (!isLikelyUrlInput(input)) return [];
  const domain = normalizeDomain(input);
  if (!domain) return [];
  return [...new Set(
    domain
      .split(".")
      .flatMap((part) => part.split("-"))
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 4 && !["www", "app", "com", "io", "ai", "co"].includes(part))
  )];
}

function isLikelySelfPromotionalPost(post: RedditPost, userInput: string): boolean {
  const title = (post.title ?? "").trim();
  const body = (post.selftext ?? "").trim();
  const combined = `${title}\n${body}`.trim();
  const combinedLower = combined.toLowerCase();
  if (!combined) return false;

  const markdownLink = MARKDOWN_LINK_PATTERN.test(body);
  const rawUrls = body.match(URL_PATTERN) ?? [];
  const hasExplicitLink = markdownLink || rawUrls.length > 0;
  const linkedDomains = [
    ...rawUrls.map((url) => normalizeDomain(url)),
    normalizeDomain(post.url ?? ""),
  ].filter((domain): domain is string => Boolean(domain));

  const mentionsLinkedBrand = linkedDomains.some((domain) => {
    const brand = domain.split(".")[0];
    return Boolean(brand && combinedLower.includes(brand.toLowerCase()));
  });
  const inputBrandTokens = getInputBrandTokens(userInput);
  const mentionsInputBrand = inputBrandTokens.some((token) => combinedLower.includes(token));

  if (PROMO_CALL_TO_ACTION_PATTERN.test(combined) && hasExplicitLink) return true;
  if (SELF_PROMO_IDENTITY_PATTERN.test(combined)) return true;
  if (PRODUCT_OWNER_PATTERN.test(combined)) return true;
  if (DISCOUNT_RESELLER_PATTERN.test(combined) && hasExplicitLink) return true;
  if (mentionsLinkedBrand && /(find it here|check it out|my tool|our tool|my product|our product|i built|we built)/i.test(combined) && hasExplicitLink) {
    return true;
  }
  if (mentionsInputBrand && PRODUCT_USER_TUTORIAL_PATTERN.test(combined)) return true;

  return false;
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
  const { keywords: searchQueries, productSummary } = await getKeywordsForInput(userInput, keywordCount);
  const productContext = (productSummary && productSummary.trim()) ? productSummary.trim() : userInput;
  insertRun(runId, userInput, searchQueries, "running");

  try {
    const SORT_MODES: Array<"new" | "relevance" | "hot"> = ["new", "relevance", "hot"];
    const searchTasks = searchQueries.flatMap((query) =>
      SORT_MODES.map((sort) => ({ query, sort }))
    );

    const keywordResults = await mapWithConcurrency(
      searchTasks,
      SEARCH_KEYWORD_CONCURRENCY,
      async ({ query, sort }) => ({
        keyword: query,
        posts: await search(query, {
          maxPages: Math.min(maxPagesPerKeyword, MAX_PAGES_PER_QUERY),
          delayMs,
          exactPhrase: false,
          sort,
        }),
      })
    );

    const uniquePosts = dedupePosts(keywordResults);
    let recentCandidates: CandidatePost[] = [...uniquePosts.values()]
      .filter(({ post }) => isPostWithinMaxAge(post))
      .filter(({ post }) => !isLikelySelfPromotionalPost(post, userInput))
      .map(({ post, matchedKeywords }) => ({
        post: { ...post, comments: [] },
        matchedKeywords,
      }));

    for (const candidate of recentCandidates) {
      insertPost(runId, candidate.post, candidate.matchedKeywords);
    }

    const rankedCandidates = await mapWithConcurrency(
      recentCandidates,
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
            productContext,
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
          const fallbackScore = clampScore(40);
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
              productContext,
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
      keywords: searchQueries,
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
