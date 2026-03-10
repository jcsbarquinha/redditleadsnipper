#!/usr/bin/env node
/**
 * Run full pipeline: user input → AI keywords → Reddit search → shortlist → rank → optional top-post comment enrichment → DB.
 *
 *   npx tsx src/run-pipeline.ts "social media scheduler"
 *   npx tsx src/run-pipeline.ts "Notion alternative" --no-comments --max-pages 2
 */

import { loadConfig } from "./config.js";
loadConfig();

import { runPipeline } from "./pipeline.js";

function parseArgs(): {
  userInput: string;
  includeComments: boolean;
  maxPages: number;
  delayMs: number;
} {
  const argv = process.argv.slice(2);
  let includeComments = true;
  let maxPages = 4;
  let delayMs = 500;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-comments") includeComments = false;
    else if (a === "--max-pages" && argv[i + 1] != null) maxPages = parseInt(argv[++i], 10) || 4;
    else if (a === "--delay" && argv[i + 1] != null) delayMs = Math.max(500, parseFloat(argv[++i]) * 1000) || 500;
    else if (!a.startsWith("--")) args.push(a);
  }
  const userInput = args.join(" ").trim();
  if (!userInput) {
    console.error("Usage: npx tsx src/run-pipeline.ts \"<product or problem>\" [--no-comments] [--max-pages N] [--delay SECS]");
    process.exit(1);
  }
  return { userInput, includeComments, maxPages, delayMs };
}

async function main(): Promise<void> {
  const { userInput, includeComments, maxPages, delayMs } = parseArgs();
  console.log("Pipeline: validate → conversational queries → expanded Reddit search → shortlist → rank → optional top-post enrichment");
  console.log("Input:", userInput);
  try {
    const result = await runPipeline({
      userInput,
      includeComments,
      maxPagesPerKeyword: maxPages,
      delayMs,
    });
    console.log("Run ID:", result.runId);
    console.log("Keywords:", result.keywords.length);
    console.log("Unique posts:", result.totalPosts);
    console.log("Comments stored:", result.totalComments);
    console.log("Post intents (0-100):", result.totalPostIntents);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
