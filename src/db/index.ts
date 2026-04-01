/**
 * SQLite database and schema. No server needed—uses a single file (e.g. data/reddit-leads.db).
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDatabaseUrl } from "../config.js";
import type { RedditPost, RedditComment } from "../types.js";

let db: Database.Database | null = null;

function ensureDbDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getDb(): Database.Database {
  if (!db) {
    const path = getDatabaseUrl();
    if (!path.includes(":") || path.startsWith(".") || path.startsWith("/")) {
      ensureDbDir(path);
    }
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    runSchema(db);
  }
  return db;
}

function runSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      user_input TEXT NOT NULL,
      context TEXT,
      keywords TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      reddit_id TEXT NOT NULL,
      subreddit TEXT,
      title TEXT,
      selftext TEXT,
      score INTEGER,
      num_comments INTEGER,
      permalink TEXT,
      full_link TEXT,
      author TEXT,
      created_utc INTEGER,
      url TEXT,
      is_self INTEGER,
      over_18 INTEGER,
      link_flair_text TEXT,
      matched_keywords TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, reddit_id),
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      reddit_id TEXT,
      body TEXT,
      author TEXT,
      score INTEGER,
      created_utc INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES posts(id)
    );

    CREATE TABLE IF NOT EXISTS post_intent (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      score REAL,
      reasoning TEXT,
      suggested_reply TEXT,
      is_high_intent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES posts(id)
    );

    CREATE TABLE IF NOT EXISTS comment_intent (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      score REAL,
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (comment_id) REFERENCES comments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_run_id ON posts(run_id);
    CREATE INDEX IF NOT EXISTS idx_posts_reddit_id ON posts(reddit_id);
    CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_post_intent_post_id ON post_intent(post_id);
    CREATE INDEX IF NOT EXISTS idx_comment_intent_comment_id ON comment_intent(comment_id);
    CREATE INDEX IF NOT EXISTS idx_post_intent_label ON post_intent(label);
    CREATE INDEX IF NOT EXISTS idx_comment_intent_label ON comment_intent(label);
  `);
  migratePostIntent(database);
  migrateUsersAndSessions(database);
  migrateStripeSubscriptionColumns(database);
  migrateSearchProfiles(database);
  migrateLeadActions(database);
  migrateLeadFeedback(database);
  migrateLandingLeadFeedback(database);
  migrateSavedSearches(database);
  migrateSavedSearchProfileLink(database);
  migrateSavedSearchEmailAlerts(database);
  migrateServiceStatus(database);
  migrateManualSearchQuota(database);
  migrateRunPipelineProgress(database);
  migrateRunSource(database);
  migrateRunHomepageCandidateCount(database);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_post_intent_is_high_intent ON post_intent(is_high_intent)`);
}

function migrateRunPipelineProgress(database: Database.Database): void {
  const cols = (database.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes("pipeline_phase")) {
    database.exec("ALTER TABLE runs ADD COLUMN pipeline_phase TEXT");
  }
  if (!cols.includes("pipeline_error")) {
    database.exec("ALTER TABLE runs ADD COLUMN pipeline_error TEXT");
  }
}

function migrateRunSource(database: Database.Database): void {
  const cols = (database.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes("source")) {
    database.exec("ALTER TABLE runs ADD COLUMN source TEXT");
  }
  database.exec("UPDATE runs SET source = 'dashboard' WHERE source IS NULL");
}

function migrateRunHomepageCandidateCount(database: Database.Database): void {
  const cols = (database.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  if (!cols.includes("homepage_candidate_count")) {
    database.exec("ALTER TABLE runs ADD COLUMN homepage_candidate_count INTEGER");
  }
}

/** Landing pipeline: `recentCandidates.length` for UI “threads scanned”. */
export function setRunHomepageCandidateCount(runId: string, count: number): void {
  getDb()
    .prepare(`UPDATE runs SET homepage_candidate_count = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(Math.max(0, Math.floor(count)), runId);
}

function migrateLeadActions(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS lead_actions (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_lead_actions_user_id ON lead_actions(user_id)`);
}

function migrateLeadFeedback(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS lead_feedback (
      user_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      vote INTEGER NOT NULL CHECK (vote IN (1, -1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_lead_feedback_user_id ON lead_feedback(user_id)`);
}

function migrateLandingLeadFeedback(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS landing_lead_feedback (
      run_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      vote INTEGER NOT NULL CHECK (vote IN (1, -1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, post_id),
      FOREIGN KEY (run_id) REFERENCES runs(id)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_landing_lead_feedback_run_id ON landing_lead_feedback(run_id)`);
}

function migrateSavedSearches(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      query TEXT NOT NULL,
      context TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      last_run_status TEXT,
      last_error TEXT,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_saved_searches_user_id ON saved_searches(user_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_saved_searches_next_run ON saved_searches(next_run_at)`);
}

/** Links cron to the user's current search profile only (see claimDueSavedSearches). */
function migrateSavedSearchProfileLink(database: Database.Database): void {
  const cols = (database.prepare("PRAGMA table_info(saved_searches)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("search_profile_id")) {
    database.exec("ALTER TABLE saved_searches ADD COLUMN search_profile_id TEXT REFERENCES search_profiles(id)");
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_saved_searches_profile_id ON saved_searches(search_profile_id)`);
  database.exec(`
    UPDATE saved_searches SET search_profile_id = (
      SELECT sp.id FROM search_profiles sp
      WHERE sp.user_id = saved_searches.user_id AND sp.is_current = 1
      LIMIT 1
    )
    WHERE search_profile_id IS NULL
      AND EXISTS (SELECT 1 FROM search_profiles sp2 WHERE sp2.user_id = saved_searches.user_id AND sp2.is_current = 1)
  `);
}

/** Default alert types: all categories on (any intent score &gt; 70). */
export const DEFAULT_EMAIL_ALERT_TYPES_JSON = '{"hot":true,"warm":true,"recent":true}';

function migrateSavedSearchEmailAlerts(database: Database.Database): void {
  const cols = (database.prepare("PRAGMA table_info(saved_searches)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("email_alerts_enabled")) {
    database.exec("ALTER TABLE saved_searches ADD COLUMN email_alerts_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes("email_alert_types_json")) {
    database.exec(
      `ALTER TABLE saved_searches ADD COLUMN email_alert_types_json TEXT NOT NULL DEFAULT '${DEFAULT_EMAIL_ALERT_TYPES_JSON}'`
    );
  }
  if (!cols.includes("last_digest_sent_at")) {
    database.exec("ALTER TABLE saved_searches ADD COLUMN last_digest_sent_at TEXT");
  }
}

function migrateSearchProfiles(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS search_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      query TEXT NOT NULL,
      context TEXT,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_search_profiles_user_id ON search_profiles(user_id)`);
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_search_profiles_current_user ON search_profiles(user_id) WHERE is_current = 1`);

  const runCols = (database.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  if (!runCols.includes("search_profile_id")) {
    database.exec("ALTER TABLE runs ADD COLUMN search_profile_id TEXT REFERENCES search_profiles(id)");
  }
  const userCols = (database.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((r) => r.name);
  if (!userCols.includes("current_search_profile_id")) {
    database.exec("ALTER TABLE users ADD COLUMN current_search_profile_id TEXT REFERENCES search_profiles(id)");
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_runs_search_profile_id ON runs(search_profile_id)`);
}

function migratePostIntent(database: Database.Database): void {
  const columns = (database.prepare("PRAGMA table_info(post_intent)").all() as { name: string }[]).map((r) => r.name);
  if (!columns.includes("suggested_reply")) database.exec("ALTER TABLE post_intent ADD COLUMN suggested_reply TEXT");
  if (!columns.includes("is_high_intent")) database.exec("ALTER TABLE post_intent ADD COLUMN is_high_intent INTEGER NOT NULL DEFAULT 0");
}

function migrateUsersAndSessions(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      stripe_customer_id TEXT,
      entitled_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_magic_links_expires_at ON magic_links(expires_at);
  `);
  const runCols = (database.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  if (!runCols.includes("user_id")) {
    database.exec("ALTER TABLE runs ADD COLUMN user_id TEXT REFERENCES users(id)");
  }
  if (!runCols.includes("context")) {
    database.exec("ALTER TABLE runs ADD COLUMN context TEXT");
  }

  const userCols = (database.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((r) => r.name);
  if (!userCols.includes("entitled_until")) {
    database.exec("ALTER TABLE users ADD COLUMN entitled_until TEXT");
  }

  // Backfill: for existing Stripe customers, give them a short entitlement window.
  // This prevents older paid users from suddenly being locked out.
  database.exec(
    "UPDATE users SET entitled_until = datetime('now','+30 days') WHERE entitled_until IS NULL AND stripe_customer_id IS NOT NULL"
  );
  database.exec(`CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)`);
}

function migrateStripeSubscriptionColumns(database: Database.Database): void {
  const userCols = (database.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((r) => r.name);
  if (!userCols.includes("stripe_subscription_id")) {
    database.exec("ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT");
  }
  if (!userCols.includes("subscription_status")) {
    database.exec("ALTER TABLE users ADD COLUMN subscription_status TEXT");
  }
  if (!userCols.includes("subscription_cancel_at_period_end")) {
    database.exec("ALTER TABLE users ADD COLUMN subscription_cancel_at_period_end INTEGER NOT NULL DEFAULT 0");
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_users_stripe_subscription_id ON users(stripe_subscription_id)`);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Pipeline write helpers ---

export function insertRun(
  runId: string,
  userInput: string,
  keywords: string[],
  context?: string,
  status: "pending" | "running" | "completed" | "failed" = "running",
  source: "homepage" | "dashboard" | "cron" | "cli" = "dashboard"
): void {
  const database = getDb();
  const ctx = typeof context === "string" ? context.trim() : "";
  database
    .prepare(
      `INSERT INTO runs (id, user_input, context, keywords, status, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(runId, userInput, ctx || null, JSON.stringify(keywords), status, source);
}

export function updateRunStatus(
  runId: string,
  status: "pending" | "running" | "completed" | "failed"
): void {
  getDb()
    .prepare(`UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, runId);
}

export function updateRunKeywords(runId: string, keywords: string[]): void {
  getDb()
    .prepare(`UPDATE runs SET keywords = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(keywords), runId);
}

/** Dashboard/cron UI: mapping → collecting → quality → intent. Cleared when run finishes. */
export function updateRunPipelinePhase(runId: string, phase: string | null): void {
  getDb()
    .prepare(`UPDATE runs SET pipeline_phase = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(phase, runId);
}

export function setRunPipelineError(runId: string, message: string | null): void {
  getDb()
    .prepare(`UPDATE runs SET pipeline_error = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(message, runId);
}

export function getPostCountForRun(runId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as c FROM posts WHERE run_id = ?`)
    .get(runId) as { c: number } | undefined;
  return row?.c ?? 0;
}

export function getRunProgressForUser(
  runId: string,
  userId: string
): {
  status: string;
  pipeline_phase: string | null;
  pipeline_error: string | null;
  totalPosts: number | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT status, pipeline_phase, pipeline_error FROM runs WHERE id = ? AND user_id = ?`
    )
    .get(runId, userId) as
    | { status: string; pipeline_phase: string | null; pipeline_error: string | null }
    | undefined;
  if (!row) return null;
  const totalPosts = row.status === "completed" ? getPostCountForRun(runId) : null;
  return { ...row, totalPosts };
}

/** Public landing poll: only `source = homepage` (runId is unguessable UUID). */
export function getRunProgressForHomepage(runId: string): {
  status: string;
  pipeline_phase: string | null;
  pipeline_error: string | null;
  totalPosts: number | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT status, pipeline_phase, pipeline_error FROM runs WHERE id = ? AND source = 'homepage'`
    )
    .get(runId) as
    | { status: string; pipeline_phase: string | null; pipeline_error: string | null }
    | undefined;
  if (!row) return null;
  const totalPosts = row.status === "completed" ? getPostCountForRun(runId) : null;
  return { ...row, totalPosts };
}

export function getHomepageRunRow(
  runId: string
): {
  status: string;
  user_input: string;
  keywords: string;
  pipeline_error: string | null;
  homepage_candidate_count: number | null;
} | null {
  const row = getDb()
    .prepare(
      `SELECT status, user_input, keywords, pipeline_error, homepage_candidate_count FROM runs WHERE id = ? AND source = 'homepage'`
    )
    .get(runId) as
    | {
        status: string;
        user_input: string;
        keywords: string;
        pipeline_error: string | null;
        homepage_candidate_count: number | null;
      }
    | undefined;
  return row ?? null;
}

/** Post row id = runId_redditId for uniqueness and FK from comments */
function postRowId(runId: string, redditId: string): string {
  return `${runId}_${redditId}`;
}

export function insertPost(
  runId: string,
  post: RedditPost,
  matchedKeywords: string[]
): void {
  const id = postRowId(runId, post.id ?? "");
  const database = getDb();
  database
    .prepare(
      `INSERT OR IGNORE INTO posts (
        id, run_id, reddit_id, subreddit, title, selftext, score, num_comments,
        permalink, full_link, author, created_utc, url, is_self, over_18, link_flair_text, matched_keywords
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      runId,
      post.id ?? "",
      post.subreddit ?? null,
      post.title ?? null,
      post.selftext ?? "",
      post.score ?? null,
      post.num_comments ?? null,
      post.permalink ?? "",
      post.full_link ?? "",
      post.author ?? null,
      post.created_utc ?? null,
      post.url ?? null,
      post.is_self != null ? (post.is_self ? 1 : 0) : null,
      post.over_18 != null ? (post.over_18 ? 1 : 0) : null,
      post.link_flair_text ?? null,
      JSON.stringify(matchedKeywords)
    );
  updatePostEngagement(id, post.score, post.num_comments);
}

/** Update post vote/comment counts (e.g. after fetching from comment page). */
export function updatePostEngagement(
  postId: string,
  score: number | null,
  numComments: number | null
): void {
  getDb()
    .prepare(`UPDATE posts SET score = ?, num_comments = ? WHERE id = ?`)
    .run(score ?? null, numComments ?? null, postId);
}

export function insertComments(runId: string, post: RedditPost, comments: RedditComment[]): void {
  const postId = postRowId(runId, post.id ?? "");
  const database = getDb();
  const stmt = database.prepare(
    `INSERT OR IGNORE INTO comments (id, post_id, reddit_id, body, author, score, created_utc) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const commentId = (c.id && c.id.trim()) ? c.id : `${postId}_c${i}`;
    stmt.run(
      commentId,
      postId,
      c.id ?? null,
      c.body ?? "",
      c.author ?? null,
      c.score ?? null,
      c.created_utc ?? null
    );
  }
}

export function insertPostIntent(
  postId: string,
  label: string,
  score: number | null,
  explanation: string | null,
  suggestedReply: string | null,
  isHighIntent: boolean
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO post_intent (id, post_id, label, score, reasoning, suggested_reply, is_high_intent) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(postId, postId, label, score ?? null, explanation ?? null, suggestedReply ?? null, isHighIntent ? 1 : 0);
}

export function insertCommentIntent(
  commentId: string,
  label: string,
  score: number | null,
  reasoning: string | null
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO comment_intent (id, comment_id, label, score, reasoning) VALUES (?, ?, ?, ?, ?)`
    )
    .run(commentId, commentId, label, score ?? null, reasoning ?? null);
}

// --- API / report: fetch leads for a run ---

export interface LeadRow {
  post_id: string;
  run_id: string;
  user_input: string;
  score: number | null;
  label: string | null;
  title: string | null;
  full_link: string;
  subreddit: string | null;
  author: string | null;
  created_utc: number | null;
  reasoning: string | null;
  suggested_reply: string | null;
  is_high_intent: number | null;
  is_archived: number | null;
  is_deleted: number | null;
  selftext: string | null;
  post_score: number | null;
  num_comments: number | null;
  feedback_vote: number | null;
}

export interface LeadFilters {
  subreddit?: string;
  days?: number;
  minScore?: number;
  query?: string;
  runId?: string;
  searchProfileId?: string;
  includeArchived?: boolean;
  includeDeleted?: boolean;
}

/** Leads for a run, ranked by intent (high first). One row per Reddit post (reddit_id) so counts are unique. */
export function getLeadsForRun(runId: string, limit: number = 100): LeadRow[] {
  const rows = getDb()
    .prepare(
      `WITH ranked AS (
         SELECT p.id AS post_id, p.run_id, r.user_input, pi.score, pi.label, p.title, p.full_link, p.subreddit, p.author, p.created_utc, pi.reasoning, pi.suggested_reply, pi.is_high_intent,
                0 AS is_archived,
                0 AS is_deleted,
                p.selftext,
                p.score AS post_score,
                COALESCE(p.num_comments, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)) AS num_comments,
                NULL AS feedback_vote,
                ROW_NUMBER() OVER (PARTITION BY p.reddit_id ORDER BY pi.score DESC NULLS LAST, p.created_utc DESC NULLS LAST, p.score DESC NULLS LAST) AS rn
         FROM posts p
         JOIN runs r ON p.run_id = r.id
         JOIN post_intent pi ON p.id = pi.post_id
         WHERE p.run_id = ?
       )
       SELECT post_id, run_id, user_input, score, label, title, full_link, subreddit, author, created_utc,
              reasoning, suggested_reply, is_high_intent, is_archived, is_deleted, selftext, post_score, num_comments, feedback_vote
       FROM ranked
       WHERE rn = 1
       ORDER BY score DESC NULLS LAST, created_utc DESC NULLS LAST, post_score DESC NULLS LAST
       LIMIT ?`
    )
    .all(runId, limit) as LeadRow[];
  return rows;
}

// --- Users & sessions (for Stripe → account creation) ---

export interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  stripe_customer_id: string | null;
  entitled_until: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  subscription_cancel_at_period_end: number;
  created_at: string;
  updated_at: string;
}

export function findUserByEmail(email: string): UserRow | undefined {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
  return row;
}

export function findUserById(userId: string): UserRow | undefined {
  const row = getDb().prepare("SELECT * FROM users WHERE id = ?").get(userId.trim()) as UserRow | undefined;
  return row;
}

export function createUser(id: string, email: string, stripeCustomerId?: string | null): void {
  getDb()
    .prepare(
      "INSERT INTO users (id, email, stripe_customer_id, entitled_until, updated_at) VALUES (?, ?, ?, null, datetime('now'))"
    )
    .run(id, email.trim().toLowerCase(), stripeCustomerId ?? null);
}

export function setStripeCustomerId(userId: string, stripeCustomerId: string | null): void {
  if (!stripeCustomerId) return;
  getDb().prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").run(stripeCustomerId, userId);
}

export function setEntitledUntil(userId: string, isoDatetime: string | null = null): void {
  const entitled = isoDatetime ?? null;
  getDb()
    .prepare(`UPDATE users SET entitled_until = ? WHERE id = ?`)
    .run(entitled, userId);
}

/** Sync Stripe Subscription fields + access end (`entitled_until` = end of current paid period). */
export function setSubscriptionFromStripe(
  userId: string,
  opts: {
    entitledUntilIso: string | null;
    stripeSubscriptionId: string | null;
    status: string | null;
    cancelAtPeriodEnd: boolean;
  }
): void {
  getDb()
    .prepare(
      `UPDATE users SET
        entitled_until = ?,
        stripe_subscription_id = ?,
        subscription_status = ?,
        subscription_cancel_at_period_end = ?,
        updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(
      opts.entitledUntilIso,
      opts.stripeSubscriptionId,
      opts.status,
      opts.cancelAtPeriodEnd ? 1 : 0,
      userId
    );
}

export function clearStripeSubscription(userId: string): void {
  getDb()
    .prepare(
      `UPDATE users SET
        stripe_subscription_id = NULL,
        subscription_status = 'canceled',
        subscription_cancel_at_period_end = 0,
        updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(userId);
}

export function findUserByStripeSubscriptionId(subscriptionId: string): UserRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE stripe_subscription_id = ? LIMIT 1")
    .get(subscriptionId.trim()) as UserRow | undefined;
  return row;
}

export function findUserByStripeCustomerId(customerId: string): UserRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM users WHERE stripe_customer_id = ? LIMIT 1")
    .get(customerId.trim()) as UserRow | undefined;
  return row;
}

export function attachRunToUser(runId: string, userId: string): void {
  getDb().prepare("UPDATE runs SET user_id = ?, updated_at = datetime('now') WHERE id = ?").run(userId, runId);
}

export function getRunById(
  runId: string
):
  | {
      id: string;
      user_id: string | null;
      user_input: string;
      context: string | null;
      search_profile_id: string | null;
      source: string | null;
      created_at: string;
    }
  | undefined {
  const row = getDb()
    .prepare(
      "SELECT id, user_id, user_input, context, search_profile_id, source, created_at FROM runs WHERE id = ?"
    )
    .get(runId) as
    | {
        id: string;
        user_id: string | null;
        user_input: string;
        context: string | null;
        search_profile_id: string | null;
        source: string | null;
        created_at: string;
      }
    | undefined;
  return row;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createSession(userId: string): { id: string; expiresAt: string } {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getDb()
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .run(id, userId, expiresAt);
  return { id, expiresAt };
}

export function getSession(sessionId: string): { user_id: string; email: string; entitled_until: string | null } | null {
  const row = getDb()
    .prepare(
      `SELECT s.user_id, u.email, u.entitled_until FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.expires_at > datetime('now')`
    )
    .get(sessionId) as { user_id: string; email: string; entitled_until: string | null } | undefined;
  return row ?? null;
}

export function deleteSession(sessionId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function createMagicLink(
  token: string,
  userId: string,
  expiresAtIso: string
): void {
  getDb()
    .prepare("INSERT INTO magic_links (token, user_id, expires_at, used_at) VALUES (?, ?, ?, null)")
    .run(token, userId, expiresAtIso);
}

export function consumeMagicLink(token: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT user_id FROM magic_links WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')"
    )
    .get(token) as { user_id: string } | undefined;

  if (!row) return null;

  getDb().prepare("UPDATE magic_links SET used_at = datetime('now') WHERE token = ?").run(token);
  return row.user_id;
}

/** All runs for a user, most recent first. */
export function getRunsForUser(
  userId: string,
  limit: number = 50,
  searchProfileId?: string
): {
  id: string;
  user_input: string;
  context: string | null;
  created_at: string;
  status: string;
  source: string | null;
}[] {
  const database = getDb();
  type RunListRow = {
    id: string;
    user_input: string;
    context: string | null;
    created_at: string;
    status: string;
    source: string | null;
  };
  if (!searchProfileId?.trim()) return [];
  return database
    .prepare(
      "SELECT id, user_input, context, created_at, status, source FROM runs WHERE user_id = ? AND search_profile_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, searchProfileId.trim(), limit) as RunListRow[];
}

/** All leads for a user (from all their runs), ranked by intent then time. Excludes deleted unless includeArchived. */
export function getLeadsForUser(
  userId: string,
  limit: number = 200,
  filters: LeadFilters = {}
): LeadRow[] {
  const { subreddit, days, minScore, query, runId, searchProfileId, includeArchived, includeDeleted } = filters;
  const conditions: string[] = ["r.user_id = ?"];
  const params: (string | number)[] = [userId];

  // By default, keep deleted leads out of the dashboard.
  // When includeDeleted=true, we return both deleted and non-deleted leads.
  if (!includeDeleted) {
    conditions.push(`(la.action IS NULL OR la.action != 'deleted')`);
  }
  if (!includeArchived) {
    conditions.push(`(la.action IS NULL OR la.action != 'archived')`);
  }
  if (subreddit != null && subreddit.trim() !== "") {
    conditions.push("LOWER(TRIM(p.subreddit)) = LOWER(TRIM(?))");
    params.push(subreddit.trim());
  }
  if (days != null && Number.isFinite(days) && days > 0) {
    conditions.push("p.created_utc >= ?");
    params.push(Math.floor(Date.now() / 1000 - days * 86400));
  }
  if (minScore != null && Number.isFinite(minScore)) {
    conditions.push("(pi.score IS NOT NULL AND pi.score >= ?)");
    params.push(minScore);
  }
  if (query != null && query.trim() !== "") {
    conditions.push("TRIM(r.user_input) = ?");
    params.push(query.trim());
  }
  if (runId != null && runId.trim() !== "") {
    conditions.push("p.run_id = ?");
    params.push(runId.trim());
  }
  if (searchProfileId != null && searchProfileId.trim() !== "") {
    conditions.push("r.search_profile_id = ?");
    params.push(searchProfileId.trim());
  }

  const whereClause = conditions.join(" AND ");
  params.push(limit);
  const allParams = [userId, userId, ...params];

  /* One row per Reddit post (reddit_id): same post from multiple runs was shown multiple times. */
  const rows = getDb()
    .prepare(
      `WITH ranked AS (
         SELECT p.id AS post_id, p.run_id, r.user_input, pi.score, pi.label, p.title, p.full_link, p.subreddit, p.author, p.created_utc,
                pi.reasoning, pi.suggested_reply, pi.is_high_intent,
                CASE WHEN la.action = 'archived' THEN 1 ELSE 0 END AS is_archived,
                CASE WHEN la.action = 'deleted' THEN 1 ELSE 0 END AS is_deleted,
                p.selftext,
                p.score AS post_score,
                COALESCE(p.num_comments, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)) AS num_comments,
                lf.vote AS feedback_vote,
                ROW_NUMBER() OVER (PARTITION BY p.reddit_id ORDER BY pi.score DESC NULLS LAST, p.created_utc DESC NULLS LAST, p.score DESC NULLS LAST) AS rn
         FROM posts p
         JOIN runs r ON p.run_id = r.id
         JOIN post_intent pi ON p.id = pi.post_id
         LEFT JOIN lead_actions la ON la.user_id = ? AND la.post_id = p.id
         LEFT JOIN lead_feedback lf ON lf.user_id = ? AND lf.post_id = p.id
         WHERE ${whereClause}
       )
       SELECT post_id, run_id, user_input, score, label, title, full_link, subreddit, author, created_utc,
              reasoning, suggested_reply, is_high_intent, is_archived, is_deleted, selftext, post_score, num_comments, feedback_vote
       FROM ranked
       WHERE rn = 1
       ORDER BY score DESC NULLS LAST, created_utc DESC NULLS LAST, post_score DESC NULLS LAST
       LIMIT ?`
    )
    .all(...allParams) as LeadRow[];
  return rows;
}

/**
 * Leads from a cron run that are new to the user's dashboard: intent &gt; 70, not user-deleted,
 * and no older run (same profile) already had the same reddit_id above the same bar.
 */
export function getCronDigestNewLeads(runId: string, userId: string): LeadRow[] {
  const rows = getDb()
    .prepare(
      `SELECT p.id AS post_id, p.run_id, r.user_input, pi.score, pi.label, p.title, p.full_link, p.subreddit, p.author, p.created_utc,
              pi.reasoning, pi.suggested_reply, pi.is_high_intent,
              0 AS is_archived, 0 AS is_deleted, p.selftext, p.score AS post_score,
              COALESCE(p.num_comments, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)) AS num_comments,
              NULL AS feedback_vote
       FROM posts p
       JOIN runs r ON p.run_id = r.id
       JOIN post_intent pi ON p.id = pi.post_id
       LEFT JOIN lead_actions la ON la.user_id = ? AND la.post_id = p.id
       WHERE p.run_id = ?
         AND r.user_id = ?
         AND r.source = 'cron'
         AND pi.score IS NOT NULL
         AND pi.score > 70
         AND r.search_profile_id IS NOT NULL
         AND (la.action IS NULL OR la.action != 'deleted')
         AND NOT EXISTS (
           SELECT 1 FROM posts p2
           JOIN runs r2 ON p2.run_id = r2.id
           JOIN post_intent pi2 ON p2.id = pi2.post_id
           WHERE r2.user_id = ?
             AND r2.search_profile_id = r.search_profile_id
             AND datetime(r2.created_at) < datetime(r.created_at)
             AND p2.reddit_id = p.reddit_id
             AND pi2.score IS NOT NULL AND pi2.score > 70
         )
       ORDER BY pi.score DESC, p.created_utc DESC NULLS LAST, p.score DESC NULLS LAST`
    )
    .all(userId, runId, userId, userId) as LeadRow[];
  return rows;
}

/** Archive or delete a lead for a user. */
export function setLeadAction(
  userId: string,
  postId: string,
  action: "archived" | "deleted"
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO lead_actions (user_id, post_id, action, created_at) VALUES (?, ?, ?, datetime('now'))`
    )
    .run(userId, postId, action);
}

/** Remove a lead action (used to "unarchive" back to active). */
export function clearLeadAction(userId: string, postId: string): void {
  getDb()
    .prepare(`DELETE FROM lead_actions WHERE user_id = ? AND post_id = ?`)
    .run(userId, postId);
}

/** Save lead-quality feedback vote for a user/post. Pass null to clear vote. */
export function setLeadFeedback(userId: string, postId: string, vote: 1 | -1 | null): void {
  const database = getDb();
  if (vote == null) {
    database.prepare("DELETE FROM lead_feedback WHERE user_id = ? AND post_id = ?").run(userId, postId);
    return;
  }
  database
    .prepare(
      `INSERT INTO lead_feedback (user_id, post_id, vote, created_at, updated_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id, post_id) DO UPDATE SET vote = excluded.vote, updated_at = datetime('now')`
    )
    .run(userId, postId, vote);
}

export function getLeadFeedbackVote(userId: string, postId: string): 1 | -1 | null {
  const row = getDb()
    .prepare("SELECT vote FROM lead_feedback WHERE user_id = ? AND post_id = ?")
    .get(userId, postId) as { vote: number } | undefined;
  if (!row) return null;
  if (row.vote === 1) return 1;
  if (row.vote === -1) return -1;
  return null;
}

export function isPostInRun(postId: string, runId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM posts WHERE id = ? AND run_id = ? LIMIT 1")
    .get(postId, runId) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

/** Save landing-page lead feedback once per (run, post). */
export function setLandingLeadFeedback(runId: string, postId: string, vote: 1 | -1): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO landing_lead_feedback (run_id, post_id, vote, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    )
    .run(runId, postId, vote);
  return info.changes > 0;
}

export interface SavedSearchRow {
  id: string;
  user_id: string;
  query: string;
  context: string | null;
  search_profile_id: string | null;
  enabled: number;
  interval_minutes: number;
  last_run_at: string | null;
  next_run_at: string;
  last_run_status: string | null;
  last_error: string | null;
  locked_until: string | null;
  email_alerts_enabled: number;
  email_alert_types_json: string;
  last_digest_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailAlertTypes {
  hot: boolean;
  warm: boolean;
  recent: boolean;
}

export function parseEmailAlertTypesJson(raw: string | null | undefined): EmailAlertTypes {
  const all: EmailAlertTypes = { hot: true, warm: true, recent: true };
  if (typeof raw !== "string" || !raw.trim()) return all;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      hot: typeof o.hot === "boolean" ? o.hot : true,
      warm: typeof o.warm === "boolean" ? o.warm : true,
      recent: typeof o.recent === "boolean" ? o.recent : true,
    };
  } catch {
    return all;
  }
}

export interface SearchProfileRow {
  id: string;
  user_id: string;
  query: string;
  context: string | null;
  is_current: number;
  created_at: string;
  updated_at: string;
}

function normalizeQueryForProfile(query: string): string {
  return (query || "").trim();
}

/** Same product URL / text → same identity so minor URL variants share one profile. */
function identityKeyForSearchInput(query: string): string {
  const trimmed = (query || "").trim();
  if (!trimmed) return "";
  if (/\s/.test(trimmed)) {
    return trimmed.toLowerCase().replace(/\s+/g, " ").trim();
  }
  try {
    const withProto = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    const u = new URL(withProto);
    if (u.hostname && u.hostname.includes(".")) {
      return u.hostname.replace(/^www\./i, "").toLowerCase();
    }
  } catch {
    /* not a URL */
  }
  return trimmed.toLowerCase();
}

function normalizeContextForProfile(context: string | null): string | null {
  if (typeof context !== "string") return null;
  const trimmed = context.trim();
  return trimmed || null;
}

function repairCurrentProfileFromSavedSearch(userId: string): SearchProfileRow | null {
  const database = getDb();
  const hasCurrent = database
    .prepare("SELECT 1 AS ok FROM search_profiles WHERE user_id = ? AND is_current = 1 LIMIT 1")
    .get(userId) as { ok?: number } | undefined;
  if (hasCurrent) return null;
  const saved = getSavedSearchForUser(userId);
  if (!saved?.search_profile_id?.trim()) return null;
  const prof = database
    .prepare("SELECT * FROM search_profiles WHERE id = ? AND user_id = ? LIMIT 1")
    .get(saved.search_profile_id.trim(), userId) as SearchProfileRow | undefined;
  if (!prof) return null;
  const tx = database.transaction(() => {
    database
      .prepare("UPDATE search_profiles SET is_current = 0, updated_at = datetime('now') WHERE user_id = ?")
      .run(userId);
    database
      .prepare("UPDATE search_profiles SET is_current = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(prof.id, userId);
    database.prepare("UPDATE users SET current_search_profile_id = ? WHERE id = ?").run(prof.id, userId);
  });
  tx();
  return database
    .prepare("SELECT * FROM search_profiles WHERE user_id = ? AND is_current = 1 LIMIT 1")
    .get(userId) as SearchProfileRow | null;
}

export function getCurrentSearchProfileForUser(userId: string): SearchProfileRow | null {
  const row = getDb()
    .prepare("SELECT * FROM search_profiles WHERE user_id = ? AND is_current = 1 LIMIT 1")
    .get(userId) as SearchProfileRow | undefined;
  if (row) return row;
  return repairCurrentProfileFromSavedSearch(userId);
}

/**
 * Keep dashboard view anchored to the latest run's profile (across login paths).
 * Returns the effective current profile after sync.
 */
export function syncCurrentSearchProfileToLatestRun(userId: string): SearchProfileRow | null {
  const database = getDb();
  const latestRun = database
    .prepare(
      `SELECT search_profile_id FROM runs
       WHERE user_id = ? AND search_profile_id IS NOT NULL
       ORDER BY datetime(created_at) DESC
       LIMIT 1`
    )
    .get(userId) as { search_profile_id: string | null } | undefined;
  if (!latestRun?.search_profile_id?.trim()) {
    return getCurrentSearchProfileForUser(userId);
  }
  const latestProfileId = latestRun.search_profile_id.trim();
  const latestProfile = database
    .prepare("SELECT * FROM search_profiles WHERE id = ? AND user_id = ? LIMIT 1")
    .get(latestProfileId, userId) as SearchProfileRow | undefined;
  if (!latestProfile) {
    return getCurrentSearchProfileForUser(userId);
  }

  const current = getCurrentSearchProfileForUser(userId);
  if (current?.id === latestProfile.id) return current;

  const tx = database.transaction(() => {
    database
      .prepare("UPDATE search_profiles SET is_current = 0, updated_at = datetime('now') WHERE user_id = ?")
      .run(userId);
    database
      .prepare("UPDATE search_profiles SET is_current = 1, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(latestProfile.id, userId);
    database.prepare("UPDATE users SET current_search_profile_id = ? WHERE id = ?").run(latestProfile.id, userId);
  });
  tx();

  return database
    .prepare("SELECT * FROM search_profiles WHERE user_id = ? AND is_current = 1 LIMIT 1")
    .get(userId) as SearchProfileRow | null;
}

export function setRunSearchProfile(runId: string, searchProfileId: string): void {
  getDb()
    .prepare("UPDATE runs SET search_profile_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(searchProfileId, runId);
}

export function ensureCurrentSearchProfileForInput(
  userId: string,
  query: string,
  context: string | null
): SearchProfileRow | null {
  const normalizedQuery = normalizeQueryForProfile(query);
  if (!normalizedQuery) return null;
  const normalizedContext = normalizeContextForProfile(context);
  const key = identityKeyForSearchInput(normalizedQuery);
  const database = getDb();
  const current = getCurrentSearchProfileForUser(userId);
  if (
    current &&
    identityKeyForSearchInput(current.query) === key &&
    normalizeContextForProfile(current.context) === normalizedContext
  ) {
    return current;
  }

  const tx = database.transaction(() => {
    database
      .prepare("UPDATE search_profiles SET is_current = 0, updated_at = datetime('now') WHERE user_id = ? AND is_current = 1")
      .run(userId);
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO search_profiles (id, user_id, query, context, is_current, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))`
      )
      .run(id, userId, normalizedQuery, normalizedContext);
    database
      .prepare("UPDATE users SET current_search_profile_id = ? WHERE id = ?")
      .run(id, userId);
  });
  tx();
  return getCurrentSearchProfileForUser(userId);
}

export function upsertSavedSearchForUser(
  userId: string,
  query: string,
  context: string | null,
  searchProfileId: string,
  intervalMinutes: number = 60
): void {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || !searchProfileId.trim()) return;
  const normalizedContext = typeof context === "string" && context.trim() ? context.trim() : null;
  const safeInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.floor(intervalMinutes) : 60;
  const nextRunIso = new Date(Date.now() + safeInterval * 60_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO saved_searches (
        id, user_id, query, context, search_profile_id, enabled, interval_minutes, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        query = excluded.query,
        context = excluded.context,
        search_profile_id = excluded.search_profile_id,
        enabled = 1,
        interval_minutes = excluded.interval_minutes,
        next_run_at = excluded.next_run_at,
        updated_at = datetime('now')`
    )
    .run(randomUUID(), userId, trimmedQuery, normalizedContext, searchProfileId.trim(), safeInterval, nextRunIso);
}

export function getSavedSearchForUser(userId: string): SavedSearchRow | null {
  const row = getDb()
    .prepare("SELECT * FROM saved_searches WHERE user_id = ? LIMIT 1")
    .get(userId) as SavedSearchRow | undefined;
  return row ?? null;
}

/** Max rows SQLite will return in one claim; “unlimited” uses this cap (enough for all real tenants). */
const CLAIM_ALL_CAP = 2_147_483_647;

/**
 * Align one user's saved_searches row with their current search profile (id + query + context).
 * If this drifts, claimDueSavedSearches skips them (it requires search_profile_id = is_current profile).
 */
export function syncSavedSearchRowToCurrentProfile(userId: string): void {
  const database = getDb();
  const row = database
    .prepare(
      `SELECT s.id AS saved_id, sp.id AS profile_id, sp.query, sp.context
       FROM saved_searches s
       INNER JOIN search_profiles sp ON sp.user_id = s.user_id AND sp.is_current = 1
       WHERE s.user_id = ?
         AND (s.search_profile_id IS NULL OR s.search_profile_id != sp.id)`
    )
    .get(userId) as { saved_id: string; profile_id: string; query: string; context: string | null } | undefined;
  if (!row) return;
  database
    .prepare(
      `UPDATE saved_searches
       SET search_profile_id = ?, query = ?, context = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(row.profile_id, row.query, row.context, row.saved_id);
}

/** Align every saved_searches row (run before scheduler claim so all tenants are eligible). */
export function syncSavedSearchesToCurrentProfiles(): void {
  const database = getDb();
  const mismatched = database
    .prepare(
      `SELECT s.id AS saved_id, sp.id AS profile_id, sp.query, sp.context
       FROM saved_searches s
       INNER JOIN search_profiles sp ON sp.user_id = s.user_id AND sp.is_current = 1
       WHERE s.search_profile_id IS NULL OR s.search_profile_id != sp.id`
    )
    .all() as { saved_id: string; profile_id: string; query: string; context: string | null }[];

  if (mismatched.length === 0) return;

  const stmt = database.prepare(
    `UPDATE saved_searches
     SET search_profile_id = ?, query = ?, context = ?, updated_at = datetime('now')
     WHERE id = ?`
  );
  const tx = database.transaction(() => {
    for (const row of mismatched) {
      stmt.run(row.profile_id, row.query, row.context, row.saved_id);
    }
  });
  tx();
}

export function claimDueSavedSearches(
  limit: number = 0,
  leaseMinutes: number = 20,
  force: boolean = false
): SavedSearchRow[] {
  syncSavedSearchesToCurrentProfiles();
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : CLAIM_ALL_CAP;
  const safeLease = Number.isFinite(leaseMinutes) && leaseMinutes > 0 ? Math.floor(leaseMinutes) : 20;
  const leaseIso = new Date(Date.now() + safeLease * 60_000).toISOString();
  const database = getDb();
  const dueClause = force ? "1 = 1" : "datetime(next_run_at) <= datetime('now')";
  const dueRows = database
    .prepare(
      `SELECT s.* FROM saved_searches s
       WHERE s.enabled = 1
         AND ${dueClause.replace(/next_run_at/g, "s.next_run_at")}
         AND (s.locked_until IS NULL OR datetime(s.locked_until) <= datetime('now'))
         AND s.search_profile_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM search_profiles sp
           WHERE sp.id = s.search_profile_id
             AND sp.user_id = s.user_id
             AND sp.is_current = 1
         )
       ORDER BY datetime(s.next_run_at) ASC
       LIMIT ?`
    )
    .all(safeLimit) as SavedSearchRow[];

  const claimed: SavedSearchRow[] = [];
  const claimStmt = database.prepare(
    `UPDATE saved_searches
     SET locked_until = ?, updated_at = datetime('now')
     WHERE id = ?
       AND enabled = 1
       AND ${dueClause}
       AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))`
  );

  const tx = database.transaction(() => {
    for (const row of dueRows) {
      const info = claimStmt.run(leaseIso, row.id);
      if (info.changes > 0) {
        claimed.push({ ...row, locked_until: leaseIso });
      }
    }
  });
  tx();
  return claimed;
}

export function markSavedSearchRunSuccess(savedSearchId: string, intervalMinutes: number): void {
  const safeInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.floor(intervalMinutes) : 60;
  const nowIso = new Date().toISOString();
  const nextRunIso = new Date(Date.now() + safeInterval * 60_000).toISOString();
  getDb()
    .prepare(
      `UPDATE saved_searches
       SET last_run_at = ?,
           next_run_at = ?,
           last_run_status = 'ok',
           last_error = NULL,
           locked_until = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(nowIso, nextRunIso, savedSearchId);
}

export function markSavedSearchRunFailure(savedSearchId: string, errorMessage: string, retryMinutes: number = 15): void {
  const safeRetry = Number.isFinite(retryMinutes) && retryMinutes > 0 ? Math.floor(retryMinutes) : 15;
  const nowIso = new Date().toISOString();
  const nextRunIso = new Date(Date.now() + safeRetry * 60_000).toISOString();
  const err = (errorMessage || "Unknown scheduler error").slice(0, 1200);
  getDb()
    .prepare(
      `UPDATE saved_searches
       SET last_run_at = ?,
           next_run_at = ?,
           last_run_status = 'error',
           last_error = ?,
           locked_until = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(nowIso, nextRunIso, err, savedSearchId);
}

export function updateSavedSearchEmailPreferences(
  userId: string,
  enabled: boolean,
  types: EmailAlertTypes
): boolean {
  const json = JSON.stringify({ hot: types.hot, warm: types.warm, recent: types.recent });
  const info = getDb()
    .prepare(
      `UPDATE saved_searches SET email_alerts_enabled = ?, email_alert_types_json = ?, updated_at = datetime('now') WHERE user_id = ?`
    )
    .run(enabled ? 1 : 0, json, userId);
  return info.changes > 0;
}

export function markSavedSearchDigestSentAt(savedSearchId: string, sentAtIso: string): void {
  getDb()
    .prepare(`UPDATE saved_searches SET last_digest_sent_at = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(sentAtIso, savedSearchId);
}

// --- Service status checks (shared uptime history) ---

export type ServiceStatusState = "ok" | "warn" | "down";

export interface ServiceStatusPoint {
  state: ServiceStatusState;
  status_code: number | null;
  latency_ms: number | null;
  checked_at: string;
}

function migrateManualSearchQuota(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_manual_search_quota (
      user_id TEXT PRIMARY KEY,
      day_utc TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
}

function migrateServiceStatus(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS service_status_checks (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      state TEXT NOT NULL,
      status_code INTEGER,
      latency_ms INTEGER,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_service_status_service_time ON service_status_checks(service, checked_at DESC)`);
}

export function insertServiceStatusCheck(
  service: "website" | "api",
  state: ServiceStatusState,
  statusCode: number | null,
  latencyMs: number | null,
  checkedAtIso: string
): void {
  getDb()
    .prepare(
      `INSERT INTO service_status_checks (id, service, state, status_code, latency_ms, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), service, state, statusCode, latencyMs, checkedAtIso);
}

export function getRecentServiceStatusChecks(
  service: "website" | "api",
  limit: number = 30
): ServiceStatusPoint[] {
  const rows = getDb()
    .prepare(
      `SELECT state, status_code, latency_ms, checked_at
       FROM service_status_checks
       WHERE service = ?
       ORDER BY checked_at DESC
       LIMIT ?`
    )
    .all(service, limit) as ServiceStatusPoint[];
  return rows.reverse();
}

/** Max authenticated dashboard "run full search" actions per user per UTC day (abuse guard). */
export const MANUAL_DASHBOARD_SEARCH_DAILY_LIMIT = 3;

export interface ManualSearchQuotaInfo {
  used: number;
  limit: number;
  resetsAt: string;
}

function utcDayString(): string {
  return new Date().toISOString().slice(0, 10);
}

function nextUtcMidnightIso(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0)).toISOString();
}

export function getManualSearchQuota(userId: string): ManualSearchQuotaInfo {
  const database = getDb();
  const day = utcDayString();
  const row = database
    .prepare("SELECT day_utc, count FROM user_manual_search_quota WHERE user_id = ?")
    .get(userId) as { day_utc: string; count: number } | undefined;
  let used = 0;
  if (row && row.day_utc === day) used = row.count;
  return {
    used,
    limit: MANUAL_DASHBOARD_SEARCH_DAILY_LIMIT,
    resetsAt: nextUtcMidnightIso(),
  };
}

/** Increments the daily manual dashboard search counter (call only after a successful run). */
export function consumeManualDashboardSearch(userId: string): ManualSearchQuotaInfo {
  const database = getDb();
  const day = utcDayString();
  database
    .prepare(
      `INSERT INTO user_manual_search_quota (user_id, day_utc, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         day_utc = excluded.day_utc,
         count = CASE
           WHEN user_manual_search_quota.day_utc = excluded.day_utc THEN user_manual_search_quota.count + 1
           ELSE 1
         END`
    )
    .run(userId, day);
  return getManualSearchQuota(userId);
}
