import { getBaseUrl } from "./config.js";
import { hasDashboardAccess } from "./entitlements.js";
import { isMailConfigured, sendTransactionalMail } from "./mail.js";
import {
  findUserById,
  getCronDigestNewLeads,
  getRunById,
  getSavedSearchForUser,
  markSavedSearchDigestSentAt,
  parseEmailAlertTypesJson,
  type EmailAlertTypes,
  type LeadRow,
} from "./db/index.js";

const RECENT_MAX_AGE_SEC = 86400;

/** Aligns with dashboard alert chips: Hot ≥90, Warm &gt;70 and &lt;90, Recent = post age ≤24h (all require intent &gt; 70). */
export function leadMatchesEmailAlertTypes(
  score: number | null,
  createdUtc: number | null,
  types: EmailAlertTypes
): boolean {
  const s = score != null && Number.isFinite(Number(score)) ? Number(score) : 0;
  if (s <= 70) return false;
  if (types.hot && types.warm && types.recent) return true;
  if (types.hot && s >= 90) return true;
  if (types.warm && s > 70 && s < 90) return true;
  if (types.recent && createdUtc != null && Number.isFinite(createdUtc)) {
    if (Date.now() / 1000 - createdUtc <= RECENT_MAX_AGE_SEC) return true;
  }
  return false;
}

function digestAlreadySentTodayUtc(lastDigestIso: string | null | undefined): boolean {
  if (!lastDigestIso || typeof lastDigestIso !== "string") return false;
  const d = new Date(lastDigestIso);
  if (!Number.isFinite(d.getTime())) return false;
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function snippetFromSelftext(selftext: string | null | undefined, maxLen: number = 220): string {
  const raw = (selftext || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw.length <= maxLen ? raw : `${raw.slice(0, maxLen - 1)}…`;
}

function buildDigestMail(params: {
  count: number;
  topLead: LeadRow;
  dashboardUrl: string;
}): { subject: string; text: string; html: string } {
  const { count, topLead, dashboardUrl } = params;
  const subject =
    count === 1 ? "1 new lead in your Leadsnipe dashboard" : `${count} new leads in your Leadsnipe dashboard`;
  const scoreLabel =
    topLead.score != null && Number.isFinite(Number(topLead.score)) ? `${Math.round(Number(topLead.score))}% match` : "High intent";
  const sub = (topLead.subreddit || "reddit").trim();
  const title = (topLead.title || "Reddit thread").trim();
  const link = (topLead.full_link || "").trim();
  const snippet = snippetFromSelftext(topLead.selftext);

  const textLines = [
    `You have ${count} new lead${count === 1 ? "" : "s"} in your dashboard, ready for a reply.`,
    "",
    `Top pick — r/${sub}: ${title}`,
    scoreLabel,
    snippet ? snippet : null,
    link ? `Open thread: ${link}` : null,
    "",
    `Open dashboard: ${dashboardUrl}`,
  ].filter(Boolean) as string[];
  const text = textLines.join("\n");

  const safeTitle = escapeHtml(title);
  const safeSub = escapeHtml(sub);
  const safeSnippet = snippet ? escapeHtml(snippet) : "";
  const safeUrl = escapeHtml(link);
  const safeDash = escapeHtml(dashboardUrl);

  const html = `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,sans-serif;line-height:1.5;color:#111;">
  <p>You have <strong>${count}</strong> new lead${count === 1 ? "" : "s"} in your dashboard, ready for a reply.</p>
  <div style="border:1px solid #e0e0e0;border-radius:12px;padding:16px;max-width:520px;margin:16px 0;background:#fafafa;">
    <div style="font-size:12px;color:#666;margin-bottom:6px;">r/${safeSub} · ${escapeHtml(scoreLabel)}</div>
    <div style="font-size:17px;font-weight:600;margin-bottom:8px;">${safeTitle}</div>
    ${safeSnippet ? `<p style="font-size:14px;color:#444;margin:0 0 12px;">${safeSnippet}</p>` : ""}
    ${link ? `<a href="${safeUrl}" style="color:#ff4500;font-weight:600;">View on Reddit</a>` : ""}
  </div>
  <p><a href="${safeDash}" style="color:#ff4500;font-weight:600;">Open your dashboard</a></p>
</body></html>`;

  return { subject, text, html };
}

/**
 * After a successful saved-search cron run: optionally email the user (≤1 digest per UTC day).
 */
export async function maybeSendCronLeadDigest(savedSearchId: string, userId: string, runId: string): Promise<void> {
  const saved = getSavedSearchForUser(userId);
  if (!saved || saved.id !== savedSearchId) {
    return;
  }
  if (saved.email_alerts_enabled !== 1) {
    return;
  }

  const user = findUserById(userId);
  if (!user?.email?.trim()) {
    console.warn(`cron digest: no email for user ${userId}`);
    return;
  }
  if (!hasDashboardAccess(user.email, user.entitled_until)) {
    return;
  }

  const run = getRunById(runId);
  if (!run || run.user_id !== userId || run.source !== "cron") {
    return;
  }

  const alertTypes = parseEmailAlertTypesJson(saved.email_alert_types_json);
  const candidates = getCronDigestNewLeads(runId, userId);
  const matching = candidates.filter((l) =>
    leadMatchesEmailAlertTypes(l.score, l.created_utc, alertTypes)
  );
  if (matching.length === 0) {
    return;
  }

  if (digestAlreadySentTodayUtc(saved.last_digest_sent_at)) {
    return;
  }

  if (!isMailConfigured()) {
    console.warn("cron digest: SMTP not configured; skip send");
    return;
  }

  const topLead = matching[0];
  const dashboardUrl = `${getBaseUrl().replace(/\/$/, "")}/dashboard`;
  const { subject, text, html } = buildDigestMail({ count: matching.length, topLead, dashboardUrl });

  try {
    await sendTransactionalMail({ to: user.email.trim(), subject, text, html });
    markSavedSearchDigestSentAt(savedSearchId, new Date().toISOString());
  } catch (e) {
    console.error("cron digest: send failed", e);
  }
}
