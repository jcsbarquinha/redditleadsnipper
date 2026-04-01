/**
 * Search mode matrix: keyword depth, Reddit pacing, sorts, and `t=` window.
 * Reddit `t=` window here; homepage pipeline also caps post age (see `HOMEPAGE_MAX_POST_AGE_DAYS` in constants).
 */

import type { RedditTimeFilter } from "./reddit-search.js";

export type SearchMode = "homepage" | "dashboard" | "cron";

export interface SearchModeRedditParams {
  keywordCount: number;
  /** Delay between Reddit listing requests (each `search()` pagination step). */
  delayMs: number;
  redditSorts: Array<"new" | "relevance">;
  redditTimeFilter: RedditTimeFilter;
}

/** Fixed defaults per mode. Callers may override `keywordCount` / `delayMs` / `maxPages` via {@link import("./pipeline.js").PipelineOptions}. Dashboard/cron use 10 keywords for broader coverage. */
export function getSearchModeRedditParams(mode: SearchMode): SearchModeRedditParams {
  switch (mode) {
    case "homepage":
      return {
        keywordCount: 3,
        delayMs: 2500,
        redditSorts: ["relevance"],
        redditTimeFilter: "week",
      };
    case "dashboard":
      return {
        keywordCount: 10,
        delayMs: 3500,
        redditSorts: ["new", "relevance"],
        redditTimeFilter: "week",
      };
    case "cron":
      return {
        keywordCount: 10,
        delayMs: 5500,
        redditSorts: ["new", "relevance"],
        redditTimeFilter: "day",
      };
  }
}
