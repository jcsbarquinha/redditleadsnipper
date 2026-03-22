/**
 * Load .env and expose config. Call loadConfig() at app entry (e.g. run.ts).
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

const DEFAULT_DB_PATH = "./data/reddit-leads.db";

export function loadConfig(): void {
  loadEnv(); // loads .env from cwd
}

export function getOpenAIKey(): string | undefined {
  return process.env.OPENAI_API_KEY?.trim() || undefined;
}

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return url;
  return resolve(process.cwd(), DEFAULT_DB_PATH);
}

export function requireOpenAIKey(): string {
  const key = getOpenAIKey();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is required. Add it to .env or set the environment variable."
    );
  }
  return key;
}

/** Base URL for the app (e.g. https://leadsnipe.com or http://localhost:3001). Used for Stripe success/cancel redirects. */
export function getBaseUrl(): string {
  const url = process.env.BASE_URL?.trim();
  if (url) return url.replace(/\/$/, "");
  const port = process.env.PORT || 3001;
  return `http://localhost:${port}`;
}

/** Stripe secret key (required for checkout and webhooks). */
export function getStripeSecretKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY?.trim() || undefined;
}

/** Webhook signing secret from Stripe Dashboard (whsec_...). Required for POST /api/stripe/webhook. */
export function getStripeWebhookSecret(): string | undefined {
  const s = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  return s || undefined;
}

/** Amount in cents for "unlock" payment — monthly option (e.g. 999 = $9.99). Default 999. */
export function getStripeUnlockAmountCents(): number {
  const n = Number(process.env.STRIPE_UNLOCK_AMOUNT_CENTS);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 999;
}

/**
 * Yearly unlock amount in cents (12 months for the price of 10).
 * Default = 10 × monthly default = 9990 ($99.90). Override with STRIPE_UNLOCK_YEARLY_AMOUNT_CENTS.
 */
export function getStripeUnlockYearlyAmountCents(): number {
  const n = Number(process.env.STRIPE_UNLOCK_YEARLY_AMOUNT_CENTS);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return getStripeUnlockAmountCents() * 10;
}

/** Currency for Stripe (e.g. usd). Default usd. */
export function getStripeCurrency(): string {
  return (process.env.STRIPE_CURRENCY?.trim() || "usd").toLowerCase();
}

/** Optional: promotion code to pre-apply at checkout (e.g. FREETEST). When set, checkout shows $0 and no promo field. For testing. */
export function getStripeTestPromoCode(): string | undefined {
  const s = process.env.STRIPE_TEST_PROMO_CODE?.trim();
  return s || undefined;
}

/** Name of the session cookie. */
export function getSessionCookieName(): string {
  return process.env.SESSION_COOKIE_NAME?.trim() || "leadsnipe_session";
}
