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
  migrateLeadActions(database);
  migrateLeadFeedback(database);
  migrateLandingLeadFeedback(database);
  migrateSavedSearches(database);
  migrateServiceStatus(database);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_post_intent_is_high_intent ON post_intent(is_high_intent)`);
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
  status: "pending" | "running" | "completed" | "failed" = "running"
): void {
  const database = getDb();
  const ctx = typeof context === "string" ? context.trim() : "";
  database
    .prepare(
      `INSERT INTO runs (id, user_input, context, keywords, status, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(runId, userInput, ctx || null, JSON.stringify(keywords), status);
}

export function updateRunStatus(
  runId: string,
  status: "pending" | "running" | "completed" | "failed"
): void {
  getDb()
    .prepare(`UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, runId);
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
  created_at: string;
  updated_at: string;
}

export function findUserByEmail(email: string): UserRow | undefined {
  const row = getDb().prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
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

export function attachRunToUser(runId: string, userId: string): void {
  getDb().prepare("UPDATE runs SET user_id = ?, updated_at = datetime('now') WHERE id = ?").run(userId, runId);
}

export function getRunById(runId: string): { id: string; user_id: string | null; user_input: string; context: string | null } | undefined {
  const row = getDb()
    .prepare("SELECT id, user_id, user_input, context FROM runs WHERE id = ?")
    .get(runId) as { id: string; user_id: string | null; user_input: string; context: string | null } | undefined;
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
  limit: number = 50
): { id: string; user_input: string; context: string | null; created_at: string }[] {
  const rows = getDb()
    .prepare(
      "SELECT id, user_input, context, created_at FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(userId, limit) as { id: string; user_input: string; context: string | null; created_at: string }[];
  return rows;
}

/** All leads for a user (from all their runs), ranked by intent then time. Excludes deleted unless includeArchived. */
export function getLeadsForUser(
  userId: string,
  limit: number = 200,
  filters: LeadFilters = {}
): LeadRow[] {
  const { subreddit, days, minScore, query, runId, includeArchived, includeDeleted } = filters;
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
  enabled: number;
  interval_minutes: number;
  last_run_at: string | null;
  next_run_at: string;
  last_run_status: string | null;
  last_error: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export function upsertSavedSearchForUser(
  userId: string,
  query: string,
  context: string | null,
  intervalMinutes: number = 60
): void {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return;
  const normalizedContext = typeof context === "string" && context.trim() ? context.trim() : null;
  const safeInterval = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? Math.floor(intervalMinutes) : 60;
  const nextRunIso = new Date(Date.now() + safeInterval * 60_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO saved_searches (
        id, user_id, query, context, enabled, interval_minutes, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        query = excluded.query,
        context = excluded.context,
        enabled = 1,
        interval_minutes = excluded.interval_minutes,
        next_run_at = excluded.next_run_at,
        updated_at = datetime('now')`
    )
    .run(randomUUID(), userId, trimmedQuery, normalizedContext, safeInterval, nextRunIso);
}

export function getSavedSearchForUser(userId: string): SavedSearchRow | null {
  const row = getDb()
    .prepare("SELECT * FROM saved_searches WHERE user_id = ? LIMIT 1")
    .get(userId) as SavedSearchRow | undefined;
  return row ?? null;
}

export function claimDueSavedSearches(
  limit: number = 10,
  leaseMinutes: number = 20,
  force: boolean = false
): SavedSearchRow[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
  const safeLease = Number.isFinite(leaseMinutes) && leaseMinutes > 0 ? Math.floor(leaseMinutes) : 20;
  const leaseIso = new Date(Date.now() + safeLease * 60_000).toISOString();
  const database = getDb();
  const dueClause = force ? "1 = 1" : "datetime(next_run_at) <= datetime('now')";
  const dueRows = database
    .prepare(
      `SELECT * FROM saved_searches
       WHERE enabled = 1
         AND ${dueClause}
         AND (locked_until IS NULL OR datetime(locked_until) <= datetime('now'))
       ORDER BY datetime(next_run_at) ASC
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

// --- Service status checks (shared uptime history) ---

export type ServiceStatusState = "ok" | "warn" | "down";

export interface ServiceStatusPoint {
  state: ServiceStatusState;
  status_code: number | null;
  latency_ms: number | null;
  checked_at: string;
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
