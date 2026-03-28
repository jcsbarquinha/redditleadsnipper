/**
 * AI intent: batch post-centric lead scoring via OpenAI.
 */

import { requireOpenAIKey } from "./config.js";
import { fetchOpenAIChat } from "./openai-fetch.js";

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

const BATCH_SYSTEM_PROMPT = `You are qualifying sales leads from Reddit posts.

You will be given:
1) What the product does
2) What problem it solves
3) A batch of Reddit posts (title + body), each with a unique id

Core task:
For EACH post independently, score how strong a lead they are for THIS product, using only the post text and the product context above.

Important principles:
- Evaluate each post independently. Do not compare posts to each other.
- Use only the provided product context + post content. Do not invent facts.
- Be conservative. If intent or match is unclear, score lower.
- The score is about PROBLEM/SOLUTION MATCH, not demographic persona fit.
- Prioritize explicit intent in the post text over assumptions.
- If a post is about legitimacy/scam/safety checks rather than solving the product problem, score low.
- Disregard or score very low (typically 0–39) posts that are primarily hiring, recruiting, or job postings unless the product explicitly serves hiring or recruiting workflows.
- If the author is selling/pitching their own service/product (e.g. "for hire", "DM me", "book with us", "try our tool"), score low unless they are clearly asking for a tool recommendation as a buyer.
- Strategy-only discussions ("how to improve X" in general) without clear tool/vendor seeking should not score as high intent.

Scoring rubric (0-100):
- 90-100: Exact, explicit match. The author is clearly looking for THIS exact type of solution OR clearly facing the exact core problem this product solves right now. Reserve for strongest opportunities only.
- 70-89: Strong match. The post is clearly in the same solution/problem space and likely actionable, but less explicit or less immediate than 90+.
- 40-69: Partial/adjacent match, mixed intent, generic advice-seeking, or insufficient evidence of concrete solution-seeking.
- 0-39: Wrong fit, unrelated problem, negative signals dominate, or non-buyer context (hiring/pitch/scam-check/etc).

Hard rule for high scores:
- Do NOT give 90+ unless the post text shows an explicit exact problem/solution match.
- If key context is missing or inferred, keep the score at or below 89.

Output requirements (STRICT):
- Return JSON only (no markdown, no prose).
- Return exactly one object per input post id.
- Include all and only the provided ids.
- Preserve id values exactly.
- Array order must match input order.

Output schema:
[
  {
    "id": "post_id",
    "score": 0-100,
    "explanation": "one short sentence explaining the score",
    "suggested_reply": "one short, highly organic Reddit reply for scores >= 70. MUST NOT sound like a sales pitch or AI bot. Start by directly answering their question or validating their problem, then softly mention the product as a relevant resource. If score < 70, return null."
  }
]`;

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
  if (parsed.length !== postIds.length) {
    throw new Error(`Expected ${postIds.length} results, got ${parsed.length}`);
  }

  const byId = new Map<string, PostIntentResult>();
  const inputSet = new Set(postIds);
  for (const item of parsed) {
    const id = String(item.id ?? "");
    if (!inputSet.has(id)) {
      throw new Error(`Unexpected id in response: ${id}`);
    }
    if (byId.has(id)) {
      throw new Error(`Duplicate id in response: ${id}`);
    }
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

  for (const id of postIds) {
    if (!byId.has(id)) throw new Error(`Missing id in response: ${id}`);
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

  const userContent = `Product context (what it does, problem it solves):

${context.trim()}

${postsBlock}

Return JSON only, exactly ${posts.length} objects, matching ids and order.`;

  async function requestBatch(extraStrictLine?: string): Promise<(PostIntentResult | null)[]> {
    const res = await fetchOpenAIChat(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: BATCH_SYSTEM_PROMPT },
          {
            role: "user",
            content: extraStrictLine
              ? `${userContent}\n\n${extraStrictLine}`
              : userContent,
          },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120_000),
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

  try {
    return await requestBatch();
  } catch (firstErr) {
    return requestBatch(
      "CRITICAL: Return valid JSON only. Keep exactly one item per provided id, in the same order, with no extra or missing ids."
    ).catch(() => {
      throw firstErr;
    });
  }
}
