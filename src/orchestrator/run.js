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
    const session = q.getSession(db, sessionKey);
    if (session && !session.agentToken) session.agentToken = q.ensureAgentToken(db, sessionKey);
    if (!session) {
      logger?.warn?.('会话不存在，跳过', { key: sessionKey });
      return { ok: false, reason: '会话不存在' };
    }

    const recent = q.recentMessages(db, sessionKey, 20);
    const channelId = channelIdFor(sessionKey);
    const participants = participantsFor(sessionKey, { selfId: 'self' });

    // ① 记忆（失败不影响对话）
    let memoryData = null;
    if (memory) {
      const lastText = items.at(-1)?.text ?? recent.at(-1)?.text ?? '';
      const recalled = await memory.recall({ channelId, participants, query: lastText });
      const persona = await memory.persona();
      const narrative = await memory.narrative();
      memoryData = { rendered: recalled?.rendered ?? '', persona, narrative };
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

    // ③ agent
    let text = '';
    try {
      // 迁移过来的 DSH 会话可能已失效：失败时清掉再建一次
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sessionId = session.agentSession ?? await agent.ensureSession(sessionKey, { preset: config?.agent?.preset });
        if (!session.agentSession) q.setAgentSession(db, sessionKey, sessionId);
        try {
          text = await collectText(agent.send(sessionId, prompt));
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
      const gap = policy.minGapMs + Math.floor(random() * Math.max(1, policy.maxGapMs - policy.minGapMs));
      await sleep(gap);
    }

    // ⑤ 记忆写入（异步，失败不影响）
    if (memory && sent.length > 0) {
      // 只写"对方说的话"：自己的回复已经在上下文里，再写一遍会自我强化，
      // 造成记忆里出现大量"我说过…"的重复条目（实测踩到）。
      const events = recent
        .filter((m) => m.text && m.direction === 'inbound')
        .map((m) => ({ role: 'user', text: m.text, at: m.at }));
      Promise.resolve(memory.ingest({ channel: { id: channelId, kind: session.kind, participants }, events }))
        .catch((error) => logger?.warn?.('记忆写入失败', { reason: error?.message ?? String(error) }));
    }

    const elapsedMs = clock().getTime() - started;
    logger?.info?.('一轮对话完成', { key: sessionKey, parts: sent.length, elapsedMs });
    return { ok: true, parts: sent, prompt, elapsedMs };
  }

  return { run: runSerial, runSerial, runOnce };
}
