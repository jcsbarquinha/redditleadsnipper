/**
 * API server for Leadsnipe MVP.
 * POST /api/search → pipeline, returns leads. CTA "Unlock" → Stripe Checkout → welcome → dashboard.
 */

import "./boot.js";
import {
  loadConfig,
  getBaseUrl,
  getStripeSecretKey,
  getStripeWebhookSecret,
  getStripeUnlockAmountCents,
  getStripeUnlockYearlyAmountCents,
  getStripeCurrency,
  getSessionCookieName,
  getStripeTestPromoCode,
} from "./config.js";
loadConfig();

import express from "express";
import cookieParser from "cookie-parser";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import { runPipeline } from "./pipeline.js";
import { RedditRateLimitedError } from "./reddit-search.js";
import {
  getLeadsForRun,
  getRunById,
  findUserByEmail,
  createUser,
  attachRunToUser,
  createSession,
  getSession,
  createMagicLink,
  consumeMagicLink,
  setEntitledUntil,
  setStripeCustomerId,
  getLeadsForUser,
  getRunsForUser,
  setLeadAction,
  clearLeadAction,
  setLeadFeedback,
  getLeadFeedbackVote,
  isPostInRun,
  setLandingLeadFeedback,
  upsertSavedSearchForUser,
  getSavedSearchForUser,
  ensureCurrentSearchProfileForInput,
  getCurrentSearchProfileForUser,
  setRunSearchProfile,
  insertServiceStatusCheck,
  getRecentServiceStatusChecks,
  type LeadRow,
  type ServiceStatusState,
} from "./db/index.js";
import { InvalidSearchInputError } from "./input-validation.js";
import { runSavedSearchSchedulerTick } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");

const app = express();
app.use(cookieParser());

/**
 * Render injects PORT (commonly 10000). Health checks probe that port — listening on 3001 while Render probes 10000 → deploy timeout.
 * - Production: default 10000 if PORT missing/invalid (never fall back to 3001 here).
 * - Local dev: 3001 when PORT unset.
 * Tip: In Render Dashboard, do not set PORT to empty; omit it so the platform injects the real value.
 */
function getListenPort(): number {
  const raw = process.env.PORT;
  const isProd = process.env.NODE_ENV === "production";
  const fallback = isProd ? 10000 : 3001;
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const PORT = getListenPort();
const SESSION_COOKIE_NAME = getSessionCookieName();
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const POST_LOGIN_REDIRECT_COOKIE = "post_login_redirect";

/** Active paid entitlement window (Stripe welcome sets entitled_until). */
function isEntitled(entitledUntil: string | null | undefined): boolean {
  if (!entitledUntil) return false;
  const d = new Date(String(entitledUntil));
  return Number.isFinite(d.getTime()) && d.getTime() > Date.now();
}

// Allow frontend (any origin for MVP; restrict later)
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.options("*", (_req, res) => res.sendStatus(204));

/**
 * Apply entitlement + optional run attach from a paid Checkout Session (used by GET /welcome and Stripe webhooks).
 */
function applyPaidCheckoutFromSession(session: Stripe.Checkout.Session): { userId: string; runId: string } | null {
  // $0 / 100% coupon checkouts use `no_payment_required`, not `paid` (Stripe docs: no-cost orders).
  const ok =
    session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!ok) return null;
  const emailRaw = session.customer_details?.email ?? session.customer_email;
  const email = typeof emailRaw === "string" && emailRaw.length > 0 ? emailRaw.trim().toLowerCase() : null;
  if (!email) return null;

  const runId = typeof session.metadata?.run_id === "string" ? session.metadata.run_id.trim() : "";
  const billingInterval = session.metadata?.billing_interval === "yearly" ? "yearly" : "monthly";

  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : (session.customer as Stripe.Customer)?.id ?? null;

  let user = findUserByEmail(email);
  if (!user) {
    const userId = randomUUID();
    createUser(userId, email, stripeCustomerId);
    user = findUserByEmail(email);
  }
  if (!user) return null;

  setStripeCustomerId(user.id, stripeCustomerId);

  const entitlementMs =
    billingInterval === "yearly" ? 365 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const entitledUntil = new Date(Date.now() + entitlementMs).toISOString();
  setEntitledUntil(user.id, entitledUntil);

  if (runId) {
    const run = getRunById(runId);
    if (run && !run.user_id) attachRunToUser(runId, user.id);
  }

  return { userId: user.id, runId };
}

/** Stripe webhook — must use raw body (signature verification). */
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req: express.Request, res: express.Response) => {
    const stripeKey = getStripeSecretKey();
    const whSecret = getStripeWebhookSecret();
    if (!stripeKey || !whSecret) {
      res.status(503).send("Webhook not configured");
      return;
    }
    const stripe = new Stripe(stripeKey);
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") {
      res.status(400).send("Missing stripe-signature");
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } catch (err) {
      console.error("Stripe webhook signature error:", err);
      res.status(400).send("Webhook signature verification failed");
      return;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      try {
        applyPaidCheckoutFromSession(session);
      } catch (e) {
        console.error("applyPaidCheckoutFromSession (webhook):", e);
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());

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
    is_deleted: row.is_deleted === 1,
    explanation: row.reasoning ?? null,
    suggested_reply: row.suggested_reply ?? null,
    selftext: row.selftext ?? null,
    votes: row.post_score ?? 0,
    num_comments: row.num_comments ?? 0,
    feedback_vote: row.feedback_vote === 1 ? 1 : row.feedback_vote === -1 ? -1 : null,
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
  (req as express.Request & { user: { id: string; email: string; entitled_until: string | null } }).user = {
    id: session.user_id,
    email: session.email,
    entitled_until: session.entitled_until,
  };
  next();
}

/** Health check */
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Shared status history for website + API. Backed by DB checks from server monitor.
 */
app.get("/api/status", (_req, res) => {
  const websiteHistory = getRecentServiceStatusChecks("website", 30);
  const apiHistory = getRecentServiceStatusChecks("api", 30);

  const websiteLatest = websiteHistory.length ? websiteHistory[websiteHistory.length - 1] : null;
  const apiLatest = apiHistory.length ? apiHistory[apiHistory.length - 1] : null;

  const pct = (rows: { state: ServiceStatusState }[]): number => {
    if (!rows.length) return 0;
    const okCount = rows.filter((r) => r.state === "ok").length;
    return Number(((okCount / rows.length) * 100).toFixed(1));
  };

  const overall: ServiceStatusState =
    websiteLatest?.state === "ok" && apiLatest?.state === "ok" ? "ok" : "warn";

  res.json({
    overall,
    checked_at: new Date().toISOString(),
    services: {
      website: {
        latest: websiteLatest,
        uptime_pct: pct(websiteHistory),
        history: websiteHistory,
      },
      api: {
        latest: apiLatest,
        uptime_pct: pct(apiHistory),
        history: apiHistory,
      },
    },
  });
});

/**
 * Internal scheduler tick endpoint for Render Cron.
 * Protect with CRON_SECRET via `x-cron-secret` header.
 */
app.post("/api/internal/scheduler/tick", async (req, res) => {
  const configuredSecret = (process.env.CRON_SECRET || "").trim();
  if (!configuredSecret) {
    res.status(503).json({ error: "CRON_SECRET is not configured." });
    return;
  }
  const provided = typeof req.headers["x-cron-secret"] === "string" ? req.headers["x-cron-secret"].trim() : "";
  if (!provided || provided !== configuredSecret) {
    res.status(401).json({ error: "Unauthorized scheduler trigger." });
    return;
  }

  const limitRaw = Number(req.body?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 10;
  const forceRaw = req.body?.force;
  const force =
    forceRaw === true ||
    forceRaw === 1 ||
    forceRaw === "1" ||
    (typeof forceRaw === "string" && forceRaw.trim().toLowerCase() === "true");
  const startedAt = Date.now();
  try {
    const result = await runSavedSearchSchedulerTick({ limit, maxPagesPerKeyword: 1, force });
    res.json({
      ok: true,
      force,
      elapsed_ms: Date.now() - startedAt,
      ...result,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Scheduler tick failed.",
    });
  }
});

/**
 * POST /api/create-checkout
 * Body: { runId?: string, billing?: "monthly" | "yearly" }
 * If runId is set: unlock that search run after payment. If omitted: dashboard access only (user runs a search later).
 */
app.post("/api/create-checkout", (req, res) => {
  const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";

  const billingRaw = typeof req.body?.billing === "string" ? req.body.billing.trim().toLowerCase() : "";
  const billing: "monthly" | "yearly" = billingRaw === "yearly" ? "yearly" : "monthly";

  const stripeKey = getStripeSecretKey();
  if (!stripeKey) {
    res.status(503).json({ error: "Payments not configured." });
    return;
  }

  let run: ReturnType<typeof getRunById> | null = null;
  if (runId) {
    run = getRunById(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    if (run.user_id) {
      const token = req.cookies?.[SESSION_COOKIE_NAME];
      const sess = token ? getSession(token) : null;
      if (!sess || sess.user_id !== run.user_id) {
        res.status(403).json({
          error:
            "This search belongs to another account. Sign in with the same account you used when you saved it, then unlock.",
        });
        return;
      }
      if (isEntitled(sess.entitled_until)) {
        res.status(400).json({ error: "You already have an active plan." });
        return;
      }
    }
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

      const unitAmount =
        billing === "yearly" ? getStripeUnlockYearlyAmountCents() : getStripeUnlockAmountCents();
      const productDescription = run
        ? billing === "yearly"
          ? "See all high-intent Reddit leads from your search and get access to your dashboard. Billed annually (12 months for the price of 10)."
          : "See all high-intent Reddit leads from your search and get access to your dashboard. Billed monthly."
        : billing === "yearly"
          ? "Full dashboard access to find buyer-intent leads on Reddit. Billed annually (12 months for the price of 10)."
          : "Full dashboard access to find buyer-intent leads on Reddit. Billed monthly.";

      const productName = run
        ? billing === "yearly"
          ? "Unlock all leads — yearly"
          : "Unlock all leads — monthly"
        : billing === "yearly"
          ? "Founder Plan — yearly"
          : "Founder Plan — monthly";

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: getStripeCurrency(),
              product_data: {
                name: productName,
                description: productDescription,
              },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?canceled=1#pricing`,
        // Stripe rejects empty metadata values; omit run_id when doing “pricing only” checkout.
        metadata: {
          billing_interval: billing,
          ...(runId
            ? { run_id: runId, query: run?.user_input ?? "" }
            : { checkout_kind: "dashboard_only" }),
        },
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

  const applied = applyPaidCheckoutFromSession(session);
  if (!applied) {
    if (session.payment_status !== "paid") {
      res.redirect(getBaseUrl() + "/?error=payment_not_completed");
      return;
    }
    res.redirect(getBaseUrl() + "/?error=no_email");
    return;
  }

  const runId = typeof session.metadata?.run_id === "string" ? session.metadata.run_id.trim() : "";

  const { id: token } = createSession(applied.userId);
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
  const user = (req as express.Request & { user: { id: string; email: string; entitled_until: string | null } }).user;
  res.json({
    id: user.id,
    email: user.email,
    entitled_until: user.entitled_until,
    entitled: isEntitled(user.entitled_until),
  });
});

/** All leads for the current user (requires auth). Query params: subreddit, days, minScore, query, includeArchived, includeDeleted, runId. */
app.get("/api/dashboard/leads", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string; entitled_until: string | null } }).user;
  if (!isEntitled(user.entitled_until)) {
    res.json({ leads: [], entitled: false });
    return;
  }
  const subreddit = typeof req.query.subreddit === "string" ? req.query.subreddit.trim() : undefined;
  const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
  const minScore = req.query.minScore !== undefined ? Number(req.query.minScore) : undefined;
  const query = typeof req.query.query === "string" ? req.query.query.trim() : undefined;
  const runId = typeof req.query.runId === "string" ? req.query.runId.trim() : undefined;
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
  const includeDeleted = req.query.includeDeleted === "true" || req.query.includeDeleted === "1";
  const savedSearch = getSavedSearchForUser(user.id);
  const currentProfile =
    getCurrentSearchProfileForUser(user.id) ||
    (savedSearch ? ensureCurrentSearchProfileForInput(user.id, savedSearch.query, savedSearch.context) : null);
  if (!currentProfile) {
    res.json({ leads: [], entitled: true });
    return;
  }
  const leads = getLeadsForUser(user.id, 200, {
    subreddit: subreddit || undefined,
    days: Number.isFinite(days) ? days : undefined,
    minScore: Number.isFinite(minScore) ? minScore : undefined,
    query: query || undefined,
    runId: runId || undefined,
    searchProfileId: currentProfile.id,
    includeArchived,
    includeDeleted,
  });
  res.json({ leads: leads.map(leadRowToApi), entitled: true });
});

/** List runs for the current user (for dashboard query dropdown). */
app.get("/api/dashboard/runs", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const savedSearch = getSavedSearchForUser(user.id);
  const currentProfile =
    getCurrentSearchProfileForUser(user.id) ||
    (savedSearch ? ensureCurrentSearchProfileForInput(user.id, savedSearch.query, savedSearch.context) : null);
  const runs = getRunsForUser(user.id, 50, currentProfile?.id);
  res.json({ runs });
});

/** Saved search config for the current user. */
app.get("/api/dashboard/saved-search", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const row = getSavedSearchForUser(user.id);
  res.json({
    savedSearch: row
      ? {
          query: row.query,
          context: row.context,
          enabled: row.enabled === 1,
          interval_minutes: row.interval_minutes,
          last_run_at: row.last_run_at,
          next_run_at: row.next_run_at,
          last_run_status: row.last_run_status,
          last_error: row.last_error,
        }
      : null,
  });
});

/**
 * POST /api/dashboard/search
 * Authenticated "run search again" flow.
 * Body: { query: string, context?: string }
 * Runs the full pipeline, attaches the run to the current user, and returns { runId }.
 */
app.post("/api/dashboard/search", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string; entitled_until: string | null } }).user;
  if (!isEntitled(user.entitled_until)) {
    res.status(403).json({
      error: "An active plan is required to run searches from the dashboard. Unlock below or search from the home page first.",
    });
    return;
  }
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
      const profile = ensureCurrentSearchProfileForInput(user.id, query, context || null);
      if (profile) setRunSearchProfile(result.runId, profile.id);
      upsertSavedSearchForUser(user.id, query, context || null, 60);
      res.json({ runId: result.runId, totalPosts: result.totalPosts });
    } catch (err) {
      if (err instanceof RedditRateLimitedError) {
        res.status(429).json({ error: err.message });
        return;
      }
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

/** Reactivate a lead: remove the lead action (deleted/archived) so it returns to active. Body: { post_id: string }. */
app.post("/api/dashboard/leads/reactivate", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const postId = typeof req.body?.post_id === "string" ? req.body.post_id.trim() : "";
  if (!postId) {
    res.status(400).json({ error: "Missing post_id." });
    return;
  }
  clearLeadAction(user.id, postId);
  res.json({ ok: true });
});

/** Save lead quality feedback vote once. Body: { post_id: string, vote: "up" | "down" }. */
app.post("/api/dashboard/leads/feedback", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const postId = typeof req.body?.post_id === "string" ? req.body.post_id.trim() : "";
  const voteRaw = typeof req.body?.vote === "string" ? req.body.vote.trim().toLowerCase() : "";
  if (!postId) {
    res.status(400).json({ error: "Missing post_id." });
    return;
  }
  if (!["up", "down"].includes(voteRaw)) {
    res.status(400).json({ error: "Invalid vote. Expected up or down." });
    return;
  }
  const existingVote = getLeadFeedbackVote(user.id, postId);
  if (existingVote != null) {
    res.status(409).json({ error: "Feedback already submitted for this post.", feedback_vote: existingVote });
    return;
  }
  const vote = voteRaw === "up" ? 1 : -1;
  setLeadFeedback(user.id, postId, vote);
  res.json({ ok: true, feedback_vote: vote });
});

/** Save landing lead feedback once. Body: { run_id: string, post_id: string, vote: "up" | "down" }. */
app.post("/api/landing/leads/feedback", (req, res) => {
  const runId = typeof req.body?.run_id === "string" ? req.body.run_id.trim() : "";
  const postId = typeof req.body?.post_id === "string" ? req.body.post_id.trim() : "";
  const voteRaw = typeof req.body?.vote === "string" ? req.body.vote.trim().toLowerCase() : "";
  if (!runId) {
    res.status(400).json({ error: "Missing run_id." });
    return;
  }
  if (!postId) {
    res.status(400).json({ error: "Missing post_id." });
    return;
  }
  if (!["up", "down"].includes(voteRaw)) {
    res.status(400).json({ error: "Invalid vote. Expected up or down." });
    return;
  }
  if (!isPostInRun(postId, runId)) {
    res.status(404).json({ error: "Lead not found for this run." });
    return;
  }
  const vote = voteRaw === "up" ? 1 : -1;
  const inserted = setLandingLeadFeedback(runId, postId, vote);
  if (!inserted) {
    res.status(409).json({ error: "Feedback already submitted for this post in this run." });
    return;
  }
  res.json({ ok: true, feedback_vote: vote });
});

/** Log out: clear session cookie. */
app.post("/api/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

app.post("/api/auth/magic-link/request", async (req, res) => {
  const emailRaw = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const email = emailRaw.toLowerCase();
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Missing or invalid email." });
    return;
  }

  const SMTP_HOST = process.env.SMTP_HOST?.trim() || "";
  const SMTP_PORT = Number(process.env.SMTP_PORT || "");
  const SMTP_USER = process.env.SMTP_USER?.trim() || "";
  const SMTP_PASS = process.env.SMTP_PASS?.trim() || "";
  const EMAIL_FROM = process.env.EMAIL_FROM?.trim() || "";

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
    res.status(503).json({ error: "Email is not configured. Set SMTP_* + EMAIL_FROM." });
    return;
  }

  let user = findUserByEmail(email);
  if (!user) {
    const userId = randomUUID();
    createUser(userId, email, null);
    user = findUserByEmail(email);
  }
  if (!user) {
    res.status(500).json({ error: "Could not create user." });
    return;
  }

  const token = randomUUID();
  const expiresAtIso = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min
  createMagicLink(token, user.id, expiresAtIso);

  const baseUrl = getBaseUrl();
  const magicLink = `${baseUrl}/magic-link?token=${encodeURIComponent(token)}`;

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  try {
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject: "Your Leadsnipe sign-in link",
      text: `Click to sign in: ${magicLink}\n\nThis link expires in 15 minutes.`,
      html: `Click to sign in: <a href="${magicLink}">${magicLink}</a><br/><br/>This link expires in 15 minutes.`,
    });
  } catch (e) {
    console.error("Magic link email send failed:", e);
    res.status(500).json({ error: "Could not send magic link email." });
    return;
  }

  res.json({ ok: true });
});

/** After Google or magic-link login, redirect to `post_login_redirect` cookie path or /dashboard. */
function redirectAfterLogin(req: express.Request, res: express.Response): void {
  const raw = req.cookies?.[POST_LOGIN_REDIRECT_COOKIE];
  res.clearCookie(POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
  let path = "/dashboard";
  if (typeof raw === "string") {
    try {
      const t = decodeURIComponent(raw).trim();
      if (t.startsWith("/") && !t.startsWith("//")) path = t;
    } catch {
      path = "/dashboard";
    }
  }
  const base = getBaseUrl().replace(/\/$/, "");
  res.redirect(base + path);
}

/**
 * POST /api/dashboard/attach-pending-run
 * Links an anonymous landing-page run to the logged-in user (same flow as post-Stripe attach).
 */
app.post("/api/dashboard/attach-pending-run", requireAuth, (req, res) => {
  const user = (req as express.Request & { user: { id: string } }).user;
  const runId = typeof req.body?.runId === "string" ? req.body.runId.trim() : "";
  if (!runId) {
    res.status(400).json({ error: "Missing runId." });
    return;
  }
  const run = getRunById(runId);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  if (run.user_id && run.user_id !== user.id) {
    res.status(403).json({ error: "This search is already linked to another account." });
    return;
  }
  if (!run.user_id) {
    attachRunToUser(runId, user.id);
  }
  if (run.user_input && run.user_input.trim()) {
    const profile = ensureCurrentSearchProfileForInput(user.id, run.user_input, run.context ?? null);
    if (profile) setRunSearchProfile(runId, profile.id);
    upsertSavedSearchForUser(user.id, run.user_input, run.context ?? null, 60);
  }
  res.json({ ok: true, runId });
});

/**
 * GET /magic-link?token=...
 * Verifies token, creates session cookie, redirects to dashboard.
 */
app.get("/magic-link", (req, res) => {
  const token = typeof req.query?.token === "string" ? req.query.token.trim() : "";
  if (!token) {
    res.redirect("/?error=missing_magic_link");
    return;
  }

  const userId = consumeMagicLink(token);
  if (!userId) {
    res.redirect("/?error=invalid_magic_link");
    return;
  }

  const { id: sessionToken } = createSession(userId);
  res.cookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
    path: "/",
  });

  redirectAfterLogin(req, res);
});

/**
 * GET /api/auth/google/start
 * Redirects to Google OAuth consent screen.
 */
app.get("/api/auth/google/start", (req, res) => {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() || "";
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: "Google auth is not configured." });
    return;
  }

  const baseUrl = getBaseUrl();
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  const state = randomUUID();

  res.cookie("google_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });

  // Space-separated scopes only — do not pre-encode; URLSearchParams encodes correctly.
  // Pre-encoding made Google treat "openid%20email%20profile" as one invalid scope (Error 400: invalid_scope).
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  res.redirect(authUrl.toString());
});

/**
 * GET /api/auth/google/callback
 * Exchanges code → user, creates session cookie, redirects to dashboard.
 */
app.get("/api/auth/google/callback", async (req, res) => {
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID?.trim() || "";
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.redirect("/?error=google_not_configured");
    return;
  }

  const code = typeof req.query?.code === "string" ? req.query.code : "";
  const state = typeof req.query?.state === "string" ? req.query.state : "";

  const cookieState = req.cookies?.google_oauth_state;
  if (!code || !state || !cookieState || cookieState !== state) {
    res.redirect("/?error=google_state_mismatch");
    return;
  }

  const baseUrl = getBaseUrl();
  const redirectUri = `${baseUrl}/api/auth/google/callback`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      res.redirect("/?error=google_token_exchange_failed");
      return;
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      res.redirect("/?error=google_no_access_token");
      return;
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userInfoRes.ok) {
      res.redirect("/?error=google_userinfo_failed");
      return;
    }

    const profile = (await userInfoRes.json()) as { email?: string };
    const email = typeof profile?.email === "string" ? profile.email.trim().toLowerCase() : "";
    if (!email) {
      res.redirect("/?error=google_no_email");
      return;
    }

    let user = findUserByEmail(email);
    if (!user) {
      const userId = randomUUID();
      createUser(userId, email, null);
      user = findUserByEmail(email);
    }
    if (!user) {
      res.redirect("/?error=google_user_create_failed");
      return;
    }

    const { id: sessionToken } = createSession(user.id);
    res.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: "/",
    });

    res.clearCookie("google_oauth_state", { path: "/" });
    redirectAfterLogin(req, res);
  } catch (e) {
    console.error("Google auth error:", e);
    res.redirect("/?error=google_auth_error");
  }
});

/**
 * POST /api/search
 * Body: { "query": "SEO content automation", "maxPages"?: number }
 * Runs the full pipeline (validation → keywords → search → shortlist → rank), then returns leads ranked by intent.
 */
app.post("/api/search", async (req, res) => {
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
      timings: result.timings,
      leads: leads.map((row) => ({
        post_id: row.post_id,
        run_id: row.run_id,
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
    if (err instanceof RedditRateLimitedError) {
      res.status(429).json({ error: err.message });
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

// Login page (must be before static so /login serves the page)
app.get("/login", (_req, res) => {
  res.sendFile(join(publicDir, "login.html"));
});

// Legal pages
app.get("/privacy", (_req, res) => {
  res.sendFile(join(publicDir, "privacy.html"));
});

app.get("/terms", (_req, res) => {
  res.sendFile(join(publicDir, "terms.html"));
});

app.get("/faq", (_req, res) => {
  res.sendFile(join(publicDir, "faq.html"));
});

app.get("/status", (_req, res) => {
  res.sendFile(join(publicDir, "status.html"));
});

// Landing page and static assets (API routes above take precedence)
app.use(express.static(publicDir));

// Render and other hosts require listening on 0.0.0.0 — default listen() can be unreachable behind the proxy.
app.listen(PORT, "0.0.0.0", () => {
  const baseUrl = getBaseUrl();
  const stripeEnabled = !!getStripeSecretKey();
  console.log(`Leadsnipe listening on 0.0.0.0:${PORT} (process.env.PORT=${JSON.stringify(process.env.PORT)})`);
  console.log(`  Base URL (for Stripe redirects): ${baseUrl}`);
  console.log(`  Stripe: ${stripeEnabled ? "enabled" : "not configured (set STRIPE_SECRET_KEY in .env)"}`);
  console.log("  Search API: no IP rate limit (add middleware in production if needed)");
  console.log("  Landing: GET /");
  console.log("  API:     POST /api/search with { \"query\": \"...\" }");
  if (stripeEnabled) console.log("  Unlock:   POST /api/create-checkout → Stripe → GET /welcome → /dashboard");
  const wh = getStripeWebhookSecret();
  if (stripeEnabled) {
    console.log(`  Stripe webhooks: ${wh ? "POST /api/stripe/webhook (signing secret set)" : "set STRIPE_WEBHOOK_SECRET for checkout.session.completed backup"}`);
  }

  /**
   * Real shared uptime monitor (DB-backed):
   * - website check: GET /
   * - API check: GET /api/health (expects { ok: true })
   */
  const baseProbeUrl = `http://127.0.0.1:${PORT}`;
  const intervalMs = 5 * 60 * 1000;

  async function runStatusChecks(): Promise<void> {
    async function check(path: string, expectsOkJson: boolean): Promise<{ state: ServiceStatusState; statusCode: number | null; latencyMs: number | null }> {
      const startedAt = Date.now();
      try {
        const response = await fetch(baseProbeUrl + path, { method: "GET", cache: "no-store" });
        const latencyMs = Date.now() - startedAt;
        if (!response.ok) {
          return { state: "down", statusCode: response.status, latencyMs };
        }
        if (!expectsOkJson) {
          return { state: "ok", statusCode: response.status, latencyMs };
        }
        try {
          const payload = await response.json() as { ok?: boolean };
          if (payload?.ok === true) return { state: "ok", statusCode: response.status, latencyMs };
          return { state: "warn", statusCode: response.status, latencyMs };
        } catch {
          return { state: "warn", statusCode: response.status, latencyMs };
        }
      } catch {
        return { state: "down", statusCode: null, latencyMs: Date.now() - startedAt };
      }
    }

    const checkedAt = new Date().toISOString();
    const website = await check("/", false);
    const api = await check("/api/health", true);
    insertServiceStatusCheck("website", website.state, website.statusCode, website.latencyMs, checkedAt);
    insertServiceStatusCheck("api", api.state, api.statusCode, api.latencyMs, checkedAt);
  }

  runStatusChecks().catch((err) => console.error("status checks (initial) failed:", err));
  setInterval(() => {
    runStatusChecks().catch((err) => console.error("status checks (interval) failed:", err));
  }, intervalMs);
});
