/**
 * Reddit search via .json URL workaround (no API key).
 * Fetches search listing and paginates with 'after'.
 */

import type { RedditPost } from "./types.js";

const BASE_URL = "https://www.reddit.com";
export { BASE_URL };
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0";
export const DEFAULT_DELAY_MS = 1000; // 1 s between requests; use --delay 0.5 for faster (risk of 429)
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;

function headers(): HeadersInit {
  return { "User-Agent": USER_AGENT };
}

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
  return {
    id: (d.id as string) ?? null,
    title: (d.title as string) ?? null,
    selftext: String(d.selftext ?? ""),
    score: (d.score as number) ?? null,
    num_comments: (d.num_comments as number) ?? null,
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
