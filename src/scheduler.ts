import { DASHBOARD_CRON_MAX_PAGES_PER_KEYWORD } from "./constants.js";
import { runPipeline } from "./pipeline.js";
import { maybeSendCronLeadDigest } from "./cron-lead-digest.js";
import {
  attachRunToUser,
  claimDueSavedSearches,
  ensureCurrentSearchProfileForInput,
  markSavedSearchRunFailure,
  markSavedSearchRunSuccess,
  setRunSearchProfile,
  type SavedSearchRow,
} from "./db/index.js";

export interface SchedulerTickResult {
  claimed: number;
  processed: number;
  succeeded: number;
  failed: number;
  runIds: string[];
}

export interface SchedulerTickOptions {
  limit?: number;
  maxPagesPerKeyword?: number;
  force?: boolean;
}

function toContext(context: string | null): string | undefined {
  if (typeof context !== "string") return undefined;
  const trimmed = context.trim();
  return trimmed ? trimmed : undefined;
}

export async function runSavedSearchSchedulerTick(
  options: SchedulerTickOptions = {}
): Promise<SchedulerTickResult> {
  const limit = Number.isFinite(options.limit) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 10;
  const maxPagesPerKeyword =
    Number.isFinite(options.maxPagesPerKeyword) && Number(options.maxPagesPerKeyword) > 0
      ? Math.floor(Number(options.maxPagesPerKeyword))
      : DASHBOARD_CRON_MAX_PAGES_PER_KEYWORD;
  const force = options.force === true;

  const claimed: SavedSearchRow[] = claimDueSavedSearches(limit, 20, force);
  const result: SchedulerTickResult = {
    claimed: claimed.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    runIds: [],
  };

  for (const saved of claimed) {
    result.processed += 1;
    const userInput = (saved.query || "").trim();
    if (!userInput) {
      result.failed += 1;
      markSavedSearchRunFailure(saved.id, "Saved search has empty query.");
      continue;
    }
    try {
      const pipelineResult = await runPipeline({
        userInput,
        context: toContext(saved.context),
        maxPagesPerKeyword,
        searchMode: "cron",
      });
      attachRunToUser(pipelineResult.runId, saved.user_id);
      const profile = ensureCurrentSearchProfileForInput(saved.user_id, userInput, saved.context);
      if (profile) setRunSearchProfile(pipelineResult.runId, profile.id);
      markSavedSearchRunSuccess(saved.id, saved.interval_minutes || 60);
      result.succeeded += 1;
      result.runIds.push(pipelineResult.runId);
      await maybeSendCronLeadDigest(saved.id, saved.user_id, pipelineResult.runId);
    } catch (err) {
      result.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      markSavedSearchRunFailure(saved.id, msg);
    }
  }

  return result;
}
