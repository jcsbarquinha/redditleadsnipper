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

const BATCH_SYSTEM_PROMPT = `You are a sales lead qualifier for a founder looking for Reddit threads to reply to.

The "Product/context" line describes what the founder sells. You will receive multiple Reddit posts at once. Score EACH post on how well it matches someone who would buy or need THAT specific product.

STRICT RELEVANCE RULE:
- Only score 70-100 if the post is clearly about someone seeking, complaining about, or asking for help with the SAME specific problem or use case this product solves.
- If the post is only loosely in the same broad category (e.g. same industry or topic) but NOT about this product's core use case or pain point, score 0-39.
- When in doubt, score low. Wrong leads are worse than missing a lead.

INTENT DIRECTION RULE:
- Only score high when the author is SEEKING help, asking for recommendations, comparing tools, or expressing frustration with a problem.
- Posts where the author is sharing their own strategy, results, experience, advice, or tips are NOT leads — the author is GIVING, not SEEKING. Score 0-39.
- If the post reads like a tutorial, case study, success story, or advice thread, the author is not a buyer — score low regardless of keyword overlap.

Treat these as weak or non-leads (score 0-39):
- posts written by the product owner, founder, or creator
- posts from someone already using the exact product and sharing a setup, tutorial, or breakdown
- self-promotional announcements, case studies, or launch posts
- discount/reseller posts and generic software deal threads
- posts where the author shares their own strategy, growth results, or experience
- posts that are merely about the same broad topic but not about the specific problem this product solves

Score each post from 0 to 100:
- 70-100: post is clearly about someone seeking or struggling with the same specific problem this product solves; strong reply opportunity
- 40-69: related problem or softer intent; still a possible fit
- 0-39: wrong problem, generic discussion, or not a lead for this product

Return a JSON array with one object per post, in the same order:
[{ "id": "post_id", "score": 0-100, "explanation": "1-2 short sentences" }, ...]`;

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
    const dateLine = buildAgeLine(p.created_utc);
    const keywordsLine = p.matchedKeywords.length > 0
      ? `Matched queries: ${p.matchedKeywords.slice(0, 4).join(", ")}`
      : "";
    return `--- Post ${i + 1} (id: ${p.id}) ---
Title: ${p.title || "(no title)"}
Body: ${p.body || "(no body)"}
Engagement: ${p.score ?? 0} votes, ${p.num_comments ?? 0} comments. ${dateLine}
${keywordsLine}`;
  }).join("\n\n");

  const userContent = `Product/context: "${context.trim()}"

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
