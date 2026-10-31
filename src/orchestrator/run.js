/**
 * 一轮对话的编排：取记忆 → 拼提示词 → 调 agent → 分条发送 → 写记忆
 */

import { collectText } from '../agent/port.js';
import { buildPrompt, replyPolicy } from './prompt.js';
import { split } from './splitter.js';
import * as q from '../storage/queries.js';
import { channelIdFor, participantsFor } from '../router/session.js';

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

  async function run(sessionKey, { items = [] } = {}) {
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
      const sessionId = session.agentSession ?? await agent.ensureSession(sessionKey, { preset: config?.agent?.preset });
      if (!session.agentSession) q.setAgentSession(db, sessionKey, sessionId);
      text = await collectText(agent.send(sessionId, prompt));
    } catch (error) {
      logger?.error?.('agent 调用失败', { key: sessionKey, reason: error?.message ?? String(error) });
      return { ok: false, reason: 'agent 调用失败', error: String(error?.message ?? error) };
    }

    // ④ 分条 + 发送（受每分钟限流约束）
    const parts = split(text, {
      threshold: policy.splitThreshold,
      maxParts: policy.maxParts,
    });
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

  return { run };
}
