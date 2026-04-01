/**
 * Trigger scheduler tick over HTTP from Render Cron.
 * Command for cron: `node dist/cron-trigger.js`
 *
 * The API does not send response headers until the full tick finishes (each user’s pipeline
 * can take several minutes). Node’s default fetch headers timeout (~5m) is too short when
 * processing many users; use a long-lived undici Agent.
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
/** Unset or 0 = process all eligible users; set a positive number to cap batch size. */
const limitRaw = (process.env.SCHEDULER_LIMIT || "").trim();
const limitParsed = Number(limitRaw);
const limit =
  limitRaw === "" || limitRaw === "0"
    ? 0
    : Number.isFinite(limitParsed) && limitParsed > 0
      ? Math.floor(limitParsed)
      : 0;
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
const res = await undiciFetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-cron-secret": secret,
  },
  body: JSON.stringify({ limit, force }),
  dispatcher: cronFetchAgent,
});

const text = await res.text();
console.log(`status ${res.status}`);
console.log(text);

if (!res.ok) process.exit(1);
