/**
 * Reddit search via .json URL workaround (no API key).
 * Fetches search listing and paginates with 'after'.
 */

import type { RedditPost } from "./types.js";

const BASE_URL = "https://www.reddit.com";
export { BASE_URL };

// Browser-like headers to reduce 403 (Reddit blocks bare/bot-like requests)
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

export const DEFAULT_DELAY_MS = 1000; // 1 s between requests; use --delay 0.5 for faster (risk of 429)
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function request<T>(url: string, delayMs: number): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status === 503 || res.status === 403) {
        if (attempt < MAX_RETRIES - 1) {
          await delay(RETRY_BACKOFF_MS * (attempt + 1));
          continue;
        }
      }
      if (!res.ok) {
        const body = await res.text();
        const msg = body ? `${res.statusText}: ${body.slice(0, 200)}` : res.statusText;
        throw new Error(`HTTP ${res.status}: ${msg}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === MAX_RETRIES - 1) throw err;
      await delay(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }
  throw new Error("Unexpected retry exit");
}

interface ListingChild {
  kind?: string;
  data?: Record<string, unknown>;
}

interface RedditListing {
  data?: {
    children?: ListingChild[];
    after?: string | null;
  };
}

function extractPost(child: ListingChild): RedditPost | null {
  if (child?.kind !== "t3") return null;
  const d = (child.data ?? {}) as Record<string, unknown>;
  const permalink = String(d.permalink ?? "").trim();
  const fullLink = permalink.startsWith("/") ? `${BASE_URL}${permalink}` : permalink;
  const rawScore = d.score ?? d.ups;
  const rawNumComments = d.num_comments;
  const score = typeof rawScore === "number" && !Number.isNaN(rawScore) ? rawScore : (typeof rawScore === "string" ? Number(rawScore) : null);
  const numComments = typeof rawNumComments === "number" && !Number.isNaN(rawNumComments) ? rawNumComments : (typeof rawNumComments === "string" ? Number(rawNumComments) : null);
  return {
    id: (d.id as string) ?? null,
    title: (d.title as string) ?? null,
    selftext: String(d.selftext ?? ""),
    score: score != null && !Number.isNaN(score) ? score : null,
    num_comments: numComments != null && !Number.isNaN(numComments) ? numComments : null,
    permalink,
    full_link: fullLink,
    subreddit: (d.subreddit as string) ?? null,
    subreddit_id: (d.subreddit_id as string) ?? null,
    author: (d.author as string) ?? null,
    created_utc: (d.created_utc as number) ?? null,
    url: (d.url as string) ?? null,
    is_self: (d.is_self as boolean) ?? null,
    over_18: (d.over_18 as boolean) ?? null,
    link_flair_text: (d.link_flair_text as string) ?? null,
    comments: [],
  };
}

export interface SearchOptions {
  maxPages?: number;
  limit?: number;
  delayMs?: number;
  exactPhrase?: boolean;
}

/**
 * Fetch Reddit search results for `query`, paginating up to `maxPages` pages.
 * If exactPhrase is true (default), the query is wrapped in double quotes for better relevance.
 */
export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<RedditPost[]> {
  const {
    maxPages = 10,
    limit = 25,
    delayMs = DEFAULT_DELAY_MS,
    exactPhrase = true,
  } = options;

  let q = query.trim();
  if (exactPhrase && q && !(q.startsWith('"') && q.endsWith('"'))) {
    q = `"${q}"`;
  }
  const encoded = encodeURIComponent(q);
  const posts: RedditPost[] = [];
  let after: string | null = null;
  let page = 0;

  while (page < maxPages) {
    let url = `${BASE_URL}/search.json?q=${encoded}&limit=${limit}&sort=relevance&type=link`;
    if (after) url += `&after=${after}`;
    await delay(delayMs);
    const data = await request<RedditListing>(url, delayMs);
    const listing = data?.data ?? {};
    const children = (listing.children ?? []) as ListingChild[];
    for (const child of children) {
      const post = extractPost(child);
      if (post) posts.push(post);
    }
    after = listing.after ?? null;
    page++;
    if (!after || children.length === 0) break;
  }

  return posts;
}
