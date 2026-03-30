/**
 * Search mode matrix: keyword depth, Reddit pacing, sorts, and `t=` window.
 * App-side max post age ({@link POST_DISCOVERY_MAX_AGE_DAYS}) stays separate.
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

/** Fixed defaults per mode. Callers may override `keywordCount` / `delayMs` / `maxPages` via {@link import("./pipeline.js").PipelineOptions}. */
export function getSearchModeRedditParams(mode: SearchMode): SearchModeRedditParams {
  switch (mode) {
    case "homepage":
      return {
        keywordCount: 3,
        delayMs: 1500,
        redditSorts: ["relevance", "new"],
        redditTimeFilter: "week",
      };
    case "dashboard":
      return {
        keywordCount: 15,
        delayMs: 2000,
        redditSorts: ["new", "relevance"],
        redditTimeFilter: "week",
      };
    case "cron":
      return {
        keywordCount: 15,
        delayMs: 5000,
        redditSorts: ["new", "relevance"],
        redditTimeFilter: "day",
      };
  }
}
