/**
 * Test AI keyword expansion. Run: npx tsx scripts/test-keywords.ts [ "product or problem" ]
 */
import { loadConfig } from "../src/config.js";
import { getKeywordsForInput } from "../src/ai-keywords.js";

loadConfig();
const input = process.argv[2] ?? "Notion alternative for developers";
console.log("Input:", input);
const keywords = await getKeywordsForInput(input);
console.log("Keywords:", keywords);
console.log("Count:", keywords.length);
