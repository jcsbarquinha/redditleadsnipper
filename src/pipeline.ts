/**
 * Full pipeline: validate input → AI search queries → Reddit search → dedup/filter → batch intent ranking → DB.
 */

import { randomUUID } from "node:crypto";
import { getKeywordsForInput, DEFAULT_KEYWORD_COUNT } from "./ai-keywords.js";
import { classifyPostIntentBatch, type IntentLabel } from "./ai-intent.js";
import {
  insertRun,
  updateRunStatus,
  insertPost,
  insertPostIntent,
} from "./db/index.js";
import { search } from "./reddit-search.js";
import { InvalidSearchInputError, validateUserInput } from "./input-validation.js";
import type { RedditPost } from "./types.js";

const DEFAULT_MAX_PAGES_PER_KEYWORD = 1;
const DEFAULT_DELAY_MS = 500;
/** Align with Reddit `t=week` (~7 days). */
const MAX_POST_AGE_DAYS = 7;
const MIN_CONTENT_LENGTH = 20;
const SEARCH_KEYWORD_CONCURRENCY = 3;
const INTENT_CONCURRENCY = 10;
const INTENT_BATCH_SIZE = 2;
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
  // Recency should be a *small* boost only.
  // The primary signal must remain the AI intent score (seeking-ness).
  const recencyStrength = 5; // max points added by recency (keep AI dominant)
  const recencyPoints = Number.isFinite(ageDays)
    ? Math.round(((MAX_POST_AGE_DAYS - ageDays) / MAX_POST_AGE_DAYS) * recencyStrength)
    : 0;
  return clampScore(rawScore + recencyPoints);
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
  /** Optional extra context to be included in the LLM prompt (does not replace the stored `userInput`). */
  context?: string;
  maxPagesPerKeyword?: number;
  delayMs?: number;
  keywordCount?: number;
}

export interface PipelineResult {
  runId: string;
  keywords: string[];
  totalPosts: number;
  totalPostIntents: number;
}

/** Extra safety: one row per reddit post id before DB + LLM (avoids duplicate LLM calls). */
function dedupeCandidatePostsById(candidates: CandidatePost[]): CandidatePost[] {
  const seen = new Set<string>();
  const out: CandidatePost[] = [];
  for (const c of candidates) {
    const id = (c.post.id ?? "").trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
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
    context,
    maxPagesPerKeyword = DEFAULT_MAX_PAGES_PER_KEYWORD,
    delayMs = DEFAULT_DELAY_MS,
    keywordCount = DEFAULT_KEYWORD_COUNT,
  } = options;

  await validateUserInput(userInput);

  const trimmedContext = typeof context === "string" ? context.trim() : "";
  const llmUserInput = trimmedContext
    ? `${userInput}\n\nAdditional context:\n${trimmedContext}`
    : userInput;

  const runId = randomUUID();
  const pipelineT0 = performance.now();

  const { keywords: searchQueries, productSummary, whatProductDoes, whatProblemItSolves, targetUser } = await getKeywordsForInput(
    llmUserInput,
    keywordCount
  );
  const keywordsMs = Math.round(performance.now() - pipelineT0);
  const baseContext =
    whatProductDoes && whatProblemItSolves
      ? `What the product does:\n${whatProductDoes}\n\nWhat problem it solves:\n${whatProblemItSolves}`
      : productSummary && productSummary.trim()
        ? productSummary.trim()
        : llmUserInput;

  const intentContext = targetUser
    ? `${baseContext}\n\nTarget user:\n${targetUser}`
    : `${baseContext}\n\nTarget user:\n(not specified)`;
  insertRun(runId, userInput, searchQueries, context, "running");

  try {
    const SORT_MODES: Array<"new" | "relevance" | "hot"> = ["new", "relevance", "hot"];
    const searchTasks = searchQueries.flatMap((query) =>
      SORT_MODES.map((sort) => ({ query, sort }))
    );

    const redditT0 = performance.now();
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
          timeFilter: "week",
        }),
      })
    );
    const redditMs = Math.round(performance.now() - redditT0);

    const uniquePosts = dedupePosts(keywordResults);
    let recentCandidates: CandidatePost[] = dedupeCandidatePostsById(
      [...uniquePosts.values()]
        .filter(({ post }) => isPostWithinMaxAge(post))
        .filter(({ post }) => !isLikelySelfPromotionalPost(post, userInput))
        .map(({ post, matchedKeywords }) => ({
          post: { ...post, comments: [] },
          matchedKeywords,
        }))
    );

    for (const candidate of recentCandidates) {
      insertPost(runId, candidate.post, candidate.matchedKeywords);
    }

    let scorableCandidates = recentCandidates.filter((c) => hasEnoughContentForIntent(c.post));
    scorableCandidates = dedupeCandidatePostsById(scorableCandidates);
    const thinCandidates = recentCandidates.filter((c) => !hasEnoughContentForIntent(c.post));

    for (const candidate of thinCandidates) {
      const rowId = postRowId(runId, candidate.post.id);
      const fallback = finalizeIntent(0, "Post is too thin to show a clear buying signal.", null);
      insertPostIntent(rowId, fallback.label, fallback.score, fallback.explanation, fallback.suggested_reply, fallback.is_high_intent);
    }

    const batches: CandidatePost[][] = [];
    for (let i = 0; i < scorableCandidates.length; i += INTENT_BATCH_SIZE) {
      batches.push(scorableCandidates.slice(i, i + INTENT_BATCH_SIZE));
    }

    const rankedCandidates: RankedCandidate[] = [];

    const intentT0 = performance.now();
    await mapWithConcurrency(batches, INTENT_CONCURRENCY, async (batch) => {
      const posts = batch.map((c) => ({
        id: c.post.id ?? "",
        title: (c.post.title ?? "").trim(),
        body: (c.post.selftext ?? "").trim(),
        score: c.post.score,
        num_comments: c.post.num_comments,
        created_utc: c.post.created_utc,
        matchedKeywords: c.matchedKeywords,
      }));

      try {
        const results = await classifyPostIntentBatch(intentContext, posts);

        for (let i = 0; i < batch.length; i++) {
          const candidate = batch[i];
          const intent = results[i];
          const rowId = postRowId(runId, candidate.post.id);

          if (intent) {
            const finalScore = applyFinalScoreAdjustments(intent.score, candidate.post);
            const finalized = finalizeIntent(finalScore, intent.explanation, intent.suggested_reply);
            insertPostIntent(rowId, finalized.label, finalized.score, finalized.explanation, finalized.suggested_reply, finalized.is_high_intent);
            rankedCandidates.push({
              ...candidate,
              baseIntentScore: intent.score,
              finalScore: finalized.score,
              label: finalized.label,
              isHighIntent: finalized.is_high_intent,
              explanation: finalized.explanation,
              suggestedReply: finalized.suggested_reply,
            });
          } else {
            const fallback = finalizeIntent(clampScore(40), "Relevant recent post; batch scoring unavailable.", null);
            insertPostIntent(rowId, fallback.label, fallback.score, fallback.explanation, fallback.suggested_reply, fallback.is_high_intent);
            rankedCandidates.push({
              ...candidate,
              baseIntentScore: 40,
              finalScore: 40,
              label: fallback.label,
              isHighIntent: fallback.is_high_intent,
              explanation: fallback.explanation,
              suggestedReply: null,
            });
          }
        }
      } catch (err) {
        console.warn("Batch intent fallback:", err instanceof Error ? err.message : err);
        for (const candidate of batch) {
          const rowId = postRowId(runId, candidate.post.id);
          const fallback = finalizeIntent(clampScore(40), "Relevant recent post; batch scoring unavailable.", null);
          insertPostIntent(rowId, fallback.label, fallback.score, fallback.explanation, fallback.suggested_reply, fallback.is_high_intent);
          rankedCandidates.push({
            ...candidate,
            baseIntentScore: 40,
            finalScore: 40,
            label: fallback.label,
            isHighIntent: fallback.is_high_intent,
            explanation: fallback.explanation,
            suggestedReply: null,
          });
        }
      }
    });
    const intentMs = Math.round(performance.now() - intentT0);
    const totalMs = Math.round(performance.now() - pipelineT0);

    console.log(
      JSON.stringify({
        event: "pipeline_timings",
        runId,
        keywordsMs,
        redditMs,
        intentMs,
        totalMs,
        searchTaskCount: searchTasks.length,
        uniqueAfterDedupe: uniquePosts.size,
        postsAfterFilters: recentCandidates.length,
        scorableForLlm: scorableCandidates.length,
        intentBatches: batches.length,
      })
    );

    updateRunStatus(runId, "completed");
    return {
      runId,
      keywords: searchQueries,
      totalPosts: recentCandidates.length,
      totalPostIntents: rankedCandidates.length,
    };
  } catch (err) {
    updateRunStatus(runId, "failed");
    if (err instanceof InvalidSearchInputError) throw err;
    throw err;
  }
}
