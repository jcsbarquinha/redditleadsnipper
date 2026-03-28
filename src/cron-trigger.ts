/**
 * Trigger scheduler tick over HTTP from Render Cron.
 * Command for cron: `node dist/cron-trigger.js`
 */

import { loadConfig } from "./config.js";

loadConfig();

const base = (process.env.APP_BASE_URL || "").trim().replace(/\/+$/, "");
const secret = (process.env.CRON_SECRET || "").trim();
const limitRaw = Number(process.env.SCHEDULER_LIMIT || "10");
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
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
const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-cron-secret": secret,
  },
  body: JSON.stringify({ limit, force }),
});

const text = await res.text();
console.log(`status ${res.status}`);
console.log(text);

if (!res.ok) process.exit(1);
