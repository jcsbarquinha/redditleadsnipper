/**
 * API server for Leadsnipe MVP.
 * POST /api/search { "query": "..." } → runs pipeline, returns leads (for landing "wow" search).
 * Serves landing page from public/ at GET /.
 */

import { loadConfig } from "./config.js";
loadConfig();

import express from "express";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline } from "./pipeline.js";
import { getLeadsForRun } from "./db/index.js";
import { InvalidSearchInputError } from "./input-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

/** IP-based rate limit: max requests per window (default 10 per 60s). */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 10;

const ipRequestTimestamps = new Map<string, number[]>();

function getClientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let timestamps = ipRequestTimestamps.get(ip) ?? [];
  timestamps = timestamps.filter((t) => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) return true;
  timestamps.push(now);
  ipRequestTimestamps.set(ip, timestamps);
  return false;
}

// Prune old entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of ipRequestTimestamps.entries()) {
    const kept = timestamps.filter((t) => t > cutoff);
    if (kept.length === 0) ipRequestTimestamps.delete(ip);
    else ipRequestTimestamps.set(ip, kept);
  }
}, 5 * 60 * 1000);

// Allow frontend (any origin for MVP; restrict later)
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (_req, res) => res.sendStatus(204));

/** Health check */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/search
 * Body: { "query": "SEO content automation", "maxPages"?: number }
 * Runs the full pipeline (validation → keywords → search → shortlist → rank), then returns leads ranked by intent.
 * Rate limited by IP (default 10 requests per minute).
 */
app.post("/api/search", (req, res, next) => {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    res.status(429).json({
      error: "Too many searches. Please try again in a minute.",
    });
    return;
  }
  next();
}, async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Missing or empty query. Send { \"query\": \"your search\" }." });
    return;
  }

  const maxPages = typeof req.body?.maxPages === "number" && req.body.maxPages >= 1 && req.body.maxPages <= 2
    ? Math.floor(req.body.maxPages)
    : 1;

  try {
    const result = await runPipeline({
      userInput: query,
      includeComments: true,
      maxPagesPerKeyword: maxPages,
      keywordCount: undefined, // use default (10)
    });

    const leads = getLeadsForRun(result.runId, 100);

    res.json({
      runId: result.runId,
      query,
      keywords: result.keywords,
      totalPosts: result.totalPosts,
      totalComments: result.totalComments,
      leads: leads.map((row) => ({
        title: row.title,
        full_link: row.full_link,
        subreddit: row.subreddit,
        author: row.author,
        created_utc: row.created_utc,
        score: row.score != null ? Math.round(row.score) : null,
        label: row.label,
        is_high_intent: row.is_high_intent === 1,
        explanation: row.reasoning ?? null,
        suggested_reply: row.suggested_reply ?? null,
        selftext: row.selftext ?? null,
        votes: row.post_score ?? 0,
        num_comments: row.num_comments ?? 0,
      })),
    });
  } catch (err) {
    if (err instanceof InvalidSearchInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Pipeline error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Pipeline failed",
    });
  }
});

// Landing page and static assets (API routes above take precedence)
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`Leadsnipe running at http://localhost:${PORT}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MAX} searches per IP per minute`);
  console.log("  Landing: GET /");
  console.log("  API:     POST /api/search with { \"query\": \"...\" }");
});
