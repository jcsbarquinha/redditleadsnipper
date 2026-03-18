/**
 * AI intent: batch post-centric lead scoring via OpenAI.
 */

import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

export type IntentLabel = "high" | "medium" | "low";

export interface PostIntentResult {
  score: number;
  label: IntentLabel;
  is_high_intent: boolean;
  explanation: string | null;
  suggested_reply: string | null;
}

const BATCH_SYSTEM_PROMPT = `You are qualifying B2B sales leads from Reddit posts.

You will be given ONLY:
1) The product description and the problem it solves.
2) Each Reddit post's content (title + body).

For each post, decide whether the author is actually seeking a solution in the product category described above.
If they are only discussing related topics, asking about something else, or asking to evaluate "legit/scam/safe", then score low.

Scoring rubric (0-100):
- 90-100: Clearly seeking a recommendation / solution for this product category.
- 70-89: Clear problem match and open to solutions/recommendations (less direct than above).
- 40-69: Some relevance to the problem, but weak/indirect seeking intent.
- 0-39: Not seeking this solution (general discussion, wrong intent, or evaluating legitimacy/scam/safety instead).

Return JSON only as an array with one object per post in the same order.
Each object must be:
{
  "id": "post_id",
  "score": 0-100,
  "explanation": "1 short sentence (why this is or isn't seeking a solution)",
  "suggested_reply": "optional; one short reply line for scores 70+, otherwise null"
}`;

function buildAgeLine(createdUtc?: number | null): string {
  if (createdUtc == null || !Number.isFinite(createdUtc)) return "";
  const d = new Date(createdUtc * 1000);
  const iso = d.toISOString().slice(0, 10);
  const now = Date.now() / 1000;
  const daysAgo = Math.floor((now - createdUtc) / 86400);
  const ageStr = daysAgo < 30
    ? `${daysAgo}d ago`
    : daysAgo < 365
      ? `${Math.floor(daysAgo / 30)}mo ago`
      : `${(daysAgo / 365).toFixed(1)}y ago`;
  return `${iso} (${ageStr})`;
}

function scoreToLabel(score: number): IntentLabel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function isHighIntent(score: number): boolean {
  return score > 70;
}

export interface BatchPostInput {
  id: string;
  title: string;
  body: string;
  score: number | null;
  num_comments: number | null;
  created_utc?: number | null;
  matchedKeywords: string[];
}

function parseBatchResponse(content: string, postIds: string[]): (PostIntentResult | null)[] {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();

  const parsed = JSON.parse(jsonStr) as Array<{
    id?: string;
    score?: number;
    explanation?: string;
    suggested_reply?: string;
  }>;

  if (!Array.isArray(parsed)) throw new Error("Expected JSON array from batch response");

  const byId = new Map<string, PostIntentResult>();
  for (const item of parsed) {
    const id = String(item.id ?? "");
    let score = Number(item.score);
    if (Number.isNaN(score) || score < 0) score = 0;
    if (score > 100) score = 100;
    const explanation =
      typeof item.explanation === "string" && item.explanation.trim()
        ? item.explanation.trim().slice(0, 700)
        : null;
    const suggested_reply =
      typeof item.suggested_reply === "string" && item.suggested_reply.trim()
        ? item.suggested_reply.trim().slice(0, 2000)
        : null;
    byId.set(id, {
      score,
      label: scoreToLabel(score),
      is_high_intent: isHighIntent(score),
      explanation,
      suggested_reply,
    });
  }

  return postIds.map((id) => byId.get(id) ?? null);
}

export async function classifyPostIntentBatch(
  context: string,
  posts: BatchPostInput[]
): Promise<(PostIntentResult | null)[]> {
  const key = requireOpenAIKey();

  const postsBlock = posts.map((p, i) => {
    return `--- Post ${i + 1} (id: ${p.id}) ---
Title: ${p.title || "(no title)"}
Body: ${p.body || "(no body)"}`;
  }).join("\n\n");

  const userContent = `Product description (what it does and what problem it solves):

${context.trim()}

${postsBlock}

Score all ${posts.length} posts. Return JSON array only.`;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: BATCH_SYSTEM_PROMPT },
        { role: "user", content: userContent },
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

  return parseBatchResponse(content, posts.map((p) => p.id));
}
