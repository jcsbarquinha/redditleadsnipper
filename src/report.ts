#!/usr/bin/env node
/**
 * Inspect pipeline results: posts ranked by buying intent with Reddit links.
 *
 *   npm run report              # all posts, all runs, ranked by intent
 *   npm run report -- --run ID  # only posts from run ID
 *   npm run report -- --limit 30
 */

import { loadConfig } from "./config.js";
loadConfig();

import { getDb } from "./db/index.js";

interface Row {
  run_id: string;
  user_input: string;
  score: number | null;
  label: string | null;
  title: string | null;
  full_link: string;
  subreddit: string | null;
  author: string | null;
  created_utc: number | null;
  reasoning: string | null;
  suggested_reply: string | null;
}

function formatPostAge(createdUtc: number | null): string {
  if (createdUtc == null) return "-";
  const d = new Date(createdUtc * 1000);
  const now = Date.now() / 1000;
  const daysAgo = Math.floor((now - createdUtc) / 86400);
  if (daysAgo < 30) return `${daysAgo}d ago`;
  if (daysAgo < 365) return `${Math.floor(daysAgo / 30)}mo ago`;
  return d.toISOString().slice(0, 10);
}

function parseArgs(): { runId?: string; limit: number } {
  const argv = process.argv.slice(2);
  let runId: string | undefined;
  let limit = 100;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run" && argv[i + 1]) runId = argv[++i];
    else if (argv[i] === "--limit" && argv[i + 1]) limit = Math.max(1, parseInt(argv[++i], 10) || 100);
  }
  return { runId, limit };
}

function main(): void {
  const { runId, limit } = parseArgs();
  const db = getDb();

  if (runId) {
    const run = db.prepare("SELECT id, user_input FROM runs WHERE id = ?").get(runId) as { id: string; user_input: string } | undefined;
    if (!run) {
      console.error("Run not found:", runId);
      process.exit(1);
    }
    console.log("Run:", run.id);
    console.log("Query:", run.user_input);
    console.log("");
  } else {
    const runs = db.prepare("SELECT id, user_input, created_at FROM runs ORDER BY created_at DESC LIMIT 10").all() as { id: string; user_input: string; created_at: string }[];
    if (runs.length === 0) {
      console.log("No runs found. Run: npm run pipeline -- \"your product or problem\"");
      process.exit(0);
    }
    console.log("Recent runs (showing posts from all, ranked by intent):");
    for (const r of runs) {
      console.log("  ", r.id.slice(0, 8) + "...", r.user_input);
    }
    console.log("");
  }

  const sql = runId
    ? `SELECT p.run_id, r.user_input, pi.score, pi.label, p.title, p.full_link, p.subreddit, p.author, p.created_utc, pi.reasoning, pi.suggested_reply
       FROM posts p
       JOIN runs r ON p.run_id = r.id
       LEFT JOIN post_intent pi ON p.id = pi.post_id
       WHERE p.run_id = ?
       ORDER BY pi.score DESC NULLS LAST, p.created_at DESC
       LIMIT ?`
    : `SELECT p.run_id, r.user_input, pi.score, pi.label, p.title, p.full_link, p.subreddit, p.author, p.created_utc, pi.reasoning, pi.suggested_reply
       FROM posts p
       JOIN runs r ON p.run_id = r.id
       LEFT JOIN post_intent pi ON p.id = pi.post_id
       ORDER BY pi.score DESC NULLS LAST, p.created_at DESC
       LIMIT ?`;

  const rows = (runId ? db.prepare(sql).all(runId, limit) : db.prepare(sql).all(limit)) as Row[];

  if (rows.length === 0) {
    console.log("No posts found.");
    return;
  }

  const titleLen = 52;
  console.log("Posts ranked by buying intent (score 0–100, high first):\n");
  console.log("#    Score  Label   Date      Title");
  console.log("-".repeat(88));

  rows.forEach((row, i) => {
    const score = row.score != null ? String(Math.round(row.score)).padStart(3) : "  -";
    const label = (row.label ?? "-").padEnd(6);
    const dateStr = formatPostAge(row.created_utc).padEnd(9);
    const title = (row.title ?? "").trim().slice(0, titleLen);
    const pad = title.length < titleLen ? " ".repeat(titleLen - title.length) : "";
    console.log(`${String(i + 1).padStart(3)}   ${score}   ${label}  ${dateStr} ${title}${pad}`);
  });

  console.log("\nLinks (same order):\n");
  rows.forEach((row, i) => {
    console.log(`${i + 1}. ${row.full_link}`);
  });

  console.log("\n--- Explanation & suggested reply (same order) ---\n");
  rows.forEach((row, i) => {
    const explanation = (row.reasoning ?? "").trim() || "(no explanation)";
    const reply = (row.suggested_reply ?? "").trim() || "(no suggested reply)";
    const replyPreview = reply.length > 280 ? reply.slice(0, 277) + "..." : reply;
    console.log(`${i + 1}. Explanation: ${explanation}`);
    console.log(`   Suggested reply: ${replyPreview}`);
    console.log("");
  });
}

main();
