/**
 * QQ 工具（P2 档：表情库、语音、拍一拍、黑话、反馈）
 */

import * as q from '../storage/queries.js';
import { ToolError } from './registry.js';

const keyParam = { type: 'string', description: '会话 key' };
const tokenParam = { type: 'string', description: '会话令牌' };

function requirePort(ctx, method, hint) {
  const fn = ctx.qq?.[method];
  if (typeof fn !== 'function') throw new ToolError(`当前传输层不支持：${hint}`, 'unsupported');
  return fn.bind(ctx.qq);
}

export function registerQqExtraTools(registry) {
  registry.register({
    name: 'qq_list_stickers',
    description: '查看已收藏的表情（可按备注/标签搜）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, query: { type: 'string' } },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const stickers = q.listStickers(ctx.db, args.query ?? '');
      return { ok: true, count: stickers.length, stickers };
    },
  });

  registry.register({
    name: 'qq_get_sticker_image',
    description: '拿到某个收藏表情的图片地址（用于理解它长什么样）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, stickerId: { type: 'string' } },
      required: ['key', 'token', 'stickerId'],
    },
    run(ctx, args) {
      const sticker = q.getSticker(ctx.db, args.stickerId);
      if (!sticker) throw new ToolError('未收藏该表情', 'not_found');
      return { ok: true, sticker };
    },
  });

  registry.register({
    name: 'qq_list_voices',
    description: '查看语音库里可发的音频（文件名、时长）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam },
      required: ['key', 'token'],
    },
    async run(ctx) {
      const list = requirePort(ctx, 'listVoices', '读取语音库');
      const voices = await list();
      return { ok: true, count: Array.isArray(voices) ? voices.length : 0, voices: voices ?? [] };
    },
  });

  registry.register({
    name: 'qq_send_voice',
    description: '发一条语音（只能从语音库选）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, voice: { type: 'string' } },
      required: ['key', 'token', 'voice'],
    },
    async run(ctx, args) {
      const limit = ctx.config?.send?.voicesPerMinute ?? 2;
      const rate = q.consumeRate(ctx.db, { action: 'voice', target: ctx.sessionKey, window: 'minute', limit });
      if (!rate.ok) throw new ToolError(`语音发得太频繁（${rate.count}/${rate.limit}）`, 'rate_limited');
      const send = requirePort(ctx, 'sendVoice', '发送语音');
      const result = await send(ctx.sessionKey, args.voice);
      if (!result?.ok) throw new ToolError(`发送语音失败：${result?.error ?? '未知原因'}`, 'send_failed');
      return { ok: true, voice: args.voice, msgId: result.msgId ?? null };
    },
  });

  registry.register({
    name: 'qq_send_poke',
    description: '拍一拍某人（群聊需指定目标）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, targetUserId: { type: ['string', 'number'] } },
      required: ['key', 'token'],
    },
    async run(ctx, args) {
      const limit = ctx.config?.send?.pokesPerMinute ?? 3;
      const rate = q.consumeRate(ctx.db, { action: 'poke', target: ctx.sessionKey, window: 'minute', limit });
      if (!rate.ok) throw new ToolError('拍一拍太频繁', 'rate_limited');
      const poke = requirePort(ctx, 'sendPoke', '拍一拍');
      const result = await poke(ctx.sessionKey, args.targetUserId);
      if (!result?.ok) throw new ToolError(`拍一拍失败：${result?.error ?? '未知原因'}`, 'send_failed');
      return { ok: true, result };
    },
  });

  registry.register({
    name: 'qq_slang_query',
    description: '查群里的黑话/梗（按词条、含义、用法搜）。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: { key: keyParam, token: tokenParam, q: { type: 'string' } },
      required: ['key', 'token'],
    },
    run(ctx, args) {
      const entries = q.listSlang(ctx.db, args.q ?? '');
      return { ok: true, count: entries.length, entries };
    },
  });

  registry.register({
    name: 'qq_slang_submit',
    description: '提交一个你看不懂的陌生词，进候选库等待确认。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        term: { type: 'string' }, meaning: { type: 'string' }, usage: { type: 'string' },
      },
      required: ['key', 'token', 'term'],
    },
    run(ctx, args) {
      const entry = q.upsertSlang(ctx.db, {
        term: args.term,
        meaning: args.meaning ?? '',
        usage: args.usage ?? '',
        status: 'candidate',
      });
      return { ok: true, entry };
    },
  });

  registry.register({
    name: 'qq_report_feedback',
    description: '把遇到的问题/困惑记下来，交给管理员。',
    scope: 'all',
    inputSchema: {
      type: 'object',
      properties: {
        key: keyParam, token: tokenParam,
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'warning', 'error'] },
      },
      required: ['key', 'token', 'message'],
    },
    run(ctx, args) {
      q.addFeedback(ctx.db, { message: args.message, level: args.level ?? 'info' });
      return { ok: true };
    },
  });

  return registry;
}

export const QQ_P2_TOOL_NAMES = [
  'qq_list_stickers', 'qq_get_sticker_image', 'qq_list_voices', 'qq_send_voice',
  'qq_send_poke', 'qq_slang_query', 'qq_slang_submit', 'qq_report_feedback',
];
