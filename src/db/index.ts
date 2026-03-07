/**
 * SQLite database and schema. No server needed—uses a single file (e.g. data/reddit-leads.db).
 */

import Database from "better-sqlite3";
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
    CREATE INDEX IF NOT EXISTS idx_post_intent_is_high_intent ON post_intent(is_high_intent);
  `);
  migratePostIntent(database);
}

function migratePostIntent(database: Database.Database): void {
  const columns = (database.prepare("PRAGMA table_info(post_intent)").all() as { name: string }[]).map((r) => r.name);
  if (!columns.includes("suggested_reply")) database.exec("ALTER TABLE post_intent ADD COLUMN suggested_reply TEXT");
  if (!columns.includes("is_high_intent")) database.exec("ALTER TABLE post_intent ADD COLUMN is_high_intent INTEGER NOT NULL DEFAULT 0");
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
  status: "pending" | "running" | "completed" | "failed" = "running"
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO runs (id, user_input, keywords, status, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(runId, userInput, JSON.stringify(keywords), status);
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
