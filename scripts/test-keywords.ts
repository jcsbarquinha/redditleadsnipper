/**
 * Test AI search query generation. Run: npx tsx scripts/test-keywords.ts [ "product description or URL" ]
 */
import { loadConfig } from "../src/config.js";
import { getKeywordsForInput } from "../src/ai-keywords.js";

loadConfig();
const input = process.argv[2] ?? "https://notion.so";
console.log("Input:", input);
const queries = await getKeywordsForInput(input);
console.log("Queries:", queries);
console.log("Count:", queries.length);
