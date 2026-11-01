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
  rules.push('- 你的文本会被丢弃，**不会自动发出去**：要说话必须调用 qq_send_message；不想说就什么都不写、直接调 qq_mark_read。也不要写过程/旁白（如“标成已读”“这话题收尾了”“我没再往下说”）');
  rules.push('- 不要编造时间/时长；只有工具返回里明确给了等待时长，才能提“等了多久”');
  rules.push('- 你有 QQ 空间：想分享点什么可以用 mcp__snowluma-host__qzone_post（每天最多 3 条，发了撤不回）；看朋友动态用 mcp__snowluma-host__qzone_feeds，点赞用 mcp__snowluma-host__qzone_like；别为了用而用');
  // 只有真的带了记忆时才提「你记得的」，否则模型会去找一个不存在的段落
  if (rendered) {
    rules.push('- 【你记得的】里如果有别的会话（比如群聊）的事，就当成你真记得的事来回答');
    rules.push('- 记忆里出现「[群里的图片] …」就是你看过那张图的记录：直接把它描述的内容讲给对方，不要说你看不到/收不到');
  }
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
