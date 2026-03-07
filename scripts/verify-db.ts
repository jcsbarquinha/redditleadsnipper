/**
 * Verify database and schema. Run: npx tsx scripts/verify-db.ts
 */
import { loadConfig } from "../src/config.js";
import { getDb } from "../src/db/index.js";

loadConfig();
const db = getDb();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
console.log("Tables:", tables.map((r) => r.name).join(", "));
console.log("Database and schema OK.");
