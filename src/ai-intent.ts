/**
 * AI intent: post-centric lead scoring, with optional top-post comment enrichment.
 */

import { requireOpenAIKey } from "./config.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-4o-mini";
const MAX_COMMENTS_CHARS = 4000;

export type IntentLabel = "high" | "medium" | "low";

export interface PostIntentResult {
  score: number;
  label: IntentLabel;
  is_high_intent: boolean;
  explanation: string | null;
  suggested_reply: string | null;
}

const POST_CENTRIC_SYSTEM_PROMPT = `You are a sales lead qualifier for a founder looking for Reddit threads to reply to.

The "Product/context" line describes what the founder sells. Your job is to score only how well this Reddit post matches someone who would buy or need THAT specific product.

STRICT RELEVANCE RULE:
- Only score 70-100 if the post is clearly about someone seeking, complaining about, or asking for help with the SAME specific problem or use case this product solves.
- If the post is only loosely in the same broad category (e.g. same industry or topic) but NOT about this product's core use case or pain point, score 0-39.
- When in doubt, score low. Wrong leads are worse than missing a lead.

Prioritize the ORIGINAL POST. Title and body are the primary signal; engagement and freshness are secondary.

Treat these as weak or non-leads (score 0-39):
- posts written by the product owner, founder, or creator
- posts from someone already using the exact product and sharing a setup, tutorial, or breakdown
- self-promotional announcements, case studies, or launch posts
- discount/reseller posts and generic software deal threads
- posts that are merely about the same broad topic (e.g. "social media" or "AI") but not about the specific problem this product solves

Score the post from 0 to 100:
- 70-100: post is clearly about someone seeking or struggling with the same specific problem this product solves; strong reply opportunity
- 40-69: related problem or softer intent; still a possible fit
- 0-39: wrong problem, generic discussion, or not a lead for this product

Return JSON only:
{ "score": 0-100, "explanation": "1-2 short sentences on why this post is a promising lead" }`;

const COMMENT_ENRICHMENT_PROMPT = `You are summarizing why a Reddit thread is worth replying to.

The explanation must stay POST-CENTRIC:
- focus first on the original post's pain point or buying intent
- use comments only as supporting evidence
- mention comments only if they validate the same pain point, add urgency, or show the thread has active eyeballs
- keep it concise and specific

Return JSON only:
{ "explanation": "1-2 short sentences" }`;

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
  return `Post date: ${iso} (${ageStr}).`;
}

function scoreToLabel(score: number): IntentLabel {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

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
      ? parsed.explanation.trim().slice(0, 700)
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

function parseExplanationResponse(content: string): string | null {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  const parsed = JSON.parse(jsonStr) as { explanation?: string };
  if (typeof parsed.explanation !== "string") return null;
  const explanation = parsed.explanation.trim();
  return explanation ? explanation.slice(0, 700) : null;
}

export async function classifyPostIntent(
  context: string,
  title: string | null,
  selftext: string,
  postScore: number | null,
  numComments: number | null,
  createdUtc?: number | null,
  matchedKeywords: string[] = []
): Promise<PostIntentResult> {
  const key = requireOpenAIKey();
  const titleStr = (title ?? "").trim().slice(0, 500);
  const bodyStr = (selftext ?? "").trim().slice(0, 2000);
  const dateLine = buildAgeLine(createdUtc);
  const keywordsLine = matchedKeywords.length > 0
    ? `Matched Reddit search phrases: ${matchedKeywords.slice(0, 6).join(", ")}.`
    : "";

  const userContent = `Product/context: "${context.trim()}"
${dateLine}
Engagement: ${postScore ?? 0} votes, ${numComments ?? 0} comments.
${keywordsLine}

Reddit POST
Title: ${titleStr || "(no title)"}
Body: ${bodyStr || "(no body)"}

Return JSON only: { "score": number, "explanation": "1-2 short sentences" }`;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: POST_CENTRIC_SYSTEM_PROMPT },
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

export async function explainPostWithComments(
  context: string,
  title: string | null,
  selftext: string,
  commentBodies: string[],
  createdUtc?: number | null
): Promise<string | null> {
  const key = requireOpenAIKey();
  const titleStr = (title ?? "").trim().slice(0, 500);
  const bodyStr = (selftext ?? "").trim().slice(0, 2000);
  const dateLine = buildAgeLine(createdUtc);
  let commentsStr = commentBodies
    .map((b) => (b ?? "").trim())
    .filter(Boolean)
    .join("\n---\n");
  if (commentsStr.length > MAX_COMMENTS_CHARS) {
    commentsStr = commentsStr.slice(0, MAX_COMMENTS_CHARS) + "\n... (truncated)";
  }

  const userContent = `Product/context: "${context.trim()}"
${dateLine}

Original Reddit post
Title: ${titleStr || "(no title)"}
Body: ${bodyStr || "(no body)"}

Comments:
${commentsStr || "(no comments)"}

Return JSON only: { "explanation": "1-2 short sentences" }`;

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: COMMENT_ENRICHMENT_PROMPT },
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
  if (!content) throw new Error("OpenAI returned no enrichment explanation");

  return parseExplanationResponse(content);
}
