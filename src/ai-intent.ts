/**
 * AI intent: batch post-centric lead scoring via OpenAI.
 */

import { requireOpenAIKey } from "./config.js";
import { fetchOpenAIChat } from "./openai-fetch.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL_BOUNCER = "gpt-4o-mini";
const MODEL_CLOSER = "gpt-4o";
/** Mini scores above this go to gpt-4o for final score / explanation / suggested_reply. */
const CLOSER_THRESHOLD_MINI_SCORE = 50;

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
3) A batch of Reddit posts: title, body, unique id, and optional metadata (matched search queries, Reddit upvotes, comment count, post age)

Core task:
For EACH post independently, score how strong a lead they are for THIS product. The PRIMARY signal is always the post text plus the product context. Metadata is supplementary only.

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

Optional metadata (secondary only—intent stays primary):
- Matched search queries: Show which searches surfaced this thread (e.g. pain/alternative vs brand). Use as context for why it appeared; they do not replace reading the post or override a clear read of the body.
- Reddit upvotes and comment count: Weak hints about visibility or discussion. Low or zero engagement is common for niche subs or fresh posts—do NOT treat it as a bad lead by itself. Never use popularity to raise the score for a post that is clearly not seeking a solution. If and only if buying intent is borderline or ambiguous, you may use slightly higher engagement as a small tie-breaker toward the same score band; do not use engagement to jump bands (e.g. from medium to high).

Scoring rubric (0-100):
- 90-100: Exact, explicit match. The author is clearly looking for THIS exact type of solution OR clearly facing the exact core problem this product solves right now. Reserve for strongest opportunities only.
- 70-89: Strong match. The post is clearly in the same solution/problem space and likely actionable, but less explicit or less immediate than 90+.
- 40-69: Partial/adjacent match, mixed intent, generic advice-seeking, or insufficient evidence of concrete solution-seeking.
- 0-39: Wrong fit, unrelated problem, negative signals dominate, or non-buyer context (hiring/pitch/scam-check/etc).

Hard rule for high scores:
- Do NOT give 90+ unless the post text shows an explicit exact problem/solution match.
- If key context is missing or inferred, keep the score at or below 89.

Examples (calibration—same rubric as above):

Example A — False positive (target band ~40–50):
Title: "How do I grow my SaaS faster?"
Body: "Been at it 6 months. Tried content and ads. Feeling stuck. What's the playbook people actually use?"
Why this scores ~45: Broad growth/strategy venting without asking for a specific tool, vendor, or alternative. Adjacent to many B2B products but no concrete solution-seeking—keep in the partial/medium-lower band, not high intent.

Example B — True positive (target band ~80–90):
Title: "Need a lightweight CRM for a 3-person agency — spreadsheets are killing us"
Body: "We outgrew Google Sheets for follow-ups. Looking for something under $50/mo with simple pipelines. What do you actually use?"
Why this scores ~85: Explicit buyer intent, clear problem, asking for real tools in the CRM/workspace—strong match if the product is that category; reserve 90+ only if the text is an even tighter fit to THIS product's exact wedge.

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
    "suggested_reply": "one short, highly organic Reddit reply for scores >= 70. MUST NOT sound like a sales pitch or AI bot. Start by directly answering their question or validating their problem, then softly mention the product as a relevant resource. If score < 70, return null. Choose the score from the post and product fit alone—do not raise a score just to justify a reply."
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

function buildPostsBlock(posts: BatchPostInput[]): string {
  return posts
    .map((p, i) => {
      const kw =
        p.matchedKeywords && p.matchedKeywords.length > 0
          ? p.matchedKeywords.map((k) => k.trim()).filter(Boolean).join("; ")
          : "(none)";
      const ups = p.score != null && Number.isFinite(Number(p.score)) ? String(p.score) : "unknown";
      const ncom =
        p.num_comments != null && Number.isFinite(Number(p.num_comments)) ? String(p.num_comments) : "unknown";
      const ageLine = buildAgeLine(p.created_utc);
      const ageDisplay = ageLine || "unknown";
      return `--- Post ${i + 1} (id: ${p.id}) ---
Matched search queries (why this post was retrieved): ${kw}
Reddit upvotes: ${ups} | Comments: ${ncom} | Post date: ${ageDisplay}
Title: ${p.title || "(no title)"}
Body: ${p.body || "(no body)"}`;
    })
    .join("\n\n");
}

async function classifyPostIntentBatchSingleModel(
  context: string,
  posts: BatchPostInput[],
  model: string
): Promise<(PostIntentResult | null)[]> {
  const key = requireOpenAIKey();
  const postsBlock = buildPostsBlock(posts);
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
        model,
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

export async function classifyPostIntentBatch(
  context: string,
  posts: BatchPostInput[]
): Promise<(PostIntentResult | null)[]> {
  const miniResults = await classifyPostIntentBatchSingleModel(context, posts, MODEL_BOUNCER);

  const closerPosts: BatchPostInput[] = [];
  const closerFromIndex: number[] = [];
  for (let i = 0; i < posts.length; i++) {
    const r = miniResults[i];
    if (r != null && r.score > CLOSER_THRESHOLD_MINI_SCORE) {
      closerPosts.push(posts[i]);
      closerFromIndex.push(i);
    }
  }

  if (closerPosts.length === 0) {
    return miniResults;
  }

  try {
    const closerResults = await classifyPostIntentBatchSingleModel(context, closerPosts, MODEL_CLOSER);
    const merged = [...miniResults];
    for (let j = 0; j < closerPosts.length; j++) {
      const r4 = closerResults[j];
      const orig = closerFromIndex[j];
      if (r4 != null) merged[orig] = r4;
    }
    return merged;
  } catch {
    return miniResults;
  }
}
