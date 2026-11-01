/**
 * QQ 工具（P0：十件套）
 */

import * as q from '../storage/queries.js';
import { parseSessionKey, participantsFor, channelIdFor } from '../router/session.js';
import { ToolError } from './registry.js';

const keyParam = { type: 'string', description: '会话 key（private:123 / group:456）' };
const tokenParam = { type: 'string', description: '会话令牌（见唤醒提示）' };

function sessionOf(ctx) {
  return q.getSession(ctx.db, ctx.sessionKey);
}

function allowedPrivateTarget(config, qq) {
  const list = (config?.allow?.private ?? []).map(String);
  return list.includes(String(qq));
}

function allowedGroupTarget(config, gid) {
  const groups = (config?.allow?.groups ?? []).map(String);
  if (groups.length === 0) return config?.allow?.emptyGroupsMeansAll === true;
  return groups.includes(String(gid));
}

async function sendTo(ctx, targetKey, text, opts = {}) {
  const enabled = targetKey === ctx.sessionKey;
  if (!enabled) {
    const parsed = parseSessionKey(targetKey);
    if (!parsed) throw new ToolError('目标会话 key 非法', 'bad_target');
    if (parsed.kind === 'direct' && !allowedPrivateTarget(ctx.config, parsed.id)) {
      throw new ToolError('目标不在私聊白名单', 'forbidden');
    }
    if (parsed.kind === 'public' && !allowedGroupTarget(ctx.config, parsed.id)) {
      throw new ToolError('目标群不在白名单', 'forbidden');
    }
  }

  const limit = ctx.config?.send?.maxPerMinute ?? 10;
  const rate = q.consumeRate(ctx.db, { action: 'send', target: targetKey, window: 'minute', limit });
  if (!rate.ok) throw new ToolError(`发送过于频繁（${rate.count}/${rate.limit} 每分钟）`, 'rate_limited');

  const result = await ctx.qq.sendText(targetKey, String(text ?? ''), opts);
  if (!result?.ok) throw new ToolError(`发送失败：${result?.error ?? '未知原因'}`, 'send_failed');

  q.insertMessage(ctx.db, {
    msgId: result.msgId || `tool_${Date.now()}`,
    sessionKey: targetKey,
    direction: 'outbound',
    senderId: String(ctx.config?.qq?.selfQQ ?? ''),
    senderName: '我',
    text: String(text ?? ''),
    at: new Date().toISOString(),
  });
  return { ok: true, msgId: result.msgId ?? null, targetKey };
}

export function registerQqTools(registry) {
  registry.register({
    name: 'qq_status',
    description: '查看连接状态、自己的账号、未读数量。',
    scope: 'all',
    inputSchema: { type: 'object', properties: { key: keyParam, token: tokenParam }, required: ['key', 'token'] },
    run(ctx) {
      const session = sessionOf(ctx);
      const unread = q.unreadMessages(ctx.db, ctx.sessionKey, session?.wakeState?.readThroughAt, 99).length;
      return {
        selfQQ: ctx.config?.qq?.selfQQ ?? null,
        ownerQQ: ctx.config?.qq?.ownerQQ ?? null,
        sessionKey: ctx.sessionKey,
        kind: session?.kind ?? null,
        unread,
        memoryDegraded: Boolean(ctx.memory?.degraded),
      };
    },
  });

  registry.register({
    name: 'qq_send_message',
    description: '给当前会话发一条文本（也可传数组分多条）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        messages: { type: ['string', 'array'], description: '一条或多条文本' },
      },
      required: ['key', 'token', 'messages'],
    },
    async run(ctx, args) {
      // 多条合并成一条发：一次调用发两条在用户看来就是「刷屏」
      // 模型有时把数组序列化成字符串传进来（["a","b"]），先尝试还原
      let raw = args.messages;
      if (typeof raw === 'string' && /^\s*\[/.test(raw)) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) raw = parsed;
        } catch { /* 不是 JSON 就按普通文本处理 */ }
      }
      const list = (Array.isArray(raw) ? raw : [raw])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      const text = list.join(' ');
      if (!text) return { ok: false, error: '消息为空' };
      const result = await sendTo(ctx, ctx.sessionKey, text);
      return { ok: true, sent: 1, text, result };
    },
  });

  registry.register({
    name: 'qq_reply',
    description: '引用某条消息回复（在群或私聊里明确"回的是哪条"）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, replyToMessageId: { type: ['string', 'number'] }, text: { type: 'string' } },
      required: ['key', 'token', 'replyToMessageId', 'text'],
    },
    async run(ctx, args) {
      return sendTo(ctx, ctx.sessionKey, args.text, { replyToMessageId: args.replyToMessageId });
    },
  });

  registry.register({
    name: 'qq_send_private_message',
    description: '给指定好友发消息（目标必须在 allow.private 里）。',
    scope: 'allowlist',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, userId: { type: ['string', 'number'] }, text: { type: 'string' } },
      required: ['key', 'token', 'userId', 'text'],
    },
    async run(ctx, args) {
      const target = `private:${String(args.userId)}`;
      return sendTo(ctx, target, args.text);
    },
  });

  registry.register({
    name: 'qq_send_group_message',
    description: '给指定群发消息（群必须在白名单内，或配置允许全部群）。',
    scope: 'allowlist',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, groupId: { type: ['string', 'number'] }, text: { type: 'string' } },
      required: ['key', 'token', 'groupId', 'text'],
    },
    async run(ctx, args) {
      const target = `group:${String(args.groupId)}`;
      return sendTo(ctx, target, args.text);
    },
  });

  registry.register({
    name: 'qq_get_unread_messages',
    description: '看这个会话里还没读的消息。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, limit: { type: 'number' } },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const session = sessionOf(ctx);
      const since = session?.wakeState?.readThroughAt ?? null;
      const messages = q.unreadMessages(ctx.db, ctx.sessionKey, since, Number(args.limit ?? 30));
      return { ok: true, count: messages.length, messages };
    },
  });

  registry.register({
    name: 'qq_get_recent_messages',
    description: '看这个会话最近的若干条消息（含你自己说的）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, limit: { type: 'number' } },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const messages = q.recentMessages(ctx.db, ctx.sessionKey, Number(args.limit ?? 20));
      return { ok: true, count: messages.length, messages };
    },
  });

  registry.register({
    name: 'qq_mark_read',
    description: '把这些消息标记为已读（通过读取水位）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, throughAt: { type: 'string', description: 'ISO 时间，缺省为现在' } },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const at = args.throughAt ?? new Date().toISOString();
      q.setReadThrough(ctx.db, ctx.sessionKey, at);
      return { ok: true, throughAt: at };
    },
  });

  registry.register({
    name: 'qq_wait_for_messages',
    description: '等这个会话来新消息（最长 10 分钟）；超时返回空。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, timeoutMs: { type: 'number' } },
      required: ['key', 'token'],
    },
    async run(ctx, args) {
      const timeout = Math.min(Number(args.timeoutMs ?? 30000), 600000);
      const startedAt = Date.now();
      const msg = await ctx.bus.waitFor(ctx.sessionKey, { timeoutMs: timeout });
      const waitedMs = Date.now() - startedAt;
      if (!msg) return { ok: true, timeout: true, waitedMs, messages: [] };
      return { ok: true, timeout: false, waitedMs, messages: [msg] };
    },
  });

  registry.register({
    name: 'qq_set_wake_config',
    description: '设置唤醒方式：潜水/活跃、截止时间、触发条件。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        mode: { type: 'string', enum: ['diving', 'active'] },
        until: { type: 'string', description: 'ISO 时间，潜水截止' },
        triggers: {
          type: 'object',
          description: 'at/name/question/probability/anyMessage/keywords',
        },
      },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const session = sessionOf(ctx);
      const wakeState = {
        ...(session?.wakeState ?? {}),
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.until ? { until: args.until } : {}),
        ...(args.triggers ? { triggers: { ...(session?.wakeState?.triggers ?? {}), ...args.triggers } } : {}),
      };
      q.setWakeState(ctx.db, ctx.sessionKey, wakeState);
      return { ok: true, wakeState };
    },
  });

  return registry;
}

export const QQ_P0_TOOL_NAMES = [
  'qq_status', 'qq_send_message', 'qq_reply', 'qq_send_private_message',
  'qq_send_group_message', 'qq_get_unread_messages', 'qq_get_recent_messages',
  'qq_mark_read', 'qq_wait_for_messages', 'qq_set_wake_config',
];

export { participantsFor, channelIdFor };
