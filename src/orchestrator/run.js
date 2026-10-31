/**
 * 一轮对话的编排：取记忆 → 拼提示词 → 调 agent → 分条发送 → 写记忆
 */

import { collectText } from '../agent/port.js';
import { buildPrompt, replyPolicy } from './prompt.js';
import { split } from './splitter.js';
import * as q from '../storage/queries.js';
import { channelIdFor, participantsFor } from '../router/session.js';
import { takeToolSend } from '../tools/stats.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOrchestrator({
  db,
  config,
  agent,
  qq,
  memory = null,
  logger = null,
  clock = () => new Date(),
  random = Math.random,
  sleep = defaultSleep,
} = {}) {
  const policy = replyPolicy(null, config);

  // 同一会话串行：上一轮没结束又来消息时排队，避免两个回合并发跑同一 session
  const chains = new Map();

  async function runSerial(sessionKey, options) {
    const prev = chains.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(() => runOnce(sessionKey, options)).catch((error) => {
      logger?.error?.('编排失败', { key: sessionKey, reason: error?.message ?? String(error) });
      return { ok: false, reason: '编排异常' };
    });
    chains.set(sessionKey, next.finally(() => {
      if (chains.get(sessionKey) === next) chains.delete(sessionKey);
    }));
    return next;
  }

  async function runOnce(sessionKey, { items = [] } = {}) {
    const started = clock().getTime();
    logger?.info?.('回合开始', { key: sessionKey, queue: chains.size, items: items.length });
    const session = q.getSession(db, sessionKey);
    if (session && !session.agentToken) session.agentToken = q.ensureAgentToken(db, sessionKey);
    if (!session) {
      logger?.warn?.('会话不存在，跳过', { key: sessionKey });
      return { ok: false, reason: '会话不存在' };
    }

    const recent = q.recentMessages(db, sessionKey, 20);

    // 没有未读就不该开回合：概率唤醒/定时唤醒会把「没有新消息」也当成一轮，
    // 模型拿不到内容就只能解释自己的状态（实测在群里发过这种废话）。
    const unread = q.unreadMessages(db, sessionKey, session.wakeState?.readThroughAt ?? undefined);
    if (unread.length === 0) {
      logger?.info?.('没有新的入站消息，跳过本轮', { key: sessionKey });
      return { ok: true, parts: [], skipped: 'no-unread' };
    }
    const channelId = channelIdFor(sessionKey);
    const participants = participantsFor(sessionKey, { selfId: 'self' });

    // ① 记忆（失败不影响对话）
    let memoryData = null;
    let memoryMs = 0;
    if (memory) {
      const memStart = clock().getTime();
      const lastText = items.at(-1)?.text ?? recent.at(-1)?.text ?? '';
      const recalled = await memory.recall({ channelId, participants, query: lastText });
      const persona = await memory.persona();
      const narrative = await memory.narrative();
      memoryData = { rendered: recalled?.rendered ?? '', persona, narrative };
      memoryMs = clock().getTime() - memStart;
    }

    // ② 提示词
    const prompt = buildPrompt({
      persona: memoryData?.persona,
      narrative: memoryData?.narrative,
      memoryRendered: memoryData?.rendered,
      session,
      recent,
      config,
    });

    logger?.info?.('prompt 预览', {
      key: sessionKey,
      promptLen: prompt.length,
      memoryLen: String(memoryData?.rendered ?? '').length,
      memoryMs,
      sharedRecent: String(memoryData?.rendered ?? '').includes('来自其它会话') ? 'yes' : 'no',
      recentCount: recent.length,
    });

    // ②.5 收集本轮要「看」的图片（最近一条带图的消息，最多 2 张）
    const images = [];
    if (typeof qq.getImage === 'function') {
      const withImages = recent.filter((m) => m.direction === 'inbound' && (m.media ?? []).some((x) => x.type === 'image'));
      for (const m of withImages.slice(-2)) {
        for (const med of m.media.filter((x) => x.type === 'image')) {
          if (!med.file) continue;
          const img = await qq.getImage(med.file);
          if (img?.buffer) images.push(img);
        }
      }
    }
    const promptContent = [
      { type: 'text', text: prompt },
      ...images.slice(0, 2).map((img, i) => ({
        type: 'image',
        mediaType: img.mimeType,
        data: img.buffer.toString('base64'),
        name: `qq-${i + 1}`,
      })),
    ];

    // ③ agent
    let text = '';
    try {
      // 迁移过来的 DSH 会话可能已失效：失败时清掉再建一次
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sessionId = session.agentSession ?? await agent.ensureSession(sessionKey, { preset: config?.agent?.preset });
        if (!session.agentSession) q.setAgentSession(db, sessionKey, sessionId);
        try {
          text = await collectText(agent.send(sessionId, images.length ? promptContent : prompt));
          break;
        } catch (error) {
          const reason = String(error?.message ?? error);
          // 超时也按「会话可能失效」处理：DSH 重启后旧 sessionId 收不到 turn 事件
          const staleSession = /session|not.?found|不存在|404|invalid|unknown|超时|timeout|fetch failed|ECONNREFUSED|ECONNRESET/i.test(reason);
          if (attempt === 1 || !staleSession) throw error;
          logger?.warn?.('agent 调用失败，重建会话/刷新端口后重试', { key: sessionKey, reason });
          agent.refreshBase?.();
          q.setAgentSession(db, sessionKey, null);
          session.agentSession = null;
        }
      }
    } catch (error) {
      logger?.error?.('agent 调用失败', { key: sessionKey, reason: error?.message ?? String(error) });
      return { ok: false, reason: 'agent 调用失败', error: String(error?.message ?? error) };
    }

    // ④ 分条 + 发送（受每分钟限流约束）
    // 如果 AI 这一轮已经用发送工具发过消息，就别再自动转发了（否则一次回复变两条）
    const toolSent = takeToolSend(sessionKey);
    const parts = toolSent > 0 ? [] : split(text, {
      threshold: policy.splitThreshold,
      maxParts: policy.maxParts,
    });
    if (toolSent > 0) logger?.info?.('本轮已由工具发送，跳过自动转发', { key: sessionKey, toolSent });
    const sent = [];
    for (const part of parts) {
      const rate = q.consumeRate(db, {
        action: 'send',
        target: sessionKey,
        window: 'minute',
        limit: policy.maxPerMinute ?? config?.send?.maxPerMinute ?? 10,
      });
      if (!rate.ok) {
        logger?.warn?.('发送被限流', { key: sessionKey, count: rate.count, limit: rate.limit });
        break;
      }
      const result = await qq.sendText(sessionKey, part, {});
      if (!result?.ok) {
        logger?.warn?.('发送失败', { key: sessionKey, reason: result?.error });
        break;
      }
      sent.push(part);
      q.insertMessage(db, {
        msgId: result.msgId ?? `out_${clock().getTime()}_${sent.length}`,
        sessionKey,
        direction: 'outbound',
        senderId: String(config?.qq?.selfQQ ?? ''),
        senderName: '我',
        text: part,
        at: clock().toISOString(),
      });
      if (memory && session.kind === 'public' && part) {
        Promise.resolve(memory.ingest({
          channel: { id: channelId, kind: 'public', participants, recordPublic: true },
          events: [{ role: 'assistant', text: part, at: clock().toISOString(), sensitivity: 'shared' }],
        })).catch((error) => logger?.warn?.('记忆写入失败（群聊回复）', { reason: error?.message ?? String(error) }));
      }
      const gap = policy.minGapMs + Math.floor(random() * Math.max(1, policy.maxGapMs - policy.minGapMs));
      await sleep(gap);
    }

    if (sent.length > 0 || toolSent > 0) q.setReadThrough(db, sessionKey, clock().toISOString());

    const elapsedMs = clock().getTime() - started;
    logger?.info?.('一轮对话完成', { key: sessionKey, parts: sent.length, elapsedMs });
    return { ok: true, parts: sent, prompt, elapsedMs };
  }

  return { run: runSerial, runSerial, runOnce };
}
