/**
 * API server for Leadsnipe MVP.
 * POST /api/search → pipeline, returns leads. CTA "Unlock" → Stripe Checkout → welcome → dashboard.
 */

import { loadConfig, getBaseUrl, getStripeSecretKey, getStripeUnlockAmountCents, getStripeCurrency, getSessionCookieName, getStripeTestPromoCode } from "./config.js";
loadConfig();

import express from "express";
import cookieParser from "cookie-parser";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { runPipeline } from "./pipeline.js";
import {
  getLeadsForRun,
  getRunById,
  findUserByEmail,
  createUser,
  attachRunToUser,
  createSession,
  getSession,
  getLeadsForUser,
  getRunsForUser,
  setLeadAction,
  clearLeadAction,
  type LeadRow,
} from "./db/index.js";
import { InvalidSearchInputError } from "./input-validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(cookieParser());

const PORT = Number(process.env.PORT) || 3001;
const SESSION_COOKIE_NAME = getSessionCookieName();
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** IP-based rate limit: max requests per window. 0 = no limit (for testing). */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX);
const RATE_LIMIT_ENABLED = RATE_LIMIT_MAX > 0;

const ipRequestTimestamps = new Map<string, number[]>();

function getClientIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

function isRateLimited(ip: string): boolean {
  if (!RATE_LIMIT_ENABLED) return false;
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let timestamps = ipRequestTimestamps.get(ip) ?? [];
  timestamps = timestamps.filter((t) => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_MAX) return true;
  timestamps.push(now);
  ipRequestTimestamps.set(ip, timestamps);
  return false;
}

// Prune old entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, timestamps] of ipRequestTimestamps.entries()) {
    const kept = timestamps.filter((t) => t > cutoff);
    if (kept.length === 0) ipRequestTimestamps.delete(ip);
    else ipRequestTimestamps.set(ip, kept);
  }
}, 5 * 60 * 1000);

// Allow frontend (any origin for MVP; restrict later)
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (_req, res) => res.sendStatus(204));

function leadRowToApi(row: LeadRow) {
  return {
    post_id: row.post_id,
    run_id: row.run_id,
    user_input: row.user_input,
    title: row.title,
    full_link: row.full_link,
    subreddit: row.subreddit,
    author: row.author,
    created_utc: row.created_utc,
    score: row.score != null ? Math.round(row.score) : null,
    label: row.label,
    is_high_intent: row.is_high_intent === 1,
    is_archived: row.is_archived === 1,
    explanation: row.reasoning ?? null,
    suggested_reply: row.suggested_reply ?? null,
    selftext: row.selftext ?? null,
    votes: row.post_score ?? 0,
    num_comments: row.num_comments ?? 0,
  };
}

/** Auth: require session cookie and set req.user. */
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  const session = getSession(token);
  if (!session) {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(401).json({ error: "Session expired." });
    return;
  }
  (req as express.Request & { user: { id: string; email: string } }).user = { id: session.user_id, email: session.email };
  next();
}

/** Health check */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/create-checkout
 * Body: { runId: string }
 * Creates Stripe Checkout Session for one-time "unlock" payment; metadata includes runId so we can attach run to user after payment.
 */
app.post("/api/create-checkout", (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
  if (!runId) {
    res.status(400).json({ error: "Missing runId." });
    return;
  }

  const stripeKey = getStripeSecretKey();
  if (!stripeKey) {
    res.status(503).json({ error: "Payments not configured." });
    return;
  }

  const run = getRunById(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  if (run.user_id) {
    res.status(400).json({ error: "This run is already unlocked." });
    return;
  }

  const baseUrl = getBaseUrl();
  const stripe = new Stripe(stripeKey);
  const testPromoCode = getStripeTestPromoCode();

  (async () => {
    try {
      let discounts: Array<{ promotion_code: string }> | undefined;
      if (testPromoCode) {
        const promos = await stripe.promotionCodes.list({ code: testPromoCode, active: true });
        const promoId = promos.data[0]?.id;
        if (promoId) {
          discounts = [{ promotion_code: promoId }];
          console.log("[Checkout] Pre-applied promo code:", testPromoCode);
        } else {
          console.warn("[Checkout] Promo code not found or inactive:", testPromoCode, "- checkout will show promo field instead");
        }
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: getStripeCurrency(),
              product_data: {
                name: "Unlock all leads",
                description: "See all high-intent Reddit leads from your search and get access to your dashboard. Billed monthly.",
              },
              unit_amount: getStripeUnlockAmountCents(),
            },
            quantity: 1,
          },
        ],
        success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?canceled=1`,
        metadata: { run_id: runId, query: run.user_input },
        ...(discounts ? { discounts } : { allow_promotion_codes: true }),
      });
      res.json({ url: session.url });
    } catch (err) {
      console.error("Stripe create-checkout error:", err);
      res.status(500).json({ error: "Could not create checkout session." });
    }
  })();
});

/**
 * GET /welcome?session_id=cs_xxx
 * Stripe success_url: retrieve session, create/find user by email, attach run, create app session, redirect to dashboard.
 */
app.get("/welcome", async (req, res) => {
  const sessionId = typeof req.query?.session_id === "string" ? req.query.session_id.trim() : "";
  if (!sessionId) {
    res.redirect(getBaseUrl() + "/?error=missing_session");
    return;
  }

  const stripeKey = getStripeSecretKey();
  if (!stripeKey) {
    res.redirect(getBaseUrl() + "/?error=payments_not_configured");
    return;
  }

  const stripe = new Stripe(stripeKey);

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: [] });
  } catch (err) {
    console.error("Stripe retrieve session error:", err);
    res.redirect(getBaseUrl() + "/?error=invalid_session");
    return;
  }

  if (session.payment_status !== "paid") {
    res.redirect(getBaseUrl() + "/?error=payment_not_completed");
    return;
  }

  const emailRaw = session.customer_details?.email ?? session.customer_email;
  const email = typeof emailRaw === "string" && emailRaw.length > 0 ? emailRaw.trim().toLowerCase() : null;
  if (!email) {
    res.redirect(getBaseUrl() + "/?error=no_email");
    return;
  }

  const runId = session.metadata?.run_id ?? "";
  const query = session.metadata?.query ?? "";

  let user = findUserByEmail(email);
  if (!user) {
    const userId = randomUUID();
    const stripeCustomerId = typeof session.customer === "string" ? session.customer : (session.customer as Stripe.Customer)?.id ?? null;
    createUser(userId, email, stripeCustomerId);
    user = { id: userId, email, password_hash: null, stripe_customer_id: stripeCustomerId, created_at: "", updated_at: "" };
  }

  if (runId) {
    const run = getRunById(runId);
    if (run && !run.user_id) attachRunToUser(runId, user.id);
  }

  const { id: token } = createSession(user.id);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    path: "/",
  });
  // Keep the unlocked run scope so the dashboard defaults to showing only this run's leads.
  const redirectUrl = new URL("/dashboard", getBaseUrl());
  if (runId) redirectUrl.searchParams.set("runId", runId);
  res.redirect(redirectUrl.toString());
});

/** Current user (requires auth). */
app.get("/api/me", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string; email: string } }).user;
  res.json({ id: user.id, email: user.email });
});

/** All leads for the current user (requires auth). Query params: subreddit, days, minScore, query, includeArchived, runId. */
app.get("/api/dashboard/leads", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const subreddit = typeof req.query.subreddit === "string" ? req.query.subreddit.trim() : undefined;
  const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
  const minScore = req.query.minScore !== undefined ? Number(req.query.minScore) : undefined;
  const query = typeof req.query.query === "string" ? req.query.query.trim() : undefined;
  const runId = typeof req.query.runId === "string" ? req.query.runId.trim() : undefined;
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
  const leads = getLeadsForUser(user.id, 200, {
    subreddit: subreddit || undefined,
    days: Number.isFinite(days) ? days : undefined,
    minScore: Number.isFinite(minScore) ? minScore : undefined,
    query: query || undefined,
    runId: runId || undefined,
    includeArchived,
  });
  res.json({ leads: leads.map(leadRowToApi) });
});

/** List runs for the current user (for dashboard query dropdown). */
app.get("/api/dashboard/runs", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const runs = getRunsForUser(user.id, 50);
  res.json({ runs });
});

/**
 * POST /api/dashboard/search
 * Authenticated "run search again" flow.
 * Body: { query: string, context?: string }
 * Runs the full pipeline, attaches the run to the current user, and returns { runId }.
 */
app.post("/api/dashboard/search", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";

  if (!query) {
    res.status(400).json({ error: "Missing query." });
    return;
  }

  (async () => {
    try {
      const result = await runPipeline({
        userInput: query,
        context: context ? context : undefined,
        maxPagesPerKeyword: 1,
      });
      attachRunToUser(result.runId, user.id);
      res.json({ runId: result.runId });
    } catch (err) {
      console.error("Dashboard search error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Search failed",
      });
    }
  })();
});

/** Archive a lead. Body: { post_id: string }. */
app.post("/api/dashboard/leads/archive", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const postId = typeof req.body?.post_id === "string" ? req.body.post_id.trim() : "";
  if (!postId) {
    res.status(400).json({ error: "Missing post_id." });
    return;
  }
  setLeadAction(user.id, postId, "archived");
  res.json({ ok: true });
});

/** Delete a lead. Body: { post_id: string }. */
app.post("/api/dashboard/leads/delete", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const postId = typeof req.body?.post_id === "string" ? req.body.post_id.trim() : "";
  if (!postId) {
    res.status(400).json({ error: "Missing post_id." });
    return;
  }
  setLeadAction(user.id, postId, "deleted");
  res.json({ ok: true });
});

/** Unarchive a lead: remove the archived action so it returns to the active list. Body: { post_id: string }. */
app.post("/api/dashboard/leads/unarchive", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const postId = typeof req.body?.post_id === "string" ? req.body.post_id.trim() : "";
  if (!postId) {
    res.status(400).json({ error: "Missing post_id." });
    return;
  }
  clearLeadAction(user.id, postId);
  res.json({ ok: true });
});

/** Log out: clear session cookie. */
app.post("/api/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

/**
 * POST /api/search
 * Body: { "query": "SEO content automation", "maxPages"?: number }
 * Runs the full pipeline (validation → keywords → search → shortlist → rank), then returns leads ranked by intent.
 * Rate limited by IP (default 10 requests per minute).
 */
app.post("/api/search", (req, res, next) => {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    res.status(429).json({
      error: "Too many searches. Please try again in a minute.",
    });
    return;
  }
  next();
}, async (req, res) => {
  const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
  if (!query) {
    res.status(400).json({ error: "Missing or empty query. Send { \"query\": \"your search\" }." });
    return;
  }

  // Per the search flow: for each keyword we only fetch the first page results.
  // (Future deep mode can widen this.)
  const maxPages = 1;

  try {
    const result = await runPipeline({
      userInput: query,
      maxPagesPerKeyword: maxPages,
    });

    const leads = getLeadsForRun(result.runId, 100);

    res.json({
      runId: result.runId,
      query,
      keywords: result.keywords,
      totalPosts: result.totalPosts,
      totalComments: 0,
      leads: leads.map((row) => ({
        title: row.title,
        full_link: row.full_link,
        subreddit: row.subreddit,
        author: row.author,
        created_utc: row.created_utc,
        score: row.score != null ? Math.round(row.score) : null,
        label: row.label,
        is_high_intent: row.is_high_intent === 1,
        explanation: row.reasoning ?? null,
        suggested_reply: row.suggested_reply ?? null,
        selftext: row.selftext ?? null,
        votes: row.post_score ?? 0,
        num_comments: row.num_comments ?? 0,
      })),
    });
  } catch (err) {
    if (err instanceof InvalidSearchInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Pipeline error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Pipeline failed",
    });
  }
});

// Dashboard page (must be before static so /dashboard serves the page)
app.get("/dashboard", (_req, res) => {
  res.sendFile(join(publicDir, "dashboard.html"));
});

// Landing page and static assets (API routes above take precedence)
app.use(express.static(publicDir));

app.listen(PORT, () => {
  const baseUrl = getBaseUrl();
  const stripeEnabled = !!getStripeSecretKey();
  console.log(`Leadsnipe running at http://localhost:${PORT}`);
  console.log(`  Base URL (for Stripe redirects): ${baseUrl}`);
  console.log(`  Stripe: ${stripeEnabled ? "enabled" : "not configured (set STRIPE_SECRET_KEY in .env)"}`);
  console.log(RATE_LIMIT_ENABLED ? `  Rate limit: ${RATE_LIMIT_MAX} searches per IP per minute` : "  Rate limit: disabled");
  console.log("  Landing: GET /");
  console.log("  API:     POST /api/search with { \"query\": \"...\" }");
  if (stripeEnabled) console.log("  Unlock:   POST /api/create-checkout → Stripe → GET /welcome → /dashboard");
});
