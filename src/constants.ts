/**
 * Max age (days) for Reddit posts in non-homepage discovery paths (default in {@link ./pipeline.ts}).
 */
export const POST_DISCOVERY_MAX_AGE_DAYS = 4;

/** Homepage `/api/search` only: max post age after Reddit fetch (stricter/wider than global default). */
export const HOMEPAGE_MAX_POST_AGE_DAYS = 7;

/** Saved-search cron: cap post age to match Reddit `t=day` in {@link import("./search-modes.js").getSearchModeRedditParams}. */
export const CRON_MAX_POST_AGE_DAYS = 1;

/**
 * Reddit result pages per (keyword × sort) for dashboard, saved-search cron, and scheduler CLI.
 * Homepage `/api/search` also uses 1 page (see server).
 */
export const DASHBOARD_CRON_MAX_PAGES_PER_KEYWORD = 1;
