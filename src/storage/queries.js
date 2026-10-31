/**
 * 查询：所有 SQL 只出现在这里
 */

import crypto from 'node:crypto';

const parseJson = (v, fallback) => {
  if (!v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const toJson = (v) => JSON.stringify(v ?? null);

// ── messages ──────────────────────────────────────────────
export function insertMessage(db, msg) {
  const row = db.prepare(`INSERT INTO messages
    (msg_id, session_key, direction, sender_id, sender_name, text, has_media, media, raw, at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_key, msg_id) DO NOTHING`).run(
    msg.msgId, msg.sessionKey, msg.direction ?? 'inbound', String(msg.senderId ?? ''),
    msg.senderName ?? null, msg.text ?? '', msg.hasMedia ? 1 : 0,
    toJson(msg.media ?? null), msg.raw ? toJson(msg.raw) : null,
    msg.at, msg.at,
  );
  return Number(row.changes) > 0;
}

export function recentMessages(db, sessionKey, limit = 20) {
  return db
    .prepare('SELECT * FROM messages WHERE session_key = ? ORDER BY at DESC LIMIT ?')
    .all(sessionKey, limit)
    .map((r) => ({
      msgId: r.msg_id, sessionKey: r.session_key, direction: r.direction,
      senderId: r.sender_id, senderName: r.sender_name, text: r.text,
      hasMedia: Boolean(r.has_media), media: parseJson(r.media, null), at: r.at,
    }))
    .reverse();
}

export function countMessages(db, sessionKey) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_key = ?').get(sessionKey)?.n ?? 0);
}

// ── sessions ──────────────────────────────────────────────
export function getSession(db, sessionKey) {
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ?').get(sessionKey);
  if (!row) return null;
  return {
    sessionKey: row.session_key,
    kind: row.kind,
    participants: parseJson(row.participants, []),
    agentToken: row.agent_token,
    agentSession: row.agent_session,
    wakeState: parseJson(row.wake_state, {}),
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
  };
}

export function upsertSession(db, session) {
  db.prepare(`INSERT INTO sessions
    (session_key, kind, participants, agent_token, agent_session, wake_state, last_event_at, created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(session_key) DO UPDATE SET
      kind = excluded.kind,
      participants = excluded.participants,
      last_event_at = COALESCE(excluded.last_event_at, sessions.last_event_at)`).run(
    session.sessionKey, session.kind, toJson(session.participants ?? []),
    session.agentToken ?? null, session.agentSession ?? null,
    toJson(session.wakeState ?? {}), session.lastEventAt ?? null,
    session.createdAt ?? new Date().toISOString(),
  );
  return getSession(db, session.sessionKey);
}

export function setWakeState(db, sessionKey, wakeState) {
  db.prepare('UPDATE sessions SET wake_state = ? WHERE session_key = ?').run(toJson(wakeState), sessionKey);
}

export function setAgentSession(db, sessionKey, agentSession) {
  db.prepare('UPDATE sessions SET agent_session = ? WHERE session_key = ?').run(agentSession, sessionKey);
}

export function listSessions(db, limit = 100) {
  return db.prepare('SELECT * FROM sessions ORDER BY last_event_at DESC LIMIT ?').all(limit)
    .map((r) => getSession(db, r.session_key));
}

// ── dedupe ────────────────────────────────────────────────
export function seenDedupe(db, key) {
  return Boolean(db.prepare('SELECT 1 AS ok FROM dedupe WHERE key = ?').get(key));
}

export function markDedupe(db, key, at = new Date().toISOString()) {
  db.prepare('INSERT INTO dedupe (key, seen_at) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(key, at);
}

export function pruneDedupe(db, beforeIso) {
  return Number(db.prepare('DELETE FROM dedupe WHERE seen_at < ?').run(beforeIso).changes ?? 0);
}

// ── rate limits ───────────────────────────────────────────
export function bucketFor(window, date = new Date()) {
  const iso = date.toISOString();
  if (window === 'day') return iso.slice(0, 10);
  if (window === 'hour') return iso.slice(0, 13);
  return iso.slice(0, 16); // minute
}

/**
 * @returns {{ ok: boolean, count: number, limit: number }}
 */
export function consumeRate(db, { action, target, window = 'minute', limit, at = new Date() }) {
  const bucket = bucketFor(window, at);
  const row = db.prepare(
    'SELECT count FROM rate_limits WHERE action = ? AND target = ? AND window = ? AND bucket = ?',
  ).get(action, target, window, bucket);
  const count = Number(row?.count ?? 0) + 1;
  if (count > limit) return { ok: false, count: count - 1, limit };
  db.prepare(`INSERT INTO rate_limits (action, target, window, bucket, count) VALUES (?,?,?,?,?)
    ON CONFLICT(action, target, window, bucket) DO UPDATE SET count = excluded.count`)
    .run(action, target, window, bucket, count);
  return { ok: true, count, limit };
}

export function pruneRateLimits(db, beforeBucket) {
  return Number(db.prepare('DELETE FROM rate_limits WHERE bucket < ?').run(beforeBucket).changes ?? 0);
}

// ── kv ────────────────────────────────────────────────────
export function getKv(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setKv(db, key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function pruneMessages(db, beforeIso) {
  return Number(db.prepare('DELETE FROM messages WHERE at < ?').run(beforeIso).changes ?? 0);
}

// ── 未读 / 已读 ───────────────────────────────────────────
export function messageByMsgId(db, msgId) {
  const r = db.prepare('SELECT * FROM messages WHERE msg_id = ? LIMIT 1').get(String(msgId));
  if (!r) return null;
  return {
    msgId: r.msg_id, sessionKey: r.session_key, direction: r.direction,
    text: r.text, hasMedia: Boolean(r.has_media), media: parseJson(r.media, null), at: r.at,
  };
}

export function latestMediaMessage(db, sessionKey) {
  const r = db.prepare(`SELECT * FROM messages
    WHERE session_key = ? AND has_media = 1 AND direction = 'inbound'
    ORDER BY at DESC LIMIT 1`).get(sessionKey);
  if (!r) return null;
  return {
    msgId: r.msg_id, sessionKey: r.session_key, text: r.text,
    hasMedia: true, media: parseJson(r.media, null), at: r.at,
  };
}

export function unreadMessages(db, sessionKey, sinceIso, limit = 30) {
  const since = sinceIso ?? '1970-01-01T00:00:00.000Z';
  return db
    .prepare(`SELECT * FROM messages
      WHERE session_key = ? AND direction = 'inbound' AND at > ?
      ORDER BY at ASC LIMIT ?`)
    .all(sessionKey, since, limit)
    .map((r) => ({
      msgId: r.msg_id, sessionKey: r.session_key, direction: r.direction,
      senderId: r.sender_id, senderName: r.sender_name, text: r.text,
      hasMedia: Boolean(r.has_media), media: parseJson(r.media, null), at: r.at,
    }));
}

export function latestInbound(db, sessionKey) {
  const r = db
    .prepare("SELECT * FROM messages WHERE session_key = ? AND direction = 'inbound' ORDER BY at DESC LIMIT 1")
    .get(sessionKey);
  if (!r) return null;
  return { msgId: r.msg_id, sessionKey: r.session_key, senderId: r.sender_id, senderName: r.sender_name, text: r.text, at: r.at };
}

export function setReadThrough(db, sessionKey, atIso) {
  const session = getSession(db, sessionKey);
  if (!session) return null;
  const wakeState = { ...session.wakeState, readThroughAt: atIso };
  setWakeState(db, sessionKey, wakeState);
  return wakeState;
}

/** 确保会话有令牌（首次调用时生成） */
export function ensureAgentToken(db, sessionKey) {
  const session = getSession(db, sessionKey);
  if (!session) return null;
  if (session.agentToken) return session.agentToken;
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE sessions SET agent_token = ? WHERE session_key = ?').run(token, sessionKey);
  return token;
}

// ── 表情 ──────────────────────────────────────────────────
export function upsertSticker(db, { id, desc = '', note = '', tags = [], url = '' }) {
  db.prepare(`INSERT INTO stickers (id, desc, note, tags, url, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET desc = excluded.desc, note = excluded.note,
      tags = excluded.tags, url = excluded.url`).run(
    String(id), desc, note, toJson(tags), url, new Date().toISOString(),
  );
  return getSticker(db, id);
}

export function getSticker(db, id) {
  const row = db.prepare('SELECT * FROM stickers WHERE id = ?').get(String(id));
  if (!row) return null;
  return { id: row.id, desc: row.desc, note: row.note, tags: parseJson(row.tags, []), url: row.url };
}

export function updateSticker(db, id, patch = {}) {
  const current = getSticker(db, id);
  if (!current) return null;
  return upsertSticker(db, { ...current, ...patch });
}

export function listStickers(db, query = '') {
  const rows = db.prepare('SELECT * FROM stickers ORDER BY created_at DESC').all();
  const q = String(query ?? '').toLowerCase();
  return rows
    .map((r) => ({ id: r.id, desc: r.desc, note: r.note, tags: parseJson(r.tags, []), url: r.url }))
    .filter((s) => !q || [s.desc, s.note, ...(s.tags ?? [])].join(' ').toLowerCase().includes(q));
}

// ── 黑话 ──────────────────────────────────────────────────
export function upsertSlang(db, { term, meaning = '', usage = '', status = 'confirmed' }) {
  db.prepare(`INSERT INTO slang (term, meaning, usage, status, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(term) DO UPDATE SET meaning = excluded.meaning, usage = excluded.usage, status = excluded.status`)
    .run(term, meaning, usage, status, new Date().toISOString());
  return getSlang(db, term);
}

export function getSlang(db, term) {
  const row = db.prepare('SELECT * FROM slang WHERE term = ?').get(term);
  return row ? { term: row.term, meaning: row.meaning, usage: row.usage, status: row.status } : null;
}

export function listSlang(db, query = '') {
  const q = String(query ?? '').toLowerCase();
  return db.prepare('SELECT * FROM slang ORDER BY created_at DESC').all()
    .map((r) => ({ term: r.term, meaning: r.meaning, usage: r.usage, status: r.status }))
    .filter((s) => !q || [s.term, s.meaning, s.usage].join(' ').toLowerCase().includes(q));
}

// ── 反馈 ──────────────────────────────────────────────────
export function addFeedback(db, { message, level = 'info' }) {
  db.prepare('INSERT INTO feedback (message, level, at) VALUES (?,?,?)')
    .run(String(message), level, new Date().toISOString());
}