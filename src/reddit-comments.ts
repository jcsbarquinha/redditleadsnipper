/**
 * Reddit comments via .json URL workaround (no API key).
 * Fetches comment tree for a post and flattens to a list of comment objects.
 */

import type { RedditComment } from "./types.js";
import { BASE_URL, DEFAULT_DELAY_MS, RedditRateLimitedError } from "./reddit-search.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_RETRIES = 10;
const RETRY_BACKOFF_MS = 5000;
const MAX_RETRY_AFTER_MS = 120_000;

function headers(): HeadersInit {
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://www.reddit.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get("Retry-After");
  if (!raw) return null;
  const sec = Number(raw);
  if (!Number.isNaN(sec) && sec >= 0) return Math.min(sec * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
}

async function request<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(30_000),
      });
      const isRateOrBlock = res.status === 429 || res.status === 503 || res.status === 403;
      if (isRateOrBlock && attempt < MAX_RETRIES - 1) {
        const retryAfter = res.status === 429 ? parseRetryAfterMs(res) : null;
        const backoff = retryAfter ?? RETRY_BACKOFF_MS * (attempt + 1);
        await delay(backoff);
        continue;
      }
      if (res.status === 429) {
        throw new RedditRateLimitedError();
      }
      if (!res.ok) {
        const body = await res.text();
        const msg = body ? `${res.statusText}: ${body.slice(0, 200)}` : res.statusText;
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof RedditRateLimitedError) throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      await delay(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  throw new Error("Unexpected retry exit");
}

interface CommentNode {
  kind?: string;
  data?: {
    body?: string;
    author?: string;
    score?: number;
    created_utc?: number;
    id?: string;
    replies?: unknown;
  };
}

function extractComment(node: CommentNode): RedditComment | null {
  if (node?.kind !== "t1") return null;
  const d = node.data ?? {};
  return {
    id: d.id ?? null,
    body: d.body ?? "",
    author: d.author ?? null,
    score: d.score ?? null,
    created_utc: d.created_utc ?? null,
  };
}

function walkReplies(children: CommentNode[] | undefined, out: RedditComment[]): void {
  if (!children) return;
  for (const child of children) {
    if (child?.kind === "t1") {
      const c = extractComment(child);
      if (c) out.push(c);
      const repliesData = child.data?.replies;
      if (repliesData && typeof repliesData === "object" && !Array.isArray(repliesData)) {
        const listing = (repliesData as { data?: { children?: CommentNode[] } }).data ?? {};
        walkReplies(listing.children, out);
      } else if (Array.isArray(repliesData)) {
        walkReplies(repliesData as CommentNode[], out);
      }
    }
  }
}

export interface FetchCommentsOptions {
  slug?: string;
  delayMs?: number;
}

export interface FetchCommentsResult {
  comments: RedditComment[];
  /** Live post score from the post's page (use when present). */
  postScore: number | null;
  /** Live comment count from the post's page (use when present). */
  numComments: number | null;
}

/**
 * Fetch all comments for a post. Returns comments plus live post score/num_comments from the post page.
 * Uses short post id (strips t3_ prefix) for the URL so Reddit accepts it.
 */
export async function fetchComments(
  subreddit: string,
  postId: string,
  options: FetchCommentsOptions = {}
): Promise<FetchCommentsResult> {
  const { slug = "_", delayMs = DEFAULT_DELAY_MS } = options;
  const shortId = typeof postId === "string" && postId.startsWith("t3_") ? postId.slice(3) : postId;
  const url = `${BASE_URL}/r/${subreddit}/comments/${shortId}/${slug}.json`;
  await delay(delayMs);
  const raw = await request<unknown>(url);
  if (!Array.isArray(raw) || raw.length < 1) {
    return { comments: [], postScore: null, numComments: null };
  }

  const { postScore, numComments } = parseEngagementFromCommentPageResponse(raw);

  if (raw.length < 2) {
    return { comments: [], postScore, numComments };
  }
  const commentsListing = raw[1] as { data?: { children?: CommentNode[] } };
  const listingData = commentsListing?.data ?? {};
  const children = (listingData.children ?? []) as CommentNode[];
  const out: RedditComment[] = [];
  walkReplies(children, out);
  return { comments: out, postScore, numComments };
}

/**
 * Fetch only post engagement (score, num_comments) from the post's comment page.
 * Use as fallback when fetchComments returns null for both (e.g. different response shape).
 */
export async function fetchPostEngagement(
  subreddit: string,
  postId: string,
  options: FetchCommentsOptions = {}
): Promise<{ postScore: number | null; numComments: number | null }> {
  const { slug = "_", delayMs = DEFAULT_DELAY_MS } = options;
  const shortId = typeof postId === "string" && postId.startsWith("t3_") ? postId.slice(3) : postId;
  const url = `${BASE_URL}/r/${subreddit}/comments/${shortId}/${slug}.json`;
  await delay(delayMs);
  try {
    const raw = await request<unknown>(url);
    return parseEngagementFromCommentPageResponse(raw);
  } catch {
    return { postScore: null, numComments: null };
  }
}

/**
 * Parse score and num_comments from a Reddit comment-page JSON response.
 * Handles both [ listing, listing ] and single listing; also tries raw[0].data as post data.
 */
function parseEngagementFromCommentPageResponse(raw: unknown): {
  postScore: number | null;
  numComments: number | null;
} {
  if (!Array.isArray(raw) || raw.length < 1) return { postScore: null, numComments: null };
  const first = raw[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return { postScore: null, numComments: null };

  const children = (first as { data?: { children?: unknown[] } }).data?.children;
  const postChild = Array.isArray(children) ? children[0] : null;
  const postData = postChild && typeof postChild === "object" && (postChild as { kind?: string }).kind === "t3"
    ? (postChild as { data?: Record<string, unknown> }).data
    : (first as { data?: Record<string, unknown> }).data;

  if (!postData || typeof postData !== "object") return { postScore: null, numComments: null };
  const s = postData.score ?? postData.ups;
  const n = postData.num_comments;
  let postScore: number | null = null;
  let numComments: number | null = null;
  if (s !== undefined && s !== null) {
    const v = typeof s === "number" ? s : Number(s);
    if (!Number.isNaN(v)) postScore = v;
  }
  if (n !== undefined && n !== null) {
    const v = typeof n === "number" ? n : Number(n);
    if (!Number.isNaN(v)) numComments = v;
  }
  return { postScore, numComments };
}

/**
 * Fetch post engagement using the post's permalink/full URL (e.g. when sub/id fetch fails).
 */
export async function fetchPostEngagementFromLink(
  fullLink: string,
  options: FetchCommentsOptions = {}
): Promise<{ postScore: number | null; numComments: number | null }> {
  const { delayMs = DEFAULT_DELAY_MS } = options;
  const jsonUrl = fullLink.trim().replace(/\/*$/, "") + ".json";
  await delay(delayMs);
  try {
    const raw = await request<unknown>(jsonUrl);
    return parseEngagementFromCommentPageResponse(raw);
  } catch {
    return { postScore: null, numComments: null };
  }
}
