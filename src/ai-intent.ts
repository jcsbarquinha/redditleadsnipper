/**
 * AI intent: one rating (0-100) per post, using the full post + comments as context.
 */

import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";

/** Max total characters for comments to stay within context. */
const MAX_COMMENTS_CHARS = 4000;

export type IntentLabel = "high" | "medium" | "low";

export interface PostIntentResult {
  /** 0-100 buying intent score. */
  score: number;
  /** Derived from score: high >= 70, medium 40-69, low < 40. */
  label: IntentLabel;
  /** True when score > 70 (per PRD). */
  is_high_intent: boolean;
  /** One-sentence summary of the user's pain point (per PRD). */
  explanation: string | null;
  /** Drafted reply for the founder to copy-paste (per PRD). */
  suggested_reply: string | null;
}

const SYSTEM_PROMPT = `You are a sales lead qualifier. Given a product/context and a Reddit post (title + body) plus its comments and the post date, you must return a structured response.

1. Rate the overall buying intent of the thread from 0 to 100.
   - 70-100: strong intent (actively looking, comparing tools, "which one should I get?", frustrated with current solution)
   - 40-69: some intent (interested, asking for recommendations)
   - 0-39: low/no intent (casual mention, off-topic, no purchase intent)
   Consider recency: very old posts are more likely stale leads—downscore them unless intent is clearly still relevant.

2. explanation: One short sentence summarizing the user's specific pain point or what they are looking for.

3. suggested_reply: A drafted, high-value, non-spammy reply (2-4 sentences) that a founder could copy-paste to engage this lead. Be helpful and personal, not salesy. Do not use placeholders like [Product Name]—write as if the founder knows their own product.

Reply with JSON only, no markdown. Use this exact shape:
{ "score": 0-100, "explanation": "one sentence", "suggested_reply": "drafted reply text" }`;

function scoreToLabel(score: number): IntentLabel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

/** is_high_intent = score > 70 (per PRD). */
function isHighIntent(score: number): boolean {
  return score > 70;
}

function parseIntentResponse(content: string): PostIntentResult {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  const parsed = JSON.parse(jsonStr) as { score?: number; explanation?: string; suggested_reply?: string };
  let score = Number(parsed.score);
  if (Number.isNaN(score) || score < 0) score = 0;
  if (score > 100) score = 100;
  const explanation =
    typeof parsed.explanation === "string" && parsed.explanation.trim()
      ? parsed.explanation.trim().slice(0, 500)
      : null;
  const suggested_reply =
    typeof parsed.suggested_reply === "string" && parsed.suggested_reply.trim()
      ? parsed.suggested_reply.trim().slice(0, 2000)
      : null;
  return {
    score,
    label: scoreToLabel(score),
    is_high_intent: isHighIntent(score),
    explanation,
    suggested_reply,
  };
}

/**
 * Classify buying intent for the whole post + comments in one call. Returns a single score 0-100.
 * Pass createdUtc (Unix seconds) so the model can factor post recency into the score.
 */
export async function classifyPostWithComments(
  context: string,
  title: string | null,
  selftext: string,
  commentBodies: string[],
  createdUtc?: number | null
): Promise<PostIntentResult> {
  const key = requireOpenAIKey();
  const titleStr = (title ?? "").trim().slice(0, 500);
  const bodyStr = (selftext ?? "").trim().slice(0, 2000);
  let commentsStr = commentBodies
    .map((b) => (b ?? "").trim())
    .filter(Boolean)
    .join("\n---\n");
  if (commentsStr.length > MAX_COMMENTS_CHARS) {
    commentsStr = commentsStr.slice(0, MAX_COMMENTS_CHARS) + "\n... (truncated)";
  }

  let dateLine = "";
  if (createdUtc != null && Number.isFinite(createdUtc)) {
    const d = new Date(createdUtc * 1000);
    const iso = d.toISOString().slice(0, 10);
    const now = Date.now() / 1000;
    const daysAgo = Math.floor((now - createdUtc) / 86400);
    const ageStr = daysAgo < 30 ? `${daysAgo}d ago` : daysAgo < 365 ? `${Math.floor(daysAgo / 30)}mo ago` : `${(daysAgo / 365).toFixed(1)}y ago`;
    dateLine = `\nPost date: ${iso} (${ageStr}). `;
  }

  const userContent = `Product/context: "${context.trim()}"${dateLine}

Reddit POST
Title: ${titleStr || "(no title)"}
Body: ${bodyStr || "(no body)"}

Comments:
${commentsStr || "(no comments)"}

Rate overall buying intent 0-100 and provide explanation and suggested_reply. JSON only: { "score": number, "explanation": "one sentence", "suggested_reply": "drafted reply" }`;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(20_000),
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

  return parseIntentResponse(content);
}
