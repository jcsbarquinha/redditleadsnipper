/**
 * Trigger scheduler tick over HTTP from Render Cron / Railway Cron.
 * Command for cron: `node dist/cron-trigger.js`
 *
 * Calls POST /api/internal/scheduler/tick in a loop with a small `limit` each time so each
 * HTTP request finishes before client/proxy timeouts (each user’s pipeline can take minutes).
 * Continues until no saved searches are claimed or CRON_MAX_ROUNDS is hit.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig } from "./config.js";

loadConfig();

const timeoutMsRaw = Number((process.env.CRON_FETCH_TIMEOUT_MS || "").trim());
const timeoutMs =
  Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 60_000 ? Math.floor(timeoutMsRaw) : 45 * 60 * 1000;

const cronFetchAgent = new Agent({
  headersTimeout: timeoutMs,
  bodyTimeout: timeoutMs,
  connectTimeout: 120_000,
});

const base = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
const secret = (process.env.CRON_SECRET || "").trim();

const chunkRaw = (process.env.SCHEDULER_CHUNK_SIZE || "").trim();
const chunkParsed = Number(chunkRaw);
const chunkSize =
  chunkRaw !== "" && Number.isFinite(chunkParsed) && chunkParsed >= 1
    ? Math.floor(chunkParsed)
    : 3;

const maxRoundsRaw = (process.env.CRON_MAX_ROUNDS || "").trim();
const maxRoundsParsed = Number(maxRoundsRaw);
const maxRounds =
  maxRoundsRaw !== "" && Number.isFinite(maxRoundsParsed) && maxRoundsParsed >= 1
    ? Math.floor(maxRoundsParsed)
    : 200;

const forceRaw = (process.env.SCHEDULER_FORCE || "").trim().toLowerCase();
const force = forceRaw === "1" || forceRaw === "true" || forceRaw === "yes";

if (!base) {
  console.error("Missing APP_BASE_URL.");
  process.exit(1);
}
if (!secret) {
  console.error("Missing CRON_SECRET.");
  process.exit(1);
}

const url = `${base}/api/internal/scheduler/tick`;

type TickResponse = {
  ok?: boolean;
  force?: boolean;
  elapsed_ms?: number;
  claimed?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
  runIds?: string[];
  error?: string;
};

const startedAll = Date.now();
let totalClaimed = 0;
let totalProcessed = 0;
let totalSucceeded = 0;
let totalFailed = 0;
const allRunIds: string[] = [];
let rounds = 0;

for (;;) {
  if (rounds >= maxRounds) {
    console.error(
      JSON.stringify({
        event: "cron_trigger_abort",
        reason: "CRON_MAX_ROUNDS",
        maxRounds,
        rounds,
        totalClaimed,
        totalProcessed,
      })
    );
    process.exit(1);
  }
  rounds += 1;

  const res = await undiciFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": secret,
    },
    body: JSON.stringify({ limit: chunkSize, force }),
    dispatcher: cronFetchAgent,
  });

  const text = await res.text();
  let body: TickResponse;
  try {
    body = JSON.parse(text) as TickResponse;
  } catch {
    console.error(`status ${res.status}`);
    console.error(text);
    process.exit(1);
  }

  if (!res.ok || body.ok !== true) {
    console.error(`status ${res.status}`);
    console.log(text);
    process.exit(1);
  }

  const claimed = Number(body.claimed) || 0;
  const processed = Number(body.processed) || 0;
  const succeeded = Number(body.succeeded) || 0;
  const failed = Number(body.failed) || 0;

  totalClaimed += claimed;
  totalProcessed += processed;
  totalSucceeded += succeeded;
  totalFailed += failed;
  if (Array.isArray(body.runIds)) {
    allRunIds.push(...body.runIds);
  }

  console.log(
    JSON.stringify({
      event: "cron_trigger_round",
      round: rounds,
      chunkSize,
      claimed,
      processed,
      succeeded,
      failed,
      elapsed_ms: body.elapsed_ms,
    })
  );

  if (claimed === 0) {
    break;
  }
}

const elapsedMs = Date.now() - startedAll;
console.log(
  JSON.stringify({
    event: "cron_trigger_done",
    ok: true,
    force,
    rounds,
    chunkSize,
    maxRounds,
    totalClaimed,
    totalProcessed,
    totalSucceeded,
    totalFailed,
    runIds: allRunIds,
    elapsed_ms: elapsedMs,
  })
);

if (totalFailed > 0) {
  process.exit(1);
}
