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

/** When `true`, skip the ≤1 digest per UTC day cap (for local cron / Render testing). Default: cap on. */
function isCronDigestDailyCapDisabled(): boolean {
  const v = process.env.CRON_DIGEST_DISABLE_DAILY_CAP?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
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

function isRecentForBadge(createdUtc: number | null): boolean {
  if (createdUtc == null || !Number.isFinite(createdUtc)) return false;
  return Date.now() / 1000 - createdUtc <= RECENT_MAX_AGE_SEC;
}

/** Match dashboard `getIntentBadge` bands for the top lead card. */
function intentBand(score: number | null): "hot" | "warm" | "other" {
  const s = score != null && Number.isFinite(Number(score)) ? Number(score) : 0;
  if (s >= 90) return "hot";
  if (s > 70) return "warm";
  return "other";
}

function formatRelativeTime(createdUtc: number | null): string {
  if (createdUtc == null || !Number.isFinite(createdUtc)) return "";
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - createdUtc));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 2) return "1d ago";
  return `${Math.floor(sec / 86400)}d ago`;
}

function buildDigestMail(params: {
  count: number;
  topLead: LeadRow;
  dashboardUrl: string;
  assetBaseUrl: string;
}): { subject: string; text: string; html: string } {
  const { count, topLead, dashboardUrl, assetBaseUrl } = params;
  const subject =
    count === 1 ? "1 new lead in your Leadsnipe dashboard" : `${count} new leads in your Leadsnipe dashboard`;
  const scoreNum = topLead.score != null && Number.isFinite(Number(topLead.score)) ? Math.round(Number(topLead.score)) : null;
  const scoreLabel = scoreNum != null ? `${scoreNum}% match` : "High intent";
  const sub = (topLead.subreddit || "reddit").trim();
  const title = (topLead.title || "Reddit thread").trim();
  const link = (topLead.full_link || "").trim();
  const snippet = snippetFromSelftext(topLead.selftext);
  const band = intentBand(topLead.score);
  const recent = isRecentForBadge(topLead.created_utc);
  const when = formatRelativeTime(topLead.created_utc);
  const metaLine = when ? `r/${sub} · ${when}` : `r/${sub}`;

  const textLines = [
    "Hey,",
    "",
    `You have ${count} new lead${count === 1 ? "" : "s"} in your dashboard, ready for a reply.`,
    "",
    `Top pick — ${metaLine}`,
    band === "hot" ? "🔥 Hot" : band === "warm" ? "🟡 Warm" : scoreLabel,
    recent ? "🕒 Recent" : null,
    title,
    snippet ? snippet : null,
    link ? `View on Reddit: ${link}` : null,
    "",
    `Go to dashboard: ${dashboardUrl}`,
  ].filter(Boolean) as string[];
  const text = textLines.join("\n");

  const safeTitle = escapeHtml(title);
  const safeSub = escapeHtml(sub);
  const safeSnippet = snippet ? escapeHtml(snippet) : "";
  const safeUrl = escapeHtml(link);
  const safeDash = escapeHtml(dashboardUrl);
  const safeMeta = escapeHtml(metaLine);
  const logoUrl = `${assetBaseUrl.replace(/\/$/, "")}/logo.png`;

  const hotPill =
    band === "hot"
      ? `<span style="display:inline-block;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:600;border:1px solid rgba(165,214,167,0.85);background:rgba(165,214,167,0.45);color:#1b5e20;">&#128293; Hot</span>`
      : band === "warm"
        ? `<span style="display:inline-block;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:600;border:1px solid rgba(255,214,165,0.9);background:rgba(255,243,224,0.9);color:#e65100;">&#128993; Warm</span>`
        : `<span style="display:inline-block;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:600;border:1px solid #e5e7eb;background:#f3f4f6;color:#374151;">${escapeHtml(scoreLabel)}</span>`;

  const recentPill = recent
    ? `<span style="display:inline-block;padding:6px 10px;border-radius:10px;font-size:12px;font-weight:600;border:1px solid rgba(191,219,254,0.95);background:rgba(219,234,254,0.95);color:#1d4ed8;margin-left:6px;">&#128338; Recent</span>`
    : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <tr>
            <td style="padding:28px 28px 8px 28px;text-align:center;">
              <img src="${escapeHtml(logoUrl)}" alt="Leadsnipe" width="40" height="40" style="display:inline-block;vertical-align:middle;border-radius:10px;" />
              <span style="display:inline-block;vertical-align:middle;font-size:20px;font-weight:700;letter-spacing:-0.02em;margin-left:10px;color:#111827;">Leadsnipe</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 24px 28px;">
              <p style="margin:0 0 8px 0;font-size:16px;line-height:1.5;color:#111827;">Hey,</p>
              <p style="margin:0 0 24px 0;font-size:16px;line-height:1.55;color:#374151;">
                You have <strong style="color:#111827;">${count}</strong> new lead${count === 1 ? "" : "s"} in your dashboard, ready for a reply.
              </p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e5e7eb;border-radius:14px;">
                <tr>
                  <td style="padding:18px 18px 14px 18px;">
                    <div style="margin-bottom:10px;">${hotPill}${recentPill}</div>
                    <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">${safeMeta}</div>
                    <div style="font-size:17px;font-weight:700;line-height:1.35;color:#111827;margin-bottom:10px;">${safeTitle}</div>
                    ${safeSnippet ? `<p style="margin:0 0 14px 0;font-size:14px;line-height:1.5;color:#4b5563;">${safeSnippet}</p>` : ""}
                    ${link ? `<a href="${safeUrl}" style="color:#ff4500;font-weight:600;font-size:14px;text-decoration:none;">View on Reddit</a>` : ""}
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr>
                  <td align="center">
                    <a href="${safeDash}" style="display:inline-block;padding:14px 28px;background:#ff4500;color:#ffffff !important;font-weight:700;font-size:15px;text-decoration:none;border-radius:9999px;min-width:200px;text-align:center;">Go to dashboard</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * After a successful saved-search cron run: optionally email the user (≤1 digest per UTC day by default).
 * Set `CRON_DIGEST_DISABLE_DAILY_CAP=true` to allow repeated sends the same UTC day (testing only).
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

  if (!isCronDigestDailyCapDisabled() && digestAlreadySentTodayUtc(saved.last_digest_sent_at)) {
    return;
  }

  if (!isMailConfigured()) {
    console.warn("cron digest: SMTP not configured; skip send");
    return;
  }

  const topLead = matching[0];
  const base = getBaseUrl().replace(/\/$/, "");
  const dashboardUrl = `${base}/dashboard`;
  const { subject, text, html } = buildDigestMail({
    count: matching.length,
    topLead,
    dashboardUrl,
    assetBaseUrl: base,
  });

  try {
    await sendTransactionalMail({ to: user.email.trim(), subject, text, html });
    markSavedSearchDigestSentAt(savedSearchId, new Date().toISOString());
  } catch (e) {
    console.error("cron digest: send failed", e);
  }
}
