#!/usr/bin/env node
/**
 * CLI entrypoint: search Reddit, optionally fetch comments, write JSON results.
 *
 * Usage:
 *   npx tsx src/run.ts "social media scheduler" --max-pages 2
 *   npx tsx src/run.ts "social media scheduler" --no-comments   (posts only, no comments)
 *   npm run search -- "social media scheduler" --broad
 */

import { loadConfig } from "./config.js";
loadConfig();

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { search } from "./reddit-search.js";
import { fetchComments } from "./reddit-comments.js";
import type { SearchResultPayload } from "./types.js";

const DEFAULT_DELAY_MS = 1500; // override with --delay (min 0.5)
const DEFAULT_MAX_PAGES = 4; // 4 pages × 25 = 100 posts per keyword; used for lead discovery runs
const DEFAULT_OUTPUT_DIR = "output";

function sanitizeQueryForFilename(query: string): string {
  const s = query.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return s.slice(0, 80) || "search";
}

function parseArgs(): {
  query: string;
  comments: boolean;
  maxPages: number;
  delayMs: number;
  outputDir: string;
  broad: boolean;
} {
  const argv = process.argv.slice(2);
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {
    comments: true,
    broad: false,
    "max-pages": String(DEFAULT_MAX_PAGES),
    delay: String(DEFAULT_DELAY_MS / 1000),
    "output-dir": DEFAULT_OUTPUT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--comments") flags.comments = true;
    else if (arg === "--no-comments") flags.comments = false;
    else if (arg === "--broad") flags.broad = true;
    else if (arg === "--max-pages" && argv[i + 1] != null) {
      flags["max-pages"] = argv[++i];
    } else if (arg === "--delay" && argv[i + 1] != null) {
      flags.delay = argv[++i];
    } else if (arg === "--output-dir" && argv[i + 1] != null) {
      flags["output-dir"] = argv[++i];
    } else if (!arg.startsWith("--")) {
      args.push(arg);
    }
  }
  const query = args.join(" ").trim();
  if (!query) {
    console.error("Error: Provide a non-empty search query.");
    process.exit(1);
  }
  return {
    query,
    comments: Boolean(flags.comments),
    maxPages: Math.max(1, parseInt(String(flags["max-pages"]), 10) || DEFAULT_MAX_PAGES),
    delayMs: Math.max(500, parseFloat(String(flags.delay)) * 1000) || DEFAULT_DELAY_MS,
    outputDir: String(flags["output-dir"]),
    broad: Boolean(flags.broad),
  };
}

export async function run(options: {
  query: string;
  includeComments?: boolean;
  maxPages?: number;
  delayMs?: number;
  outputDir?: string;
  broad?: boolean;
}): Promise<{ outPath: string; numPosts: number }> {
  const {
    query,
    includeComments = true,
    maxPages = DEFAULT_MAX_PAGES,
    delayMs = DEFAULT_DELAY_MS,
    outputDir = DEFAULT_OUTPUT_DIR,
    broad = false,
  } = options;

  mkdirSync(outputDir, { recursive: true });

  const posts = await search(query, {
    maxPages,
    delayMs,
    exactPhrase: !broad,
  });

  if (includeComments) {
    for (const post of posts) {
      const sub = post.subreddit ?? "";
      const pid = post.id ?? "";
      if (!sub || !pid) {
        post.comments = [];
        continue;
      }
      try {
        const { comments } = await fetchComments(sub, pid, { delayMs });
        post.comments = comments;
      } catch (err) {
        post.comments = [];
        console.error(`Warning: could not fetch comments for ${post.full_link}: ${err}`);
      }
    }
  } else {
    for (const post of posts) post.comments = [];
  }

  const payload: SearchResultPayload = {
    query,
    fetched_at: new Date().toISOString(),
    posts,
  };

  const safe = sanitizeQueryForFilename(query);
  const iso = new Date().toISOString();
  const ts = iso.slice(0, 10).replace(/-/g, "") + "_" + iso.slice(11, 19).replace(/:/g, "");
  const filename = `results_${safe}_${ts}.json`;
  const outPath = join(outputDir, filename);
  writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");

  return { outPath, numPosts: posts.length };
}

async function main(): Promise<void> {
  const args = parseArgs();
  try {
    const { outPath, numPosts } = await run({
      query: args.query,
      includeComments: args.comments,
      maxPages: args.maxPages,
      delayMs: args.delayMs,
      outputDir: args.outputDir,
      broad: args.broad,
    });
    console.log(`Wrote ${numPosts} posts to ${outPath}`);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
