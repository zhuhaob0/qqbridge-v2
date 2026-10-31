/**
 * 唤醒策略（纯函数）：什么时候该醒
 */

const QUESTION_RE = /(吗|呢|怎么|为什么|为啥|能不能|可不可以|是不是|有没有)[？?]?$|[？?]$/;

export function inDiving(wakeState = {}, now = Date.now()) {
  if (wakeState.mode !== 'diving') return false;
  if (!wakeState.until) return true;
  return now < new Date(wakeState.until).getTime();
}

/** 是否在文本里被点名 */
export function mentionsBot(text, { selfQQ, botNames = [] } = {}) {
  const s = String(text ?? '');
  if (selfQQ && s.includes(`@${selfQQ}`)) return true;
  return botNames.some((name) => name && s.includes(name));
}

export function isQuestion(text) {
  return QUESTION_RE.test(String(text ?? '').trim());
}

/**
 * @returns {{ wake: boolean, reason: string }}
 */
export function shouldWake({ msg, session, config, now = Date.now(), random = Math.random }) {
  const triggers = { ...(config?.wake?.triggers ?? {}), ...(session?.wakeState?.triggers ?? {}) };
  const selfQQ = config?.qq?.selfQQ;
  const botNames = config?.qq?.botNames ?? [];
  const text = msg?.text ?? '';

  const diving = inDiving(session?.wakeState, now);

  if (mentionsBot(text, { selfQQ, botNames })) {
    return { wake: triggers.at !== false ? true : false, reason: '被点名' };
  }

  // 潜水时只认触发条件
  if (diving) {
    if (triggers.name && botNames.some((n) => n && text.includes(n))) return { wake: true, reason: '被叫名字' };
    if (triggers.question && isQuestion(text)) return { wake: true, reason: '被提问' };
    const keywords = triggers.keywords ?? [];
    const hit = keywords.find((k) => k && text.includes(k));
    if (hit) return { wake: true, reason: `命中关键词:${hit}` };
    // 概率唤醒只在一对一里用：群聊里随机插话非常像刷屏（实测莫名发过两条）
    const probability = msg?.kind === 'public'
      ? Number(triggers.probabilityGroup ?? 0)
      : Number(triggers.probability ?? 0);
    if (probability > 0 && random() < probability) {
      return { wake: true, reason: '概率唤醒' };
    }
    return { wake: false, reason: '潜水中，未命中触发条件' };
  }

  if (triggers.anyMessage === false) return { wake: false, reason: '活跃但关闭了任意消息唤醒' };
  return { wake: true, reason: '活跃模式' };
}
