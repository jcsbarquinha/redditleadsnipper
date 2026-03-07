/**
 * SQLite database and schema. No server needed—uses a single file (e.g. data/reddit-leads.db).
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDatabaseUrl } from "../config.js";

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
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
