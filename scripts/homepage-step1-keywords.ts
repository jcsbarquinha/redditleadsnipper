/**
 * Step 1 (homepage parity): AI keywords only, count = 3 (see search-modes homepage).
 * Run: npx tsx scripts/homepage-step1-keywords.ts [url]
 */
import { loadConfig } from "../src/config.js";
import { getKeywordsForInput } from "../src/ai-keywords.js";
import { getSearchModeRedditParams } from "../src/search-modes.js";

loadConfig();

const url = process.argv[2] ?? "https://www.headshotpro.com/";
const { keywordCount } = getSearchModeRedditParams("homepage");

console.log("Step 1 — Keywords (homepage)\n");
console.log("URL:", url);
console.log("keywordCount (from search-modes homepage):", keywordCount);
console.log("");

const r = await getKeywordsForInput(url, keywordCount);
console.log("keywords:", r.keywords);
console.log("");
console.log("what_product_does:\n", r.whatProductDoes ?? "(none)");
console.log("");
console.log("what_problem_it_solves:\n", r.whatProblemItSolves ?? "(none)");
