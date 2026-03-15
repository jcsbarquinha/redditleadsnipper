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

const BATCH_SYSTEM_PROMPT = `You are an expert B2B sales lead qualifier. Your job is to read Reddit posts and score them from 0 to 100 based on BUYER INTENT for a specific product.

The "Product Context" describes what the founder sells. You will evaluate multiple Reddit posts and score EACH post strictly on how likely the author is to buy or need THIS specific product.

CRITICAL RULE: Wrong leads are worse than missing a lead. When in doubt, score brutally low. Always read title AND body; if the body reveals self-promotion or the author as creator/launcher, the title cannot override it — score 0-20.

### THE "AUTO-FAIL" KILL LIST (ALWAYS SCORE 0-20)
If the post matches ANY of these criteria, it is NOT a lead. Score it 0-20 immediately:

1. FOR HIRE / AGENCIES: The author is a freelancer, agency, or job-seeker offering services or looking for work. (e.g. "Hire me as your social media manager", "[For Hire] Virtual Assistant", "open for new clients".)

2. BUILDER / COMPETITOR: The author is building or has built a product/tool in the same category. (e.g. "I'm building a …", "We built a …", "launching our own tool for X".) They are a competitor, not a customer.

3. GIVING, NOT SEEKING: The author is sharing a tutorial, case study, success story, their own strategy, or advice. They are teaching, not buying.

4. SELF-PROMOTION: The post is an announcement, a launch, or written by a founder/creator showing off their own tool. If the post contains phrases like "we launched", "our platform", "recently launched", "comment or dm for the link", "free to limited users" (when the author is offering their own tool), score 0-20. Consider the FULL post (title + body). If the body shows the author is the creator/launcher (e.g. "we are a team… recently launched", "I'll send the link"), score 0-20 even if the title sounds like a question or request.

5. ASTROTURFING (DISGUISED ADS): The author mentions a specific product with detailed pricing, features, or specs framed as a "question." (e.g., "Has anyone tried [Tool] for $29? It does X, Y, Z in 5 minutes!").

6. ALREADY SOLVED: The author explicitly states they have already found a solution they are happy with.

7. ACADEMIC/STUDENT: The author is asking for help with a school project, university assignment, or purely theoretical research.

### BRAND REJECTION CLARIFICATION
- If the Product Context IS a specific brand (e.g., "Le Creuset"), and the author wants an alternative to it ("brands cheaper than Le Creuset"), score 0-39.
- HOWEVER, if the Product Context is an ALTERNATIVE (e.g., "A cheaper alternative to Le Creuset"), and the author is complaining about Le Creuset, score 80-100.

### SCORING TIERS (BE STRICT)

🟢 90-100 (HOT BUYER): The author is ACTIVELY asking for a tool, software, or recommendation that exactly matches the Product Context. (e.g., "What tool do you use for X?", "I need a cheaper alternative to Y.")

🟡 70-89 (WARM LEAD): The author is explicitly complaining about the EXACT problem the product solves, but hasn't explicitly asked for a software recommendation yet.

🟠 40-69 (WEAK FIT): The post is in the right industry and discusses related topics, but the core pain point isn't a direct match, or the intent is very soft.

🔴 0-39 (TRASH/NOISE): Generic discussion, wrong problem, or hits anything on the AUTO-FAIL Kill List.

Return a JSON array with one object per post, in the same order. Include "suggested_reply" only for scores 70+ (one short sentence the founder could use to reply); omit or set to null for lower scores.

[
  { "id": "post_id", "score": 0-100, "explanation": "1 short sentence explaining the exact buying intent or the specific auto-fail trigger.", "suggested_reply": "optional; one short reply line for 70+, null otherwise" }
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
