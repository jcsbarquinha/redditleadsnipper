/**
 * Run one scheduler tick for due saved searches.
 * Usage: npx tsx src/run-scheduler.ts [limit] [--force]
 */

import { loadConfig } from "./config.js";
import { DASHBOARD_CRON_MAX_PAGES_PER_KEYWORD } from "./constants.js";
import { runSavedSearchSchedulerTick } from "./scheduler.js";

loadConfig();

const limitArg = Number(process.argv[2] || "");
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : 10;
const force = process.argv.includes("--force");

const startedAt = Date.now();
const result = await runSavedSearchSchedulerTick({
  limit,
  maxPagesPerKeyword: DASHBOARD_CRON_MAX_PAGES_PER_KEYWORD,
  force,
});
const elapsedMs = Date.now() - startedAt;

console.log(
  JSON.stringify({
    event: "saved_search_scheduler_tick",
    limit,
    force,
    elapsed_ms: elapsedMs,
    ...result,
  })
);
