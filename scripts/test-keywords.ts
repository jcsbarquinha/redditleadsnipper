/**
 * Test AI search query generation. Run: npx tsx scripts/test-keywords.ts [ "product description or URL" ]
 */
import { loadConfig } from "../src/config.js";
import { getKeywordsForInput } from "../src/ai-keywords.js";

loadConfig();
const input = process.argv[2] ?? "https://notion.so";
console.log("Input:", input);
const result = await getKeywordsForInput(input);
console.log("Queries:", result.keywords);
console.log("Count:", result.keywords.length);
if (result.whatProductDoes) console.log("What product does:", result.whatProductDoes);
if (result.whatProblemItSolves) console.log("What problem it solves:", result.whatProblemItSolves);
