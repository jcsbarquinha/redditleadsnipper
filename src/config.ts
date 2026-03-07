/**
 * Load .env and expose config. Call loadConfig() at app entry (e.g. run.ts).
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

const DEFAULT_DB_PATH = "./data/reddit-leads.db";

export function loadConfig(): void {
  loadEnv(); // loads .env from cwd
}

export function getOpenAIKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return url;
  return resolve(process.cwd(), DEFAULT_DB_PATH);
}

export function requireOpenAIKey(): string {
  const key = getOpenAIKey();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is required. Add it to .env or set the environment variable."
    );
  }
  return key;
}
