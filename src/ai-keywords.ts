/**
 * AI keyword expansion: user input → N Reddit search phrases via OpenAI.
 * Default 4 keywords for fast initial runs; can be increased for paid/deep runs.
 */

import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

/** Number of keywords to request (4 = ~2 min pipeline; 10 = deeper run for paid/alerts). */
export const DEFAULT_KEYWORD_COUNT = 4;

function buildSystemPrompt(keywordCount: number): string {
  return `You are a search expert. Given a product, SaaS, or problem description, you output exactly ${keywordCount} Reddit search phrases that potential buyers or people with that problem would use when searching on Reddit. Include the exact phrase the user gave (if short) plus ${keywordCount - 1} very similar alternatives (e.g. product type, "X alternative", use case). Return only a JSON object with a single key "keywords" whose value is an array of exactly ${keywordCount} strings. No other text or markdown.`;
}

function buildUserPrompt(userInput: string, keywordCount: number): string {
  return `Product/description from the user:\n\n"${userInput.trim()}"\n\nReturn a JSON object: { "keywords": ["phrase1", "phrase2", ... ] } with exactly ${keywordCount} Reddit search phrases.`;
}

function parseKeywordsResponse(content: string, maxKeywords: number): string[] {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  const parsed = JSON.parse(jsonStr) as { keywords?: string[] };
  const list = parsed?.keywords ?? (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(list)) throw new Error("Expected keywords array");
  return list.slice(0, maxKeywords).filter((k): k is string => typeof k === "string" && k.trim().length > 0);
}

/**
 * Returns Reddit search keywords for the given user input (product, problem, or "X alternative").
 * Default count is 4 for fast initial runs. Uses OPENAI_API_KEY from env.
 */
export async function getKeywordsForInput(
  userInput: string,
  keywordCount: number = DEFAULT_KEYWORD_COUNT
): Promise<string[]> {
  const key = requireOpenAIKey();
  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: buildSystemPrompt(keywordCount) },
        { role: "user", content: buildUserPrompt(userInput, keywordCount) },
      ],
      temperature: 0.3,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errBody || res.statusText}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error?.message) throw new Error(`OpenAI: ${data.error.message}`);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");

  const keywords = parseKeywordsResponse(content, keywordCount);
  if (keywords.length === 0) throw new Error("OpenAI returned no valid keywords");
  return keywords.slice(0, keywordCount);
}
