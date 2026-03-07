/**
 * Reddit comments via .json URL workaround (no API key).
 * Fetches comment tree for a post and flattens to a list of comment objects.
 */

import type { RedditComment } from "./types.js";
import { BASE_URL, DEFAULT_DELAY_MS } from "./reddit-search.js";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0";
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;

function headers(): HeadersInit {
  return { "User-Agent": USER_AGENT };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function request<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt < MAX_RETRIES - 1) {
          await delay(RETRY_BACKOFF_MS * (attempt + 1));
          continue;
        }
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
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

/**
 * Fetch all comments for a post. Returns a flat list of comment objects.
 */
export async function fetchComments(
  subreddit: string,
  postId: string,
  options: FetchCommentsOptions = {}
): Promise<RedditComment[]> {
  const { slug = "_", delayMs = DEFAULT_DELAY_MS } = options;
  const url = `${BASE_URL}/r/${subreddit}/comments/${postId}/${slug}.json`;
  await delay(delayMs);
  const raw = await request<unknown>(url);
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const commentsListing = raw[1] as { data?: { children?: CommentNode[] } };
  const listingData = commentsListing?.data ?? {};
  const children = (listingData.children ?? []) as CommentNode[];
  const out: RedditComment[] = [];
  walkReplies(children, out);
  return out;
}
