/**
 * SQLite：打开、迁移、关闭
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    msg_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    direction TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    text TEXT,
    has_media INTEGER NOT NULL DEFAULT 0,
    media TEXT,
    raw TEXT,
    at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_key, msg_id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_at ON messages(session_key, at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    session_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    participants TEXT NOT NULL,
    agent_token TEXT,
    agent_session TEXT,
    wake_state TEXT NOT NULL DEFAULT '{}',
    last_event_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dedupe (
    key TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    window TEXT NOT NULL,
    bucket TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(action, target, window, bucket)
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  let version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  while (version < SCHEMA_VERSION) {
    const sql = MIGRATIONS[version];
    if (!sql) throw new Error(`缺少 v${version + 1} 的迁移脚本`);
    db.exec('BEGIN');
    try {
      db.exec(sql);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return version;
}

export function schemaInfo(db) {
  return { schemaVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0), expected: SCHEMA_VERSION };
}
