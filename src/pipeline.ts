/**
 * Full pipeline: validate input → AI search queries → Reddit search → dedup/filter → batch intent ranking → DB.
 */

import { randomUUID } from "node:crypto";
import { getKeywordsForInput } from "./ai-keywords.js";
import {
  classifyPostIntentBatch,
  classifyPostIntentBatchMini,
  LIGHTNING_MINI_CHUNK,
  scorePostsLightningMini,
  type BatchPostInput,
  type IntentLabel,
} from "./ai-intent.js";
import {
  insertRun,
  updateRunStatus,
  insertPost,
  insertPostIntent,
  attachRunToUser,
  updateRunKeywords,
  updateRunPipelinePhase,
  setRunPipelineError,
  setRunHomepageCandidateCount,
} from "./db/index.js";
import { RedditRateLimitedError, search, type RedditTimeFilter } from "./reddit-search.js";

/** Reddit listing `sort=` values used in this app for discovery. */
export type RedditListingSort = "new" | "relevance";
import { type SearchMode, getSearchModeRedditParams } from "./search-modes.js";
import { InvalidSearchInputError, validateUserInput } from "./input-validation.js";
import type { RedditPost } from "./types.js";
import {
  CRON_MAX_POST_AGE_DAYS,
  HOMEPAGE_MAX_POST_AGE_DAYS,
  POST_DISCOVERY_MAX_AGE_DAYS,
} from "./constants.js";

const DEFAULT_MAX_PAGES_PER_KEYWORD = 1;
/** Drop posts older than this many days (independent of Reddit `t=` window). */
const MAX_POST_AGE_DAYS = POST_DISCOVERY_MAX_AGE_DAYS;
/** Dashboard-only max post age override (keeps homepage/cron stricter). */
const DASHBOARD_MAX_POST_AGE_DAYS = 5;
const MIN_CONTENT_LENGTH = 20;
const INTENT_CONCURRENCY = 15;
const INTENT_BATCH_SIZE = 5;

/** Homepage/debug: funnel stats still report count above this threshold. */
const HOMEPAGE_MINI_SCORE_GT = 70;
/** Dashboard/cron mini gate before expensive gpt-4o full scoring. */
const DASHBOARD_MINI_GATE_MIN = 50;


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
  /** Which `sort=` queries returned this post (union across keywords). */
  matchedRedditSorts: RedditListingSort[];
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

function isPostWithinMaxAge(post: RedditPost, maxAgeDays: number = MAX_POST_AGE_DAYS): boolean {
  return getPostAgeDays(post) <= maxAgeDays;
}

function hasEnoughContentForIntent(post: RedditPost): boolean {
  const title = (post.title ?? "").trim();
  const body = (post.selftext ?? "").trim();
  return title.length >= 1 || body.length >= MIN_CONTENT_LENGTH;
}

async function searchWithDashboardCronRetry(
  term: string,
  opts: {
    maxPages: number;
    delayMs: number;
    sort: RedditListingSort;
    timeFilter: RedditTimeFilter;
    trafficMode: "dashboard" | "cron";
  }
): Promise<RedditPost[]> {
  try {
    return await search(term, {
      maxPages: opts.maxPages,
      delayMs: opts.delayMs,
      exactPhrase: false,
      sort: opts.sort,
      timeFilter: opts.timeFilter,
      trafficMode: opts.trafficMode,
    });
  } catch (err) {
    const retryWaitMs = Math.max(1500, Math.min(6000, Math.round(opts.delayMs * 0.8)));
    console.warn(
      JSON.stringify({
        event: "dashboard_cron_reddit_retry",
        mode: opts.trafficMode,
        term,
        sort: opts.sort,
        waitMs: retryWaitMs,
        reason: err instanceof Error ? err.message : String(err),
      })
    );
    await new Promise((r) => setTimeout(r, retryWaitMs));
    try {
      return await search(term, {
        maxPages: opts.maxPages,
        delayMs: opts.delayMs,
        exactPhrase: false,
        sort: opts.sort,
        timeFilter: opts.timeFilter,
        trafficMode: opts.trafficMode,
      });
    } catch (err2) {
      if (err2 instanceof RedditRateLimitedError) throw err2;
      throw err2;
    }
  }
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

export type { SearchMode } from "./search-modes.js";

export interface PipelineOptions {
  userInput: string;
  /** Optional extra context to be included in the LLM prompt (does not replace the stored `userInput`). */
  context?: string;
  maxPagesPerKeyword?: number;
  /** Overrides mode default (e.g. dashboard uses 2000 ms; cron uses 5000 ms). */
  delayMs?: number;
  /** Overrides mode default keyword count (homepage 3, dashboard 10, cron 10). */
  keywordCount?: number;
  /** Defaults to `dashboard` when omitted (CLI / scripts). */
  searchMode?: SearchMode;
  /** When set, run row is linked to this user immediately (dashboard async + progress polling). */
  attachUserId?: string;
}

/** Homepage-only: funnel for local debugging (also in API `timings.homepageFunnel`). */
export interface HomepageFunnelStats {
  /** Keyword strings sent to Reddit (from AI step). */
  keywords: string[];
  /** Reddit `search()` calls = keywords × sorts. */
  redditSearchCalls: number;
  /** Unique post ids after merging all fetches (before max-age / self-promo). */
  redditPostsExtractedUnique: number;
  /** Raw posts older than homepage max age ({@link HOMEPAGE_MAX_POST_AGE_DAYS}). */
  droppedTooOld: number;
  /** In-age posts dropped as likely self-promo vs input. */
  droppedSelfPromo: number;
  /** Survive age + self-promo (= UI “threads scanned” / `totalPosts`). */
  afterInitialFilters: number;
  /** Dropped as too thin for LLM (or dedupe) after initial filters. */
  thinOrDedupedDropped: number;
  /** Posts scored by mini (full intent). */
  scorableForLlm: number;
  /** How many mini scores were &gt; 70. */
  miniAbove70Count?: number;
  /** How many mini scores were &gt; 50 (4o qualification gate). */
  miniAbove50Count?: number;
  /** Sent to gpt-4o finalist batch (cap 5 among &gt;50). */
  finalistsFor4o?: number;
  topMiniScore?: number;
  /** Rows persisted (homepage: 0 or 1). */
  finalLeadsPersisted?: number;
  /** Winning post’s gpt-4o score when saved. */
  winner4oScore?: number | null;
  /** When `finalistCandidates` are passed to funnel builder: overlap-safe counts (a finalist can count toward both sorts). */
  finalistsRedditSort?: {
    finalistCount: number;
    withRelevance: number;
    withNew: number;
    withBothSorts: number;
  };
  finalistsRedditSortDetail?: Array<{ postId: string; sorts: RedditListingSort[] }>;
}

export interface PipelineTimings {
  searchMode: SearchMode;
  /** Reddit `t=` param used for listing fetches in this run. */
  redditTimeFilter: RedditTimeFilter;
  /** Sorts used per keyword (e.g. `new` only vs `new` + `relevance`). */
  redditSorts: Array<"new" | "relevance">;
  keywordsMs: number;
  redditMs: number;
  intentMs: number;
  totalMs: number;
  /** Reddit `search()` invocations (per keyword × sorts; each may paginate internally). */
  searchTaskCount: number;
  uniqueAfterDedupe: number;
  postsAfterFilters: number;
  scorableForLlm: number;
  intentBatches: number;
  homepageFunnel?: HomepageFunnelStats;
}

export interface PipelineResult {
  runId: string;
  keywords: string[];
  totalPosts: number;
  totalPostIntents: number;
  timings: PipelineTimings;
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

/** After per-keyword Reddit searches: use keyword + sort attribution from each fetch. */
function postsToRecentCandidatesPerKeyword(
  postById: Map<string, RedditPost>,
  idToKeywords: Map<string, Set<string>>,
  idToSorts: Map<string, Set<RedditListingSort>>,
  searchQueries: string[],
  userInput: string,
  sortsUsedInRun: RedditListingSort[],
  maxAgeDays: number = MAX_POST_AGE_DAYS
): CandidatePost[] {
  const kwList = searchQueries.map((k) => k.trim()).filter(Boolean);
  const sortFallback = [...sortsUsedInRun].sort();
  const out: CandidatePost[] = [];
  for (const [id, post] of postById) {
    if (!id) continue;
    if (!isPostWithinMaxAge(post, maxAgeDays)) continue;
    if (isLikelySelfPromotionalPost(post, userInput)) continue;
    const set = idToKeywords.get(id);
    const matchedKeywords = set && set.size > 0 ? Array.from(set) : kwList.slice();
    const sortSet = idToSorts.get(id);
    const matchedRedditSorts =
      sortSet && sortSet.size > 0 ? Array.from(sortSet).sort() : sortFallback;
    out.push({ post: { ...post, comments: [] }, matchedKeywords, matchedRedditSorts });
  }
  return dedupeCandidatePostsById(out);
}

function pickHomepageFourOWinner(
  candidates: CandidatePost[],
  fourResults: Awaited<ReturnType<typeof classifyPostIntentBatch>>
): number {
  let bestIdx = -1;
  let bestScore = -1;
  let bestCreated = -Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const r = fourResults[i];
    if (!r) continue;
    const s = clampScore(r.score);
    const cu =
      candidates[i].post.created_utc != null && Number.isFinite(Number(candidates[i].post.created_utc))
        ? Number(candidates[i].post.created_utc)
        : 0;
    if (s > bestScore || (s === bestScore && cu > bestCreated)) {
      bestScore = s;
      bestCreated = cu;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildHomepageFunnelStats(
  funnelKeywords: string[],
  redditSearchCalls: number,
  postById: Map<string, RedditPost>,
  userInput: string,
  recentCandidatesLen: number,
  scorableLen: number,
  maxPostAgeDays: number,
  extras?: {
    miniRanked?: Array<{ mini: number }>;
    finalistsFor4o?: number;
    /** Homepage: gpt-4o shortlist (for Reddit sort attribution in funnel). */
    finalistCandidates?: CandidatePost[];
    finalLeadsPersisted?: number;
    winner4oScore?: number | null;
  }
): HomepageFunnelStats {
  let droppedTooOld = 0;
  let droppedSelfPromo = 0;
  for (const [, post] of postById) {
    if (!isPostWithinMaxAge(post, maxPostAgeDays)) {
      droppedTooOld++;
      continue;
    }
    if (isLikelySelfPromotionalPost(post, userInput)) droppedSelfPromo++;
  }
  const out: HomepageFunnelStats = {
    keywords: [...funnelKeywords],
    redditSearchCalls,
    redditPostsExtractedUnique: postById.size,
    droppedTooOld,
    droppedSelfPromo,
    afterInitialFilters: recentCandidatesLen,
    thinOrDedupedDropped: Math.max(0, recentCandidatesLen - scorableLen),
    scorableForLlm: scorableLen,
  };
  if (extras?.miniRanked && extras.miniRanked.length > 0) {
    out.topMiniScore = extras.miniRanked[0]?.mini ?? 0;
    out.miniAbove70Count = extras.miniRanked.filter((x) => x.mini > HOMEPAGE_MINI_SCORE_GT).length;
    out.miniAbove50Count = extras.miniRanked.filter((x) => x.mini > DASHBOARD_MINI_GATE_MIN).length;
  }
  if (extras?.finalistsFor4o != null) out.finalistsFor4o = extras.finalistsFor4o;
  if (extras?.finalLeadsPersisted != null) out.finalLeadsPersisted = extras.finalLeadsPersisted;
  if (extras?.winner4oScore !== undefined) out.winner4oScore = extras.winner4oScore;

  const finalists = extras?.finalistCandidates;
  if (finalists && finalists.length > 0) {
    let withRelevance = 0;
    let withNew = 0;
    let withBothSorts = 0;
    const finalistsRedditSortDetail: Array<{ postId: string; sorts: RedditListingSort[] }> = [];
    for (const c of finalists) {
      const sorts = [...c.matchedRedditSorts].sort();
      const s = new Set(sorts);
      if (s.has("relevance")) withRelevance++;
      if (s.has("new")) withNew++;
      if (s.has("relevance") && s.has("new")) withBothSorts++;
      finalistsRedditSortDetail.push({ postId: (c.post.id ?? "").trim(), sorts });
    }
    out.finalistsRedditSort = {
      finalistCount: finalists.length,
      withRelevance,
      withNew,
      withBothSorts,
    };
    out.finalistsRedditSortDetail = finalistsRedditSortDetail;
  }

  return out;
}

function logHomepageRunDebug(runId: string, funnel: HomepageFunnelStats): void {
  console.log(JSON.stringify({ event: "homepage_run_debug", runId, ...funnel }));
}

/** Landing-only: Reddit per keyword × sorts (`relevance` only), t=week → mini intent → persist top 1. */
async function executeHomepageFastPipeline(params: {
  runId: string;
  userInput: string;
  searchQueries: string[];
  intentContext: string;
  pipelineT0: number;
  keywordsMs: number;
  maxPagesPerKeyword: number;
  delayMs: number;
  redditTimeFilter: RedditTimeFilter;
  redditSorts: Array<"new" | "relevance">;
  searchMode: SearchMode;
}): Promise<PipelineResult> {
  const {
    runId,
    userInput,
    searchQueries,
    intentContext,
    pipelineT0,
    keywordsMs,
    maxPagesPerKeyword,
    delayMs,
    redditTimeFilter,
    redditSorts,
    searchMode,
  } = params;

  const queries = searchQueries.map((k) => k.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new Error("No search keywords generated for Reddit.");
  }

  const redditT0 = performance.now();
  const perKwPages = Math.max(1, maxPagesPerKeyword);
  let redditSearchCalls = 0;
  const postById = new Map<string, RedditPost>();
  const idToKeywords = new Map<string, Set<string>>();
  const idToSorts = new Map<string, Set<RedditListingSort>>();

  for (const term of queries) {
    for (const sort of redditSorts) {
      const batch = await search(term, {
        maxPages: perKwPages,
        delayMs,
        exactPhrase: false,
        sort,
        timeFilter: redditTimeFilter,
        trafficMode: "homepage",
      });
      redditSearchCalls++;
      for (const p of batch) {
        const id = (p.id ?? "").trim();
        if (!id) continue;
        postById.set(id, p);
        if (!idToKeywords.has(id)) idToKeywords.set(id, new Set());
        idToKeywords.get(id)!.add(term);
        if (!idToSorts.has(id)) idToSorts.set(id, new Set());
        idToSorts.get(id)!.add(sort);
      }
    }
  }
  const redditMs = Math.round(performance.now() - redditT0);

  updateRunPipelinePhase(runId, "quality");
  const recentCandidates = postsToRecentCandidatesPerKeyword(
    postById,
    idToKeywords,
    idToSorts,
    searchQueries,
    userInput,
    redditSorts,
    HOMEPAGE_MAX_POST_AGE_DAYS
  );
  const uniqueAfterDedupe = postById.size;

  let scorableCandidates = recentCandidates.filter((c) => hasEnoughContentForIntent(c.post));
  scorableCandidates = dedupeCandidatePostsById(scorableCandidates);

  const intentT0 = performance.now();

  if (scorableCandidates.length === 0) {
    const intentMs = Math.round(performance.now() - intentT0);
    const totalMs = Math.round(performance.now() - pipelineT0);
    const homepageFunnel = buildHomepageFunnelStats(
      searchQueries,
      redditSearchCalls,
      postById,
      userInput,
      recentCandidates.length,
      0,
      HOMEPAGE_MAX_POST_AGE_DAYS,
      { finalLeadsPersisted: 0, winner4oScore: null }
    );
    const timings: PipelineTimings = {
      searchMode,
      redditTimeFilter,
      redditSorts: [...redditSorts],
      keywordsMs,
      redditMs,
      intentMs,
      totalMs,
      searchTaskCount: redditSearchCalls,
      uniqueAfterDedupe,
      postsAfterFilters: recentCandidates.length,
      scorableForLlm: 0,
      intentBatches: 0,
      homepageFunnel,
    };
    console.log(JSON.stringify({ event: "pipeline_timings", runId, ...timings }));
    logHomepageRunDebug(runId, homepageFunnel);
    setRunHomepageCandidateCount(runId, recentCandidates.length);
    markRunCompleted(runId);
    return {
      runId,
      keywords: searchQueries,
      totalPosts: recentCandidates.length,
      totalPostIntents: 0,
      timings,
    };
  }

  updateRunPipelinePhase(runId, "intent");
  const miniInputs: BatchPostInput[] = scorableCandidates.map((c) => ({
    id: c.post.id ?? "",
    title: (c.post.title ?? "").trim(),
    body: (c.post.selftext ?? "").trim(),
    score: c.post.score,
    num_comments: c.post.num_comments,
    created_utc: c.post.created_utc,
    matchedKeywords: c.matchedKeywords,
  }));

  const batches: CandidatePost[][] = [];
  for (let i = 0; i < scorableCandidates.length; i += INTENT_BATCH_SIZE) {
    batches.push(scorableCandidates.slice(i, i + INTENT_BATCH_SIZE));
  }
  const miniRanked: Array<{
    candidate: CandidatePost;
    mini: number;
    explanation: string | null;
    suggestedReply: string | null;
  }> = [];
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
      const results = await classifyPostIntentBatchMini(intentContext, posts);
      for (let i = 0; i < batch.length; i++) {
        const candidate = batch[i];
        const intent = results[i];
        miniRanked.push({
          candidate,
          mini: clampScore(intent?.score ?? 0),
          explanation: intent?.explanation ?? null,
          suggestedReply: intent?.suggested_reply ?? null,
        });
      }
    } catch (err) {
      console.warn("Homepage mini-full batch failed:", err instanceof Error ? err.message : err);
      for (const candidate of batch) {
        miniRanked.push({ candidate, mini: 0, explanation: null, suggestedReply: null });
      }
    }
  });
  miniRanked.sort((a, b) => b.mini - a.mini);
  const winnerPair = miniRanked[0] ?? null;
  const intentMs = Math.round(performance.now() - intentT0);
  const totalMs = Math.round(performance.now() - pipelineT0);

  if (!winnerPair) {
    const homepageFunnel = buildHomepageFunnelStats(
      searchQueries,
      redditSearchCalls,
      postById,
      userInput,
      recentCandidates.length,
      scorableCandidates.length,
      HOMEPAGE_MAX_POST_AGE_DAYS,
      {
        miniRanked,
        finalistsFor4o: 0,
        finalLeadsPersisted: 0,
        winner4oScore: null,
      }
    );
    const timings: PipelineTimings = {
      searchMode,
      redditTimeFilter,
      redditSorts: [...redditSorts],
      keywordsMs,
      redditMs,
      intentMs,
      totalMs,
      searchTaskCount: redditSearchCalls,
      uniqueAfterDedupe,
      postsAfterFilters: recentCandidates.length,
      scorableForLlm: scorableCandidates.length,
      intentBatches: batches.length,
      homepageFunnel,
    };
    console.log(JSON.stringify({ event: "pipeline_timings", runId, ...timings }));
    logHomepageRunDebug(runId, homepageFunnel);
    setRunHomepageCandidateCount(runId, recentCandidates.length);
    markRunCompleted(runId);
    return {
      runId,
      keywords: searchQueries,
      totalPosts: recentCandidates.length,
      totalPostIntents: 0,
      timings,
    };
  }

  const winner = winnerPair.candidate;
  const finalScore = clampScore(winnerPair.mini);
  const finalized = finalizeIntent(
    finalScore,
    winnerPair.explanation ?? "Ranked highest by full-intent mini scoring for this query.",
    winnerPair.suggestedReply ?? null
  );
  const rowId = postRowId(runId, winner.post.id);

  insertPost(runId, { ...winner.post, comments: [] }, winner.matchedKeywords);
  insertPostIntent(
    rowId,
    finalized.label,
    finalized.score,
    finalized.explanation,
    finalized.suggested_reply,
    finalized.is_high_intent
  );

  const homepageFunnel = buildHomepageFunnelStats(
    searchQueries,
    redditSearchCalls,
    postById,
    userInput,
    recentCandidates.length,
    scorableCandidates.length,
    HOMEPAGE_MAX_POST_AGE_DAYS,
    {
      miniRanked,
      finalistsFor4o: 1,
      finalistCandidates: [winner],
      finalLeadsPersisted: 1,
      winner4oScore: finalScore,
    }
  );
  const timings: PipelineTimings = {
    searchMode,
    redditTimeFilter,
    redditSorts: [...redditSorts],
    keywordsMs,
    redditMs,
    intentMs,
    totalMs,
    searchTaskCount: redditSearchCalls,
    uniqueAfterDedupe,
    postsAfterFilters: recentCandidates.length,
    scorableForLlm: scorableCandidates.length,
    intentBatches: batches.length,
    homepageFunnel,
  };
  console.log(JSON.stringify({ event: "pipeline_timings", runId, ...timings }));
  logHomepageRunDebug(runId, homepageFunnel);
  setRunHomepageCandidateCount(runId, recentCandidates.length);
  markRunCompleted(runId);
  return {
    runId,
    keywords: searchQueries,
    totalPosts: recentCandidates.length,
    totalPostIntents: 1,
    timings,
  };
}

function markRunCompleted(runId: string): void {
  setRunPipelineError(runId, null);
  updateRunPipelinePhase(runId, null);
  updateRunStatus(runId, "completed");
}

function markRunFailed(runId: string, err: unknown): void {
  setRunPipelineError(runId, err instanceof Error ? err.message : String(err));
  updateRunPipelinePhase(runId, null);
  updateRunStatus(runId, "failed");
}

/** Creates run row + optional user link + phase `mapping`. Caller then runs {@link runPipelineFromRunId}. */
export async function prepareRunRow(options: PipelineOptions): Promise<string> {
  await validateUserInput(options.userInput);
  const runId = randomUUID();
  const ctx = typeof options.context === "string" ? options.context.trim() : "";
  const source =
    options.searchMode === "homepage"
      ? "homepage"
      : options.searchMode === "cron"
        ? "cron"
        : "dashboard";
  insertRun(runId, options.userInput, [], ctx || undefined, "running", source);
  if (options.attachUserId) {
    attachRunToUser(runId, options.attachUserId);
  }
  updateRunPipelinePhase(runId, "mapping");
  return runId;
}

export async function runPipelineFromRunId(
  runId: string,
  options: PipelineOptions,
  pipelineT0: number
): Promise<PipelineResult> {
  const { userInput, context, searchMode = "dashboard" } = options;
  const modeParams = getSearchModeRedditParams(searchMode);
  const keywordCount = options.keywordCount ?? modeParams.keywordCount;
  const delayMs = options.delayMs ?? modeParams.delayMs;
  const maxPagesPerKeyword = options.maxPagesPerKeyword ?? DEFAULT_MAX_PAGES_PER_KEYWORD;
  const redditSorts = modeParams.redditSorts;
  const redditTimeFilter = modeParams.redditTimeFilter;

  const trimmedContext = typeof context === "string" ? context.trim() : "";
  const llmUserInput = trimmedContext
    ? `${userInput}\n\nAdditional context:\n${trimmedContext}`
    : userInput;

  const { keywords: searchQueries, whatProductDoes, whatProblemItSolves } =
    await getKeywordsForInput(llmUserInput, keywordCount);
  const keywordsMs = Math.round(performance.now() - pipelineT0);

  updateRunKeywords(runId, searchQueries);

  if (searchMode === "homepage") {
    console.log(
      JSON.stringify({
        event: "homepage_keywords_ready",
        runId,
        keywords: searchQueries,
        redditSorts,
        redditTimeFilter,
        maxPostAgeDays: HOMEPAGE_MAX_POST_AGE_DAYS,
      })
    );
  }

  const hasStructuredIntentFields =
    Boolean(whatProductDoes?.trim()) ||
    Boolean(whatProblemItSolves?.trim());
  const lineOrNotSpecified = (s: string | undefined) =>
    s?.trim() ? s.trim() : "(not specified)";
  const baseContext = hasStructuredIntentFields
    ? `What the product does:\n${lineOrNotSpecified(whatProductDoes)}\n\nWhat problem it solves:\n${lineOrNotSpecified(whatProblemItSolves)}`
    : llmUserInput;

  let intentContext = baseContext;
  if (trimmedContext) {
    intentContext += `\n\nAdditional user context (preferences, exclusions, constraints):\n${trimmedContext}`;
  }

  try {
    const queries = searchQueries.map((k) => k.trim()).filter(Boolean);
    if (queries.length === 0) {
      throw new Error("No search keywords generated for Reddit.");
    }

    if (searchMode === "homepage") {
      updateRunPipelinePhase(runId, "collecting");
      return await executeHomepageFastPipeline({
        runId,
        userInput,
        searchQueries,
        intentContext,
        pipelineT0,
        keywordsMs,
        maxPagesPerKeyword,
        delayMs,
        redditTimeFilter,
        redditSorts,
        searchMode,
      });
    }

    updateRunPipelinePhase(runId, "collecting");
    const redditT0 = performance.now();
    let redditSearchCalls = 0;
    const postById = new Map<string, RedditPost>();
    const idToKeywords = new Map<string, Set<string>>();
    const idToSorts = new Map<string, Set<RedditListingSort>>();
    const perKwPages = Math.max(1, maxPagesPerKeyword);

    for (const term of queries) {
      for (const sort of redditSorts) {
        const trafficMode = searchMode === "cron" ? "cron" : "dashboard";
        const batch = await searchWithDashboardCronRetry(term, {
          maxPages: perKwPages,
          delayMs,
          sort,
          timeFilter: redditTimeFilter,
          trafficMode,
        });
        redditSearchCalls++;
        for (const p of batch) {
          const id = (p.id ?? "").trim();
          if (!id) continue;
          postById.set(id, p);
          if (!idToKeywords.has(id)) idToKeywords.set(id, new Set());
          idToKeywords.get(id)!.add(term);
          if (!idToSorts.has(id)) idToSorts.set(id, new Set());
          idToSorts.get(id)!.add(sort);
        }
      }
    }

    const redditMs = Math.round(performance.now() - redditT0);
    updateRunPipelinePhase(runId, "quality");
    const maxPostAgeDays = searchMode === "cron" ? CRON_MAX_POST_AGE_DAYS : DASHBOARD_MAX_POST_AGE_DAYS;
    const recentCandidates = postsToRecentCandidatesPerKeyword(
      postById,
      idToKeywords,
      idToSorts,
      searchQueries,
      userInput,
      redditSorts,
      maxPostAgeDays
    );
    const uniqueAfterDedupe = postById.size;

    for (const candidate of recentCandidates) {
      insertPost(runId, candidate.post, candidate.matchedKeywords);
    }

    let scorableCandidates = recentCandidates.filter((c) => hasEnoughContentForIntent(c.post));
    scorableCandidates = dedupeCandidatePostsById(scorableCandidates);

    const miniInputs: BatchPostInput[] = scorableCandidates.map((c) => ({
      id: c.post.id ?? "",
      title: (c.post.title ?? "").trim(),
      body: (c.post.selftext ?? "").trim(),
      score: c.post.score,
      num_comments: c.post.num_comments,
      created_utc: c.post.created_utc,
      matchedKeywords: c.matchedKeywords,
    }));
    const miniScores = await scorePostsLightningMini(intentContext, miniInputs);
    const passers = scorableCandidates.filter((c) => {
      const id = (c.post.id ?? "").trim();
      return (miniScores.get(id) ?? 0) > DASHBOARD_MINI_GATE_MIN;
    });

    const batches: CandidatePost[][] = [];
    for (let i = 0; i < passers.length; i += INTENT_BATCH_SIZE) {
      batches.push(passers.slice(i, i + INTENT_BATCH_SIZE));
    }

    const rankedCandidates: RankedCandidate[] = [];

    updateRunPipelinePhase(runId, "intent");
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
          if (!intent) continue;
          const rowId = postRowId(runId, candidate.post.id);
          const finalScore = clampScore(intent.score);
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
        }
      } catch (err) {
        console.warn("Batch intent skipped:", err instanceof Error ? err.message : err);
      }
    });
    const intentMs = Math.round(performance.now() - intentT0);
    const totalMs = Math.round(performance.now() - pipelineT0);

    const timings: PipelineTimings = {
      searchMode,
      redditTimeFilter,
      redditSorts: [...redditSorts],
      keywordsMs,
      redditMs,
      intentMs,
      totalMs,
      searchTaskCount: redditSearchCalls,
      uniqueAfterDedupe,
      postsAfterFilters: recentCandidates.length,
      scorableForLlm: passers.length,
      intentBatches: Math.ceil(miniInputs.length / LIGHTNING_MINI_CHUNK) + batches.length,
    };

    console.log(JSON.stringify({ event: "pipeline_timings", runId, ...timings }));

    markRunCompleted(runId);
    return {
      runId,
      keywords: searchQueries,
      totalPosts: recentCandidates.length,
      totalPostIntents: rankedCandidates.length,
      timings,
    };
  } catch (err) {
    markRunFailed(runId, err);
    if (err instanceof InvalidSearchInputError) throw err;
    throw err;
  }
}

/** Full pipeline (homepage, cron, CLI): creates run row then runs keyword → Reddit → filters → intent. */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const pipelineT0 = performance.now();
  const runId = await prepareRunRow(options);
  return runPipelineFromRunId(runId, options, pipelineT0);
}
