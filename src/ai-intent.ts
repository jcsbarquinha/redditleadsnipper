/**
 * AI intent: batch post-centric lead scoring via OpenAI.
 */

import { requireOpenAIKey } from "./config.js";
import { fetchOpenAIChat } from "./openai-fetch.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL_INTENT = "gpt-4o";
const MODEL_MINI_SCREEN = "gpt-4o-mini";
const OPENAI_INTENT_TIMEOUT_MS = Number(process.env.OPENAI_INTENT_TIMEOUT_MS || 180_000);
const OPENAI_INTENT_TIMEOUT_RETRIES = 2;

/** Homepage lightning triage: id + score only; full intent runs on 4o for finalists. */
const LIGHTNING_MINI_SYSTEM_PROMPT = `You are a lightning-fast sales prospector. Your only job is to rapidly triage Reddit posts to find potential leads for a SaaS product.

You will be given:
1) What the product does
2) What problem it solves
3) A batch of Reddit posts (id, title, body)

Core task:
Assign a 0-100 score to each post based on its potential as a lead.

CRITICAL PRINCIPLES (BE OPTIMISTIC BUT AVOID SELLERS):
- Score on PROBLEM MATCH. If they are complaining about the exact pain point this product solves, score them 70+.
- THE "AUTHOR IDENTITY" CHECK: Is the author looking for a solution, or selling one? If the author is explicitly pitching, launching, or selling a tool they built that solves the problem, hard-cap their score at 50. We want buyers, not sellers.
- SELLER SIGNALS (strong clues): "for hire", "I built", "we built", "my service", "our service", "launching", "available for work", "$/hr", "DM me", "portfolio", "book a call".
- CAP RULE (STRICT): If seller signals are present, score must be <= 50 even if problem-match is strong.
- THE "NATIVE AD" CHECK: If the post is a glowing, overly positive success story about how one specific tool "changed their life" or "solved everything" (often with a link), score it 0-39. This is a disguised ad.
- BRAND MENTIONS ARE GOOD: Do NOT penalize a post just because it names a software tool. If they are asking *if* a tool is good, complaining about a tool, or asking for alternatives, that is a HOT LEAD (80+).

Scoring Rubric:
- 80-100: Active buyer, explicitly stating the core problem, or asking for an alternative to a competitor.
- 70-79: Venting about related workflows or adjacent pain points.
- 40-50: The Competitor Pitch. The author is launching or selling their own competing product (Warm, but not a direct buyer).
- 51-69: Adjacent interest, general industry talk, no clear personal pain point.
- 0-39: Wrong fit, unrelated, pure spam, or a glowing disguised ad for another product.

Output requirements (STRICT):
- Return JSON only.
- Return exactly one object per input post id in the exact order provided.
- NO extra fields. Just id and score. DO NOT generate explanations.

Output schema:
[
  {
    "id": "post_id",
    "score": 0-100
  }
]`;

export type IntentLabel = "high" | "medium" | "low";

export interface PostIntentResult {
  score: number;
  label: IntentLabel;
  is_high_intent: boolean;
  explanation: string | null;
  suggested_reply: string | null;
}

const BATCH_SYSTEM_PROMPT = `You are an expert social selling strategist and opportunistic sales prospector.
You are qualifying sales leads from Reddit posts.

You will be given:
1) What the product does
2) What problem it solves
3) A batch of Reddit posts: title, body, unique id, and optional metadata.

Core task:
For EACH post independently, score how strong a lead they are for THIS product.

CRITICAL PRINCIPLES:
- PROBLEM MATCH IS KING: A user does NOT need to be asking for a software tool to be a high-intent lead. If they are complaining about the exact pain point this product solves, they are a HOT lead (70+).
- THE "AUTHOR IDENTITY" RULE (BUYER VS SELLER): Check who is writing the post. If the author built, sells, or is launching a product that does exactly what our product does, they are NOT a hot lead.
- SELLER SIGNALS (strong clues): "for hire", "I built", "we built", "my service", "our service", "launching", "available for work", "$/hr", "DM me", "portfolio", "book a call".
- CAP RULE (STRICT): If seller signals are present, score must be <= 50 even when problem-match is strong.
- THE "WATERING HOLE" RULE: If a user mentions a competitor but is complaining about it, comparing it, or asking for neutral opinions on it, SCORE IT HIGH (80+). Do not confuse a genuine question about a brand with a disguised ad.
- THE "NATIVE AD" FILTER: Disregard (0-39) disguised native ads. These read like glowing success stories heavily promoting a single named vendor ("I struggled until a friend told me about X, it's amazing!").

Scoring Rubric (0-100):
- 90-100 (Screaming Pain / Active Buyer): The author is explicitly asking for a tool recommendation, begging for an alternative to a competitor, or experiencing a critical bottleneck that this product perfectly solves.
- 70-89 (Strong Problem Match): The author is venting about a workflow or asking for strategy advice related to the problem this product addresses. They might not know a software solution exists yet, but they NEED it.
- 40-50 (The Competitor Pitch): The author is launching, pitching, or selling a tool that solves the problem. They are a seller, not a buyer.
- 51-69 (Adjacent / Weak): General industry talk, no clear personal pain point.
- 0-39 (Trash): Wrong fit, unrelated, spam, or a glowing disguised advertisement for another tool.

Examples (Calibration):

Example A — The "Unaware but Bleeding" Lead (Target band: 80-89):
Title: "How do I grow my SaaS faster? Spreadsheets for outreach aren't scaling."
Body: "Been at it 6 months. Tried content and ads. Feeling stuck with manual cold email tracking. What's the playbook people actually use?"
Why this scores ~85: Explicit statement of the exact pain point a Cold Email/CRM SaaS solves. Highly actionable.

Example B — The "Active Shopper" Lead (Target band: 90-100):
Title: "Need a lightweight CRM for a 3-person agency — Hubspot is too heavy"
Body: "Looking for something under $50/mo with simple pipelines. What do you actually use?"
Why this scores ~95: Explicit buyer intent, naming a competitor they dislike. Perfect match.

Output requirements (STRICT):
- Return JSON only (no markdown, no prose).
- Return exactly one object per input post id in the exact order provided.
- Preserve id values exactly.

Output schema:
[
  {
    "id": "post_id",
    "score": 0-100,
    "explanation": "One short sentence explaining why they have the problem this product solves.",
    "suggested_reply": "For scores >= 70, write a highly organic, conversational Reddit reply. Format: 1) Validate their specific pain/question like a peer. 2) Share a brief piece of actual advice. 3) Softly mention the product as a relevant resource. If score < 70, return null."
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

function parseMiniScreenResponse(content: string, postIds: string[]): Map<string, number> {
  const trimmed = content.trim();
  let jsonStr = trimmed;
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) jsonStr = codeBlock[1].trim();
  const parsed = JSON.parse(jsonStr) as Array<{ id?: string; score?: unknown }>;

  if (!Array.isArray(parsed)) throw new Error("Expected JSON array from mini screen response");
  const inputSet = new Set(postIds);
  const byId = new Map<string, number>();
  let skippedUnknownIds = 0;
  for (const item of parsed) {
    const id = String(item?.id ?? "");
    if (!id || !inputSet.has(id)) {
      if (id && !inputSet.has(id)) skippedUnknownIds += 1;
      continue;
    }
    let s = Number(item?.score);
    if (Number.isNaN(s) || s < 0) s = 0;
    if (s > 100) s = 100;
    const rounded = Math.round(s);
    const prev = byId.get(id);
    // Mini model sometimes repeats an id; keep worst-case cover with max score, then backfill missing ids below.
    byId.set(id, prev === undefined ? rounded : Math.max(prev, rounded));
  }
  let backfilledIds = 0;
  for (const id of postIds) {
    if (!byId.has(id)) {
      byId.set(id, 0);
      backfilledIds += 1;
    }
  }
  if (parsed.length !== postIds.length || backfilledIds > 0 || skippedUnknownIds > 0) {
    console.warn(
      JSON.stringify({
        event: "mini_screen_parse_adjusted",
        expectedIds: postIds.length,
        responseArrayLength: parsed.length,
        backfilledIds,
        skippedUnknownIds,
      })
    );
  }
  return byId;
}

async function classifyLightningMiniBatch(context: string, posts: BatchPostInput[]): Promise<Map<string, number>> {
  const key = requireOpenAIKey();
  const postsBlock = buildPostsBlock(posts);
  const userContent = `Product context (what the product does and problem it solves):

${context.trim()}

${postsBlock}

Return JSON only: exactly ${posts.length} objects, one per post, keys only "id" and "score".`;

  async function fire(extra?: string): Promise<Map<string, number>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < OPENAI_INTENT_TIMEOUT_RETRIES; attempt++) {
      try {
        const res = await fetchOpenAIChat(OPENAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: MODEL_MINI_SCREEN,
            messages: [
              { role: "system", content: LIGHTNING_MINI_SYSTEM_PROMPT },
              {
                role: "user",
                content: extra ? `${userContent}\n\n${extra}` : userContent,
              },
            ],
            temperature: 0.15,
          }),
          signal: AbortSignal.timeout(OPENAI_INTENT_TIMEOUT_MS),
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
        if (!content) throw new Error("OpenAI returned no lightning mini content");
        return parseMiniScreenResponse(content, posts.map((p) => p.id));
      } catch (err) {
        lastErr = err;
        const text = err instanceof Error ? err.message : String(err);
        const timeoutLike = /aborted|timeout/i.test(text);
        if (!timeoutLike || attempt >= OPENAI_INTENT_TIMEOUT_RETRIES - 1) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  try {
    return await fire();
  } catch (firstErr) {
    return fire(
      "CRITICAL: Valid JSON array only. Each item: { \"id\": \"...\", \"score\": number }. All ids exactly as given, no extras."
    ).catch(() => {
      throw firstErr;
    });
  }
}

/** Chunk size for parallel lightning-mini API calls. */
export const LIGHTNING_MINI_CHUNK = 10;
/** Concurrent lightning-mini requests per wave (lower if OpenAI returns 429). */
export const LIGHTNING_MINI_PARALLEL = 8;

/** Fast mini triage (id+score only), chunked and parallelized for homepage. */
export async function scorePostsLightningMini(context: string, posts: BatchPostInput[]): Promise<Map<string, number>> {
  const merged = new Map<string, number>();
  const chunks: BatchPostInput[][] = [];
  for (let i = 0; i < posts.length; i += LIGHTNING_MINI_CHUNK) {
    chunks.push(posts.slice(i, i + LIGHTNING_MINI_CHUNK));
  }
  for (let w = 0; w < chunks.length; w += LIGHTNING_MINI_PARALLEL) {
    const wave = chunks.slice(w, w + LIGHTNING_MINI_PARALLEL);
    const parts = await Promise.allSettled(wave.map((chunk) => classifyLightningMiniBatch(context, chunk)));
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.status === "fulfilled") {
        part.value.forEach((v, k) => merged.set(k, v));
      } else {
        const chunk = wave[i];
        console.warn("Mini gate chunk failed:", part.reason instanceof Error ? part.reason.message : part.reason);
        for (const post of chunk) merged.set(post.id, 0);
      }
    }
  }
  return merged;
}

function postIntentFromBatchItem(item: {
  id?: string;
  score?: number;
  explanation?: string;
  suggested_reply?: string;
}): PostIntentResult {
  let score = Number(item.score);
  if (Number.isNaN(score) || score < 0) score = 0;
  if (score > 100) score = 100;
  const rounded = Math.round(score);
  const explanation =
    typeof item.explanation === "string" && item.explanation.trim()
      ? item.explanation.trim().slice(0, 700)
      : null;
  const suggested_reply =
    typeof item.suggested_reply === "string" && item.suggested_reply.trim()
      ? item.suggested_reply.trim().slice(0, 2000)
      : null;
  return {
    score: rounded,
    label: scoreToLabel(rounded),
    is_high_intent: isHighIntent(rounded),
    explanation,
    suggested_reply,
  };
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
  const inputSet = new Set(postIds);
  let skippedUnknownIds = 0;
  for (const item of parsed) {
    const id = String(item.id ?? "");
    if (!id || !inputSet.has(id)) {
      if (id && !inputSet.has(id)) skippedUnknownIds += 1;
      continue;
    }
    const next = postIntentFromBatchItem(item);
    const prev = byId.get(id);
    if (prev === undefined) {
      byId.set(id, next);
    } else {
      byId.set(id, prev.score >= next.score ? prev : next);
    }
  }

  const missingIds = postIds.filter((pid) => !byId.has(pid)).length;
  if (parsed.length !== postIds.length || missingIds > 0 || skippedUnknownIds > 0) {
    console.warn(
      JSON.stringify({
        event: "intent_batch_parse_adjusted",
        expectedIds: postIds.length,
        responseArrayLength: parsed.length,
        missingIds,
        skippedUnknownIds,
      })
    );
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
    let lastErr: unknown;
    for (let attempt = 0; attempt < OPENAI_INTENT_TIMEOUT_RETRIES; attempt++) {
      try {
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
          signal: AbortSignal.timeout(OPENAI_INTENT_TIMEOUT_MS),
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
      } catch (err) {
        lastErr = err;
        const text = err instanceof Error ? err.message : String(err);
        const timeoutLike = /aborted|timeout/i.test(text);
        if (!timeoutLike || attempt >= OPENAI_INTENT_TIMEOUT_RETRIES - 1) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
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

async function classifyPostIntentBatchResilient(
  context: string,
  posts: BatchPostInput[],
  model: string,
  depth = 0
): Promise<(PostIntentResult | null)[]> {
  if (!posts.length) return [];
  try {
    return await classifyPostIntentBatchSingleModel(context, posts, model);
  } catch (err) {
    const maxDepth = 3;
    if (posts.length <= 1 || depth >= maxDepth) {
      console.warn(
        "Intent batch failed (returning nulls):",
        err instanceof Error ? err.message : err
      );
      return posts.map(() => null);
    }
    const mid = Math.ceil(posts.length / 2);
    const left = posts.slice(0, mid);
    const right = posts.slice(mid);
    const [leftRes, rightRes] = await Promise.all([
      classifyPostIntentBatchResilient(context, left, model, depth + 1),
      classifyPostIntentBatchResilient(context, right, model, depth + 1),
    ]);
    return [...leftRes, ...rightRes];
  }
}

export async function classifyPostIntentBatch(
  context: string,
  posts: BatchPostInput[]
): Promise<(PostIntentResult | null)[]> {
  return classifyPostIntentBatchResilient(context, posts, MODEL_INTENT);
}

/** Full intent prompt on mini model (used as a cheaper scorer). */
export async function classifyPostIntentBatchMini(
  context: string,
  posts: BatchPostInput[]
): Promise<(PostIntentResult | null)[]> {
  return classifyPostIntentBatchResilient(context, posts, MODEL_MINI_SCREEN);
}
