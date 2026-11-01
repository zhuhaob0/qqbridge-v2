/**
 * 主动回合：由社交循环触发（不是收到消息触发）
 *
 * v1 的行为：群里长时间没人说话时，小概率主动开个话题；自己说完没人接，
 * 过一会儿小概率"试探"一句。这里保持同样的语义，只是措辞交给模型。
 */

import { buildPrompt } from './prompt.js';
import { takeToolSend } from '../tools/stats.js';
import { looksLikeProcessNarration } from './meta-filter.js';
import { split } from './splitter.js';
import { collectText } from '../agent/port.js';

const INSTRUCTIONS = {
  open: [
    '【主动开话题】',
    '群里安静了很久，你想起点什么，想随口说一句。',
    '要求：用发送工具发一条自然的话；不要提“好久没人说话/我来活跃气氛/群里好安静”这类元话术；',
    '不要 @所有人，不要编造刚发生的事；确实没想说的就不发（直接结束这一轮）。',
  ].join('\n'),
  qzone: [
    '【发说说】',
    '你想在自己的 QQ 空间发一条说说。',
    '要求：调用 qq_qzone_post 发一条 80 字以内的自然表达；内容来自你今天真实的经历或想法，不要报时、不要编造、不要写“今天我在群里……”这种旁白；',
    '不要 @ 任何人，不要发链接；不想发就直接结束这一轮（不调用工具）。',
  ].join('\n'),
  probe: [
    '【冷场试探】',
    '你刚才说过话，还没人接。可以轻轻试一句（顺着刚才的话题问一句、补一句），',
    '不要重复上一条，不要抱怨没人理，也不要解释你在“试探”。',
    '不想说就不发。',
  ].join('\n'),
};

/**
 * @param {object} options
 * @param {'open'|'probe'} options.purpose
 */
export async function runProactiveTurn({
  db, q, config, agent, memory, qq, logger = null, sessionKey, purpose = 'open', clock = () => new Date(),
}) {
  if (!agent || !qq) return { ok: false, reason: 'agent/qq 未装配' };
  const session = q.getSession(db, sessionKey);
  if (!session) return { ok: false, reason: '会话不存在' };

  let persona = null;
  let narrative = null;
  try {
    persona = await memory?.persona?.() ?? null;
    narrative = await memory?.narrative?.() ?? null;
  } catch (error) {
    logger?.debug?.('主动回合读取记忆失败', { key: sessionKey, reason: error?.message ?? String(error) });
  }

  const recent = q.recentMessages(db, sessionKey, 12);
  const base = buildPrompt({ persona, narrative, memoryRendered: '', session, recent, config });
  const prompt = `${base}\n\n${INSTRUCTIONS[purpose] ?? INSTRUCTIONS.open}`;

  const generation = Number(q.getKv(db, `gen:${sessionKey}`, '1')) || 1;
  let sessionId = session.agentSession ?? null;
  if (!sessionId) {
    sessionId = await agent.ensureSession(sessionKey, { preset: config?.agent?.preset, generation });
    q.setAgentSession(db, sessionKey, sessionId);
  }

  let text = '';
  try {
    text = await collectText(agent.send(sessionId, prompt));
  } catch (error) {
    logger?.warn?.('主动回合失败', { key: sessionKey, purpose, reason: error?.message ?? String(error) });
    return { ok: false, reason: String(error?.message ?? error) };
  }

  const toolSent = takeToolSend(sessionKey);
  let sent = [];
  if (toolSent === 0 && text && !looksLikeProcessNarration(text).meta) {
    const parts = split(text, {
      threshold: config?.send?.splitThreshold ?? 60,
      maxParts: config?.send?.maxParts ?? 3,
    });
    for (const part of parts) {
      const result = await qq.sendText(sessionKey, part, {});
      if (!result?.ok) break;
      sent.push(part);
    }
  }

  logger?.info?.('主动回合完成', {
    key: sessionKey, purpose, toolSent, sentParts: sent.length, textLen: String(text ?? '').length,
  });
  return { ok: true, sent: sent.length + toolSent, text };
}
