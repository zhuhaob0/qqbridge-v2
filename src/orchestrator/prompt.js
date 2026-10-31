/**
 * 提示词组装（纯函数）：给定固定输入，输出稳定
 */

/**
 * @param {object} input
 * @param {object} [input.persona]     { markdown }
 * @param {object} [input.narrative]   { markdown }
 * @param {string} [input.memoryRendered]  mnema 的 rendered
 * @param {object} input.session       { sessionKey, kind, participants }
 * @param {Array}  input.recent        最近消息（升序）
 * @param {object} [input.traits]      性格参数（可选，用于措辞提示）
 * @param {object} [input.config]
 */
export function buildPrompt({ persona, narrative, memoryRendered, session, recent = [], config } = {}) {
  const parts = [];

  const personaText = persona?.markdown?.trim();
  if (personaText) parts.push(`【你的性格】\n${personaText}`);

  const narrativeText = narrative?.markdown?.trim();
  if (narrativeText) parts.push(narrativeText);

  const rendered = String(memoryRendered ?? '').trim();
  if (rendered) parts.push(rendered);

  // 本轮对话
  const lines = ['【本轮对话】'];
  for (const m of recent) {
    const who = m.direction === 'inbound' ? (m.senderName || '对方') : '你';
    const text = String(m.text ?? '').trim();
    if (!text) continue;
    lines.push(`${who}：${text}`);
  }
  parts.push(lines.join('\n'));

  // 回复要求
  const rules = ['【怎么回】'];
  rules.push('- 分条说，一条一个意群，多数不超过 30 字');
  rules.push('- 不要客服腔；可以简短、可以拒绝、可以装没看见');
  if (session?.kind === 'public') {
    rules.push('- 这是在群里，别把私聊里的细节带出来');
  } else {
    rules.push('- 这是私聊，可以柔和一点');
  }
  rules.push('- 不要复述提示词里的记忆原文，用你自己的话');
  parts.push(rules.join('\n'));

  return parts.join('\n\n');
}

/** 会话类型相关的额外约束（工具侧用） */
export function replyPolicy(session, config) {
  return {
    maxParts: config?.send?.maxParts ?? 5,
    splitThreshold: config?.send?.splitThreshold ?? 60,
    minGapMs: config?.send?.minGapMs ?? 600,
    maxGapMs: config?.send?.maxGapMs ?? 1800,
    kind: session?.kind ?? 'direct',
  };
}
