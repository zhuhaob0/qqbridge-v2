/**
 * QQ 工具（P1 档：详情、成员、转发、图片、表情）
 */

import fs from 'node:fs';
import path from 'node:path';
import * as q from '../storage/queries.js';
import { resolveImageSource } from './image-source.js';
import { readTranscript } from '../archive/rotate.js';
import { parseSessionKey } from '../router/session.js';
import { ToolError } from './registry.js';

const keyParam = { type: 'string', description: '会话 key' };
const tokenParam = { type: 'string', description: '会话令牌' };

function requirePort(ctx, method, hint) {
  const fn = ctx.qq?.[method];
  if (typeof fn !== 'function') throw new ToolError(`当前传输层不支持：${hint}`, 'unsupported');
  return fn.bind(ctx.qq);
}

async function rateLimit(ctx, action, target, limit, window = 'minute') {
  const rate = q.consumeRate(ctx.db, { action, target, window, limit });
  if (!rate.ok) throw new ToolError(`操作过于频繁（${rate.count}/${rate.limit}）`, 'rate_limited');
}

export function registerQqMoreTools(registry) {
  registry.register({
    name: 'qq_get_message_detail',
    description: '看某条消息的发送者与引用关系。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, messageId: { type: ['string', 'number'] } },
      required: ['key', 'token', 'messageId'],
    },
    async run(ctx, args) {
      const getDetail = ctx.qq?.messageDetail;
      if (typeof getDetail === 'function') {
        return getDetail.call(ctx.qq, args.messageId);
      }
      const rows = q.recentMessages(ctx.db, ctx.sessionKey, 200);
      const hit = rows.find((m) => String(m.msgId) === String(args.messageId));
      if (!hit) throw new ToolError('未找到该消息', 'not_found');
      return hit;
    },
  });

  registry.register({
    name: 'qq_get_group_members',
    description: '列出群成员（QQ 号、昵称、群名片）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        groupId: { type: ['string', 'number'], description: '缺省为当前群' },
        limit: { type: 'number' },
      },
      required: ['key', 'token'],
    },
    async run(ctx, args) {
      const parsed = parseSessionKey(ctx.sessionKey);
      const gid = args.groupId ?? (parsed?.kind === 'public' ? parsed.id : null);
      if (!gid) throw new ToolError('不在群会话里，请指定 groupId', 'no_group');
      const list = requirePort(ctx, 'groupMembers', '读取群成员');
      const members = await list(Number(gid));
      const limit = Number(args.limit ?? 50);
      return { ok: true, groupId: String(gid), count: Array.isArray(members) ? members.length : 0, members: (members ?? []).slice(0, limit) };
    },
  });

  registry.register({
    name: 'qq_get_active_members',
    description: '最近活跃的成员（按会话里的发言统计，不需要额外接口）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, limit: { type: 'number' }, days: { type: 'number' } },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const days = Number(args.days ?? 7);
      const limit = Number(args.limit ?? 10);
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const rows = ctx.db
        .prepare(`SELECT sender_id, sender_name, COUNT(*) AS n FROM messages
          WHERE session_key = ? AND direction = 'inbound' AND at >= ?
          GROUP BY sender_id ORDER BY n DESC LIMIT ?`)
        .all(ctx.sessionKey, since, limit);
      return { ok: true, days, members: rows.map((r) => ({ userId: r.sender_id, name: r.sender_name, count: r.n })) };
    },
  });

  registry.register({
    name: 'qq_get_forward_msg',
    description: '展开一条合并转发消息。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, id: { type: 'string' } },
      required: ['key', 'token', 'id'],
    },
    async run(ctx, args) {
      const getForward = requirePort(ctx, 'forwardMsg', '读取合并转发');
      return getForward(args.id);
    },
  });

  registry.register({
    name: 'qq_archive_read',
    description: '读取一个已归档的旧会话（只能凭记忆里出现过的 sessionId 读，没有索引可搜）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        sessionId: { type: 'string', description: '归档会话的 sessionId，如 qqb-p-123-g1' },
        keyword: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['key', 'token', 'sessionId'],
    },
    async run(ctx, args) {
      const archive = q.getArchiveBySession(ctx.db, String(args.sessionId ?? ''));
      if (!archive) throw new ToolError('没有这个归档会话的记录（id 可能来自过期记忆）', 'archive_not_found');
      if (!archive.file_path) {
        return {
          sessionId: archive.session_id, generation: archive.generation,
          range: { firstAt: archive.first_at, lastAt: archive.last_at },
          summary: archive.summary, matched: 0,
          text: '（这个归档只留下了摘要，原文文件已丢失）',
        };
      }
      const { text, matched } = readTranscript(archive.file_path, {
        keyword: String(args.keyword ?? ''),
        limit: Number(args.limit ?? 30),
      });
      return {
        sessionId: archive.session_id,
        generation: archive.generation,
        range: { firstAt: archive.first_at, lastAt: archive.last_at },
        summary: archive.summary,
        matched,
        text: text || '（归档文件里没有匹配的正文）',
      };
    },
  });

  registry.register({
    name: 'qq_send_image',
    description: '发一张图片。url 可以是图片直链，也可以是普通网页地址（会自动从页面里提取主图）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, url: { type: 'string' }, replyToMessageId: { type: ['string', 'number'] } },
      required: ['key', 'token', 'url'],
    },
    async run(ctx, args) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new ToolError('只接受 http(s) 地址', 'bad_url');
      await rateLimit(ctx, 'image', ctx.sessionKey, ctx.config?.send?.imagesPerMinute ?? 2);
      const send = requirePort(ctx, 'sendImage', '发送图片');

      // 直链或网页：统一解析成真实图片字节，以 base64 发送（不依赖外链长期有效）
      let payload = url;
      let via = 'url';
      try {
        const image = await resolveImageSource(url);
        payload = 'base64://' + image.buffer.toString('base64');
        via = image.source === 'direct' ? 'direct' : 'page';
      } catch (error) {
        // 解析失败就退回原始链接：至少 SnowLuma 还能自己试一次
        if (!/^https?:\/\//i.test(url)) throw new ToolError(`取图失败：${error?.message ?? error}`, 'image_failed');
        ctx.logger?.warn?.('图片解析失败，回退原始链接', { url, reason: error?.message ?? String(error) });
      }

      const result = await send(ctx.sessionKey, payload, { replyToMessageId: args.replyToMessageId });
      if (!result?.ok) throw new ToolError(`发送图片失败：${result?.error ?? '未知原因'}`, 'send_failed');
      return { ok: true, url, via, msgId: result.msgId ?? null };
    },
  });

  registry.register({
    name: 'qq_forward_image',
    description: '把一张图片/表情转发到当前会话。默认取 from 会话里最近一张；也可指定 messageId 或 url。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam,
        token: tokenParam,
        from: { type: 'string', description: '来源会话 key，例如 group:123456' },
        messageId: { type: ['string', 'number'], description: '指定消息 id（可选）' },
        url: { type: 'string', description: '直接给图片链接（可选）' },
      },
      required: ['key', 'token'],
    },
    async run(ctx, args) {
      const source = args.from ? String(args.from) : ctx.sessionKey;
      let media = null;
      if (args.url) {
        media = { url: String(args.url) };
      } else if (args.messageId) {
        const msg = q.messageByMsgId(ctx.db, args.messageId);
        media = msg?.media?.find((m) => m.type === 'image') ?? null;
      } else {
        const msg = q.latestMediaMessage(ctx.db, source);
        media = msg?.media?.find((m) => m.type === 'image') ?? null;
      }
      if (!media) throw new ToolError('没找到可转发的图片', 'no_media');

      const cacheDir = path.join(process.cwd(), 'state', 'media');
      const cached = media.file ? path.join(cacheDir, path.basename(String(media.file))) : '';
      let payload = '';
      let via = '';
      if (cached && fs.existsSync(cached)) {
        payload = 'base64://' + fs.readFileSync(cached).toString('base64');
        via = 'cache';
      } else if (media.url) {
        payload = String(media.url);
        via = 'url';
      }
      if (!payload) throw new ToolError('图片既没有本地缓存也没有可用链接', 'no_source');

      await rateLimit(ctx, 'image', ctx.sessionKey, ctx.config?.send?.imagesPerMinute ?? 2);
      const send = requirePort(ctx, 'sendImage', '发送图片');
      const result = await send(ctx.sessionKey, payload, {});
      if (!result?.ok) throw new ToolError(`转发失败：${result?.error ?? '未知原因'}`, 'send_failed');
      return { ok: true, from: source, via, msgId: result.msgId ?? null };
    },
  });

  registry.register({
    name: 'qq_send_sticker',
    description: '发一个收藏表情（按 id 或备注）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, stickerId: { type: 'string' }, replyToMessageId: { type: ['string', 'number'] } },
      required: ['key', 'token', 'stickerId'],
    },
    async run(ctx, args) {
      await rateLimit(ctx, 'sticker', ctx.sessionKey, ctx.config?.send?.stickersPerMinute ?? 2);
      const send = requirePort(ctx, 'sendSticker', '发送表情');
      const result = await send(ctx.sessionKey, args.stickerId, { replyToMessageId: args.replyToMessageId });
      if (!result?.ok) throw new ToolError(`发送表情失败：${result?.error ?? '未知原因'}`, 'send_failed');
      return { ok: true, stickerId: args.stickerId, msgId: result.msgId ?? null };
    },
  });

  registry.register({
    name: 'qq_collect_sticker',
    description: '把一条消息里的表情/图片收进收藏，可写一句备注。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, messageId: { type: ['string', 'number'] }, remark: { type: 'string' } },
      required: ['key', 'token', 'messageId'],
    },
    async run(ctx, args) {
      const collect = requirePort(ctx, 'collectSticker', '收藏表情');
      const result = await collect(args.messageId, args.remark ?? '');
      if (result?.ok && result.sticker) {
        q.upsertSticker?.(ctx.db, {
          id: String(result.sticker.id ?? args.messageId),
          desc: result.sticker.desc ?? '',
          note: args.remark ?? '',
          tags: result.sticker.tags ?? [],
          url: result.sticker.url ?? '',
        });
      }
      return result;
    },
  });

  registry.register({
    name: 'qq_sticker_note',
    description: '给收藏表情写备注/标签，方便以后挑。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        stickerId: { type: 'string' }, note: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['key', 'token', 'stickerId'],
    },
    run(ctx, args) {
      const sticker = q.getSticker?.(ctx.db, args.stickerId);
      if (!sticker) throw new ToolError('未收藏该表情', 'not_found');
      q.updateSticker?.(ctx.db, args.stickerId, { note: args.note ?? sticker.note, tags: args.tags ?? sticker.tags });
      return { ok: true, sticker: q.getSticker(ctx.db, args.stickerId) };
    },
  });

  return registry;
}

export const QQ_P1_TOOL_NAMES = [
  'qq_get_message_detail', 'qq_get_group_members', 'qq_get_active_members', 'qq_get_forward_msg',
  'qq_send_image', 'qq_forward_image', 'qq_send_sticker', 'qq_collect_sticker', 'qq_sticker_note',
];
