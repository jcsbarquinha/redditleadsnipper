/**
 * API server for Leadsnipe MVP.
 * POST /api/search { "query": "..." } → runs pipeline, returns leads (for landing "wow" search).
 * Later: paid users have saved keywords; hourly job runs pipeline for those and updates dashboard.
 */

import { loadConfig } from "./config.js";
loadConfig();

import express from "express";
import { runPipeline } from "./pipeline.js";
import { getLeadsForRun } from "./db/index.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT) || 3001;

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
 * Runs the full pipeline (keywords → search → comments → intent), then returns leads ranked by intent.
 */
app.post("/api/search", async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Missing or empty query. Send { \"query\": \"your search\" }." });
    return;
  }

  const maxPages = typeof req.body?.maxPages === "number" && req.body.maxPages >= 1 && req.body.maxPages <= 10
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
      })),
    });
  } catch (err) {
    console.error("Pipeline error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Pipeline failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Leadsnipe API listening on http://localhost:${PORT}`);
  console.log("  POST /api/search with { \"query\": \"...\" }");
});
