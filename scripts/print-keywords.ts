/**
 * One-off: npx tsx scripts/print-keywords.ts <url> [<url> ...]
 */
import { loadConfig } from "../src/config.js";
import { getKeywordsForInput, DEFAULT_KEYWORD_COUNT } from "../src/ai-keywords.js";

loadConfig();

const urls = process.argv.slice(2).filter(Boolean);
if (urls.length === 0) {
  console.error("Usage: npx tsx scripts/print-keywords.ts <url> [<url> ...]");
  process.exit(1);
}

for (const u of urls) {
  console.log(`\n==========\n${u}\n==========`);
  const r = await getKeywordsForInput(u, DEFAULT_KEYWORD_COUNT);
  console.log(`(${r.keywords.length} keywords)\n`);
  r.keywords.forEach((k, i) => console.log(`${i + 1}. ${k}`));
}
