/** Shared dashboard / email eligibility (Stripe + internal allowlist). */

/** Optional internal allowlist (empty = access only via Stripe entitlement dates). */
const UNLIMITED_ACCESS_EMAILS = new Set<string>();

export function hasUnlimitedAccessByEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return UNLIMITED_ACCESS_EMAILS.has(String(email).trim().toLowerCase());
}

/** Active paid entitlement window (Stripe welcome sets entitled_until). */
export function isEntitled(entitledUntil: string | null | undefined): boolean {
  if (!entitledUntil) return false;
  const d = new Date(String(entitledUntil));
  return Number.isFinite(d.getTime()) && d.getTime() > Date.now();
}

export function hasDashboardAccess(
  email: string | null | undefined,
  entitledUntil: string | null | undefined
): boolean {
  return hasUnlimitedAccessByEmail(email) || isEntitled(entitledUntil);
}
