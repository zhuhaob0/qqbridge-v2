/**
 * QQ 空间（说说）工具
 *
 * 以前这些能力在 phone-mcp 里，但实现其实只是转发 SnowLuma 的 action
 * （send_qzone_msg / get_qzone_msg_list / get_qzone_feeds / like_qzone / comment_qzone）。
 * 既然桥接本身就连着 SnowLuma，就没必要绕手机那一边。
 *
 * 限额（硬拦，不信提示词）：
 *   发说说   每 24 小时 3 条、每分钟 1 条
 *   点赞     每 24 小时 20 条、同上每人 5 条
 *   评论     每 10 分钟 2 条、每 24 小时 30 条、每人 5 条
 */

import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './registry.js';

const DAY = 24 * 3600 * 1000;
const MINUTE = 60 * 1000;

function nowMs() { return Date.now(); }

function recent(hits, windowMs, at = nowMs()) {
  return hits.filter((t) => at - t < windowMs);
}

function kvGet(db, key, fallback) {
  try {
    const row = db?.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row?.value ?? fallback;
  } catch { return fallback; }
}

function kvSet(db, key, value) {
  try {
    db?.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  } catch { /* 忽略 */ }
}

/** 从 kv 读发帖时间戳 */
function loadPostHits(db) {
  try {
    const list = JSON.parse(kvGet(db, 'qzone:post:hits', '[]'));
    return Array.isArray(list) ? list.filter((t) => Number.isFinite(t)) : [];
  } catch { return []; }
}

function savePostHits(db, hits) {
  kvSet(db, 'qzone:post:hits', JSON.stringify(hits));
}

/** 要求 transport 提供某个方法 */
function requirePort(ctx, method, label) {
  const fn = ctx?.qq?.[method];
  if (typeof fn !== 'function') throw new ToolError(`${label}不可用：传输层缺少 ${method}`, 'port_missing');
  return fn.bind(ctx.qq);
}

function mediaDir() {
  return path.resolve(process.env.QQ_BRIDGE_MEDIA_DIR ?? './state/media');
}

/** 配图：http(s) 原样传；本地文件（state/media 下）转 base64 */
function resolveImage(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  const file = path.isAbsolute(raw) ? raw : path.join(mediaDir(), raw);
  if (!fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.length > 4 * 1024 * 1024) return null;
  return 'base64://' + buffer.toString('base64');
}

export function registerQzoneTools(registry) {
  const likeHits = { all: [], byTarget: new Map() };
  const commentHits = { all: [], byTarget: new Map() };

  const keyParam = { type: 'string', description: '会话 key（如 group:123）' };
  const tokenParam = { type: 'string', description: '会话令牌' };

  registry.register({
    name: 'qq_qzone_post',
    description: '发一条 QQ 空间说说（自己的空间）。纯文字或带图；每 24 小时最多 3 条，发出去撤不回。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        content: { type: 'string', description: '说说正文' },
        images: { type: 'array', items: { type: 'string' }, description: '配图：http(s) 链接，或 state/media 下的文件名；最多 9 张' },
      },
      required: ['key', 'token', 'content'],
    },
    async run(ctx, args) {
      const content = String(args.content ?? '').trim();
      if (!content) throw new ToolError('说说正文不能为空', 'empty_content');
      if (content.length > 800) throw new ToolError('说说太长了（最多 800 字）', 'too_long');

      const hits = loadPostHits(ctx.db);
      // ctx 里没有 q 时退化为内存限流
      const at = nowMs();
      const dayHits = recent(hits, DAY, at);
      if (dayHits.length >= 3) throw new ToolError('【限流】说说每 24 小时最多 3 条，已经发完了', 'rate_limited');
      if (recent(hits, MINUTE, at).length >= 1) throw new ToolError('【限流】说说每分钟最多 1 条，稍后再来', 'rate_limited');

      const images = (Array.isArray(args.images) ? args.images : []).slice(0, 9).map((v) => {
        const resolved = resolveImage(v);
        if (!resolved) throw new ToolError(`配图不可用：${v}（只支持 http(s) 或 state/media 下的文件）`, 'bad_image');
        return resolved;
      });
      const call = requirePort(ctx, 'callAction', '空间操作');
      const data = await call('send_qzone_msg', images.length ? { content, images } : { content });

      const next = [...dayHits, at];
      savePostHits(ctx.db, next);
      return { ok: true, content, images: images.length, result: data ?? null };
    },
  });

  registry.register({
    name: 'qq_qzone_my_posts',
    description: '看自己 QQ 空间最近发的说说（确认发出去没有 / 回顾自己发过什么）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, num: { type: 'number', description: '看几条，默认 5' } },
      required: ['key', 'token'],
    },
    async run(ctx, args) {
      const num = Math.min(Math.max(Number(args.num ?? 5), 1), 20);
      const call = requirePort(ctx, 'callAction', '空间操作');
      const data = await call('get_qzone_msg_list', { num });
      const list = Array.isArray(data) ? data : (data?.msglist ?? data?.list ?? []);
      return { ok: true, posts: list.slice(0, num).map((x) => ({
        tid: x.tid ?? x.id ?? null,
        content: String(x.content ?? x.summary ?? x.text ?? '').slice(0, 200),
        likes: x.like_count ?? x.likenum ?? 0,
        comments: x.comment_count ?? x.cmtenum ?? 0,
      })) };
    },
  });

  registry.register({
    name: 'qq_qzone_feeds',
    description: '看好友的 QQ 空间动态（含主人）；返回 tid 可用于点赞/评论。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, num: { type: 'number', description: '看几条，默认 8' } },
      required: ['key', 'token'],
    },
    async run(ctx, args) {
      const num = Math.min(Math.max(Number(args.num ?? 8), 1), 20);
      const call = requirePort(ctx, 'callAction', '空间操作');
      const data = await call('get_qzone_feeds', { num });
      const list = Array.isArray(data) ? data : (data?.list ?? data?.feeds ?? []);
      return { ok: true, feeds: list.slice(0, num).map((x) => ({
        tid: x.tid ?? x.id ?? null,
        uin: x.uin ?? x.user_id ?? null,
        name: x.name ?? x.nickname ?? null,
        content: String(x.content ?? x.summary ?? x.text ?? '').slice(0, 200),
        time: x.abstime ?? x.createTime ?? null,
      })) };
    },
  });

  registry.register({
    name: 'qq_qzone_like',
    description: '给一条说说点赞（每人每 24 小时最多 5 条，总计 20 条）。想表达喜欢优先点赞。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        tid: { type: 'string' }, targetUin: { type: ['string', 'number'] }, abstime: { type: 'number' },
      },
      required: ['key', 'token', 'tid'],
    },
    async run(ctx, args) {
      const at = nowMs();
      likeHits.all = recent(likeHits.all, DAY, at);
      if (likeHits.all.length >= 20) throw new ToolError('【限流】点赞每天最多 20 条', 'rate_limited');
      const target = String(args.targetUin ?? '');
      if (target) {
        const hits = recent(likeHits.byTarget.get(target) ?? [], DAY, at);
        if (hits.length >= 5) throw new ToolError(`【限流】对同一个人每 24 小时最多点赞 5 条`, 'rate_limited');
      }
      const call = requirePort(ctx, 'callAction', '空间操作');
      const payload = { tid: String(args.tid) };
      if (target) payload.target_uin = Number(target);
      if (args.abstime) payload.abstime = Number(args.abstime);
      const data = await call('like_qzone', payload);
      likeHits.all.push(at);
      if (target) likeHits.byTarget.set(target, [...(likeHits.byTarget.get(target) ?? []), at]);
      return { ok: true, tid: String(args.tid), result: data ?? null };
    },
  });

  registry.register({
    name: 'qq_qzone_comment',
    description: '评论一条说说（发出撤不回：每 10 分钟最多 2 条、每天 30 条、每人 5 条）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        tid: { type: 'string' }, content: { type: 'string' }, targetUin: { type: ['string', 'number'] },
      },
      required: ['key', 'token', 'tid', 'content'],
    },
    async run(ctx, args) {
      const text = String(args.content ?? '').trim();
      if (!text) throw new ToolError('评论内容不能为空', 'empty_content');
      const at = nowMs();
      commentHits.all = recent(commentHits.all, DAY, at);
      if (recent(commentHits.all, 10 * MINUTE, at).length >= 2) throw new ToolError('【限流】评论每 10 分钟最多 2 条', 'rate_limited');
      if (commentHits.all.length >= 30) throw new ToolError('【限流】评论每天最多 30 条', 'rate_limited');
      const target = String(args.targetUin ?? '');
      if (target) {
        const hits = recent(commentHits.byTarget.get(target) ?? [], DAY, at);
        if (hits.length >= 5) throw new ToolError('【限流】对同一个人每 24 小时最多评论 5 条', 'rate_limited');
      }
      const call = requirePort(ctx, 'callAction', '空间操作');
      const payload = { tid: String(args.tid), content: text };
      if (target) payload.target_uin = Number(target);
      const data = await call('comment_qzone', payload);
      commentHits.all.push(at);
      if (target) commentHits.byTarget.set(target, [...(commentHits.byTarget.get(target) ?? []), at]);
      return { ok: true, tid: String(args.tid), result: data ?? null };
    },
  });
}
