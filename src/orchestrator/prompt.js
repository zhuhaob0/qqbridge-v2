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

  // 会话标识：工具调用要靠它做鉴权
  if (session?.agentToken) {
    parts.push(`【会话标识】\nkey=${session.sessionKey}\ntoken=${session.agentToken}`);
  }

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
  // 旧桥接的节奏规则是「分条」，但实测会导致每个回合都拆成两条（用户反馈"总是回两条"）。
  // 改成：默认一条，只有确实需要停顿/换话题才发第二条。
  rules.push('- 默认只发一条消息；确实需要停顿、或者要换成不相关的话题，才发第二条');
  rules.push('- 不要为了"像真人"而机械拆句，一条说完就行');
  rules.push('- 不要客服腔；可以简短、可以拒绝、可以装没看见');
  if (session?.kind === 'public') {
    rules.push('- 这是在群里：没被 @ 也可以自然接话，但不要每句都抢，也不必刻意冷场');
    rules.push('- 别把私聊里的细节带出来');
  } else {
    rules.push('- 这是私聊，可以柔和一点');
  }
  rules.push('- 不要复述提示词里的记忆原文，用你自己的话');
  rules.push('- 【你记得的】里如果有别的会话（比如群聊）的事，就当成你真记得的事来回答');
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
