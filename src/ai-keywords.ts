/**
 * AI search query generation: user input → Reddit-style search queries via OpenAI.
 * URL inputs are first analyzed from the website itself; descriptions go straight to the model.
 */

import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const WEBSITE_FETCH_TIMEOUT_MS = 15_000;
const MAX_WEBSITE_TEXT_LENGTH = 4000;

/** Number of final LLM-generated search queries. */
export const DEFAULT_KEYWORD_COUNT = 8;

interface WebsiteContext {
  url: string;
  title: string;
  metaDescription: string;
  headings: string[];
  bodyExcerpt: string;
}

function normalizeSearchQuery(query: string): string {
  return cleanText(query)
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .trim();
}

function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return Boolean(url.hostname && url.hostname.includes("."));
  } catch {
    return false;
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
  return url.toString();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirstMatch(html: string, regex: RegExp): string {
  const match = html.match(regex);
  return cleanText(match?.[1] ?? "");
}

function stripTags(html: string): string {
  return cleanText(
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractHeadings(html: string): string[] {
  const matches = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)];
  const headings = matches
    .map((match) => stripTags(match[1] ?? ""))
    .filter(Boolean);
  return [...new Set(headings)].slice(0, 6);
}

async function fetchWebsiteContext(input: string): Promise<WebsiteContext | null> {
  if (!looksLikeUrl(input)) return null;

  const url = normalizeUrl(input);
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; LeadsnipeBot/1.0; +https://leadsnipe.com)",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(WEBSITE_FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Website fetch failed with HTTP ${res.status}`);
  }

  const html = await res.text();
  const title = extractFirstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    extractFirstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i) ||
    extractFirstMatch(html, /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*>/i) ||
    extractFirstMatch(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i);
  const headings = extractHeadings(html);
  const bodyExcerpt = stripTags(html).slice(0, MAX_WEBSITE_TEXT_LENGTH);

  return {
    url,
    title,
    metaDescription,
    headings,
    bodyExcerpt,
  };
}

function buildSystemPrompt(keywordCount: number): string {
  return `You are generating Reddit search queries for a founder who wants to find potential paying users.

The user will provide either:
- a SaaS or product URL
- a plain-English description of their product

Your job:
1. Understand what the product actually does
2. Infer the target customer and the pain/problem it solves
3. Generate exactly ${keywordCount} FINAL Reddit search queries that are most likely to surface people who need that product

Important:
- For URL inputs, rely heavily on the provided website content
- Prioritize the problem/use case over the brand name
- Include brand/competitor searches only when they are genuinely useful
- Focus on buyer-intent, pain, alternatives, recommendations, workflow frustration, and active solution seeking
- Queries should be short and realistic for Reddit search
- Usually 2 to 6 words
- No quotation marks
- No hashtags
- No long sentences
- No generic category fluff
- Avoid single-topic queries that match generic discussion (e.g. avoid "social media" or "AI" alone; prefer "looking for social media scheduler", "need AI headshot tool")

Good query styles:
- mailchimp expensive
- looking for crm
- need scheduling software
- best tool for cold email
- tired of manual invoicing
- alternative to hubspot

Return JSON only in this exact shape:
{
  "product_summary": "short summary",
  "target_customer": "short summary",
  "problem_solved": "short summary",
  "keywords": ["query1", "query2"]
}`;
}

function buildUserPrompt(userInput: string, keywordCount: number, websiteContext: WebsiteContext | null): string {
  if (!websiteContext) {
    return `Input type: product description

Original input:
"${userInput.trim()}"

Generate exactly ${keywordCount} final Reddit search queries to find people who would pay for this product.`;
  }

  return `Input type: website URL

Original input:
"${userInput.trim()}"

Website URL:
${websiteContext.url}

Website title:
${websiteContext.title || "(none)"}

Meta description:
${websiteContext.metaDescription || "(none)"}

Headings:
${websiteContext.headings.length > 0 ? websiteContext.headings.map((heading) => `- ${heading}`).join("\n") : "- (none)"}

Website copy excerpt:
${websiteContext.bodyExcerpt || "(none)"}

Generate exactly ${keywordCount} final Reddit search queries to find people who would pay for this product.`;
}

interface ParsedKeywordResponse {
  keywords: string[];
  productSummary?: string;
}

function parseKeywordsResponse(content: string, maxKeywords: number): ParsedKeywordResponse {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  const parsed = JSON.parse(jsonStr) as {
    keywords?: string[];
    product_summary?: string;
    problem_solved?: string;
  };
  const list = parsed?.keywords ?? (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(list)) throw new Error("Expected keywords array");
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const item of list) {
    if (typeof item !== "string") continue;
    const normalized = normalizeSearchQuery(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= maxKeywords) break;
  }

  const productSummary =
    typeof parsed?.product_summary === "string" && parsed.product_summary.trim()
      ? parsed.product_summary.trim().slice(0, 500)
      : undefined;

  return { keywords: deduped, productSummary };
}

export interface KeywordResult {
  keywords: string[];
  productSummary?: string;
}

/**
 * Returns final Reddit search queries and optional product summary for the given user input.
 * URL inputs are enriched with website content first. Uses OPENAI_API_KEY from env.
 */
export async function getKeywordsForInput(
  userInput: string,
  keywordCount: number = DEFAULT_KEYWORD_COUNT
): Promise<KeywordResult> {
  const key = requireOpenAIKey();
  let websiteContext: WebsiteContext | null = null;

  try {
    websiteContext = await fetchWebsiteContext(userInput);
  } catch (err) {
    console.warn("Website analysis fallback:", err instanceof Error ? err.message : err);
  }

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
        { role: "user", content: buildUserPrompt(userInput, keywordCount, websiteContext) },
      ],
      temperature: 0.2,
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

  const { keywords, productSummary } = parseKeywordsResponse(content, keywordCount);
  if (keywords.length === 0) throw new Error("OpenAI returned no valid keywords");
  return { keywords: keywords.slice(0, keywordCount), productSummary };
}
