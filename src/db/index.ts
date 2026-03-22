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
                ROW_NUMBER() OVER (PARTITION BY p.reddit_id ORDER BY pi.score DESC NULLS LAST, p.created_utc DESC NULLS LAST, p.score DESC NULLS LAST) AS rn
         FROM posts p
         JOIN runs r ON p.run_id = r.id
         JOIN post_intent pi ON p.id = pi.post_id
         WHERE p.run_id = ?
       )
       SELECT post_id, run_id, user_input, score, label, title, full_link, subreddit, author, created_utc,
              reasoning, suggested_reply, is_high_intent, is_archived, is_deleted, selftext, post_score, num_comments
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

export function getRunById(runId: string): { id: string; user_id: string | null; user_input: string } | undefined {
  const row = getDb()
    .prepare("SELECT id, user_id, user_input FROM runs WHERE id = ?")
    .get(runId) as { id: string; user_id: string | null; user_input: string } | undefined;
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
  const allParams = [userId, ...params];

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
                ROW_NUMBER() OVER (PARTITION BY p.reddit_id ORDER BY pi.score DESC NULLS LAST, p.created_utc DESC NULLS LAST, p.score DESC NULLS LAST) AS rn
         FROM posts p
         JOIN runs r ON p.run_id = r.id
         JOIN post_intent pi ON p.id = pi.post_id
         LEFT JOIN lead_actions la ON la.user_id = ? AND la.post_id = p.id
         WHERE ${whereClause}
       )
       SELECT post_id, run_id, user_input, score, label, title, full_link, subreddit, author, created_utc,
              reasoning, suggested_reply, is_high_intent, is_archived, is_deleted, selftext, post_score, num_comments
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
