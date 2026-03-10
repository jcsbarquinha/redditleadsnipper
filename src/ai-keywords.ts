/**
 * AI conversational query expansion: user input → N Reddit-style search queries via OpenAI.
 * These are short, frustration-oriented phrases meant for broad Reddit matching.
 */

import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

/** Number of LLM-generated conversational seed queries. */
export const DEFAULT_KEYWORD_COUNT = 20;

function buildSystemPrompt(keywordCount: number): string {
  return `You are generating conversational Reddit search queries for a founder looking for high-intent leads.

Given a product, service, workflow, or business use case, output exactly ${keywordCount} SHORT search queries that reflect how frustrated or solution-seeking people actually write on Reddit.

Good queries are:
- conversational
- pain-oriented
- switching-oriented
- recommendation-oriented
- broad enough for Reddit search to match variations
- usually 2 to 6 words

Avoid:
- generic taxonomy phrases
- long sentences
- quotation marks
- hashtags
- marketing jargon

Examples of good style:
- mailchimp expensive
- hate mailchimp
- switch from hubspot
- recommend email newsletter tool
- looking for crm
- need scheduling software

Return only a JSON object with a single key "keywords" whose value is an array of exactly ${keywordCount} strings. No other text or markdown.`;
}

function buildUserPrompt(userInput: string, keywordCount: number): string {
  return `User input:\n\n"${userInput.trim()}"\n\nReturn a JSON object: { "keywords": ["query1", "query2", ... ] } with exactly ${keywordCount} conversational Reddit search queries.`;
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
 * Returns conversational Reddit search queries for the given user input.
 * Default count is 20. Uses OPENAI_API_KEY from env.
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
