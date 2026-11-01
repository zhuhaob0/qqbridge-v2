/**
 * 过程叙述过滤器
 *
 * 问题：QQ preset 告诉模型「文本只是思考，不会自动发送」，模型于是把内心活动写进文本：
 *   “void_love @ 雨花石，说她偏爱这种片子。那话是冲雨花石说的，我没插进去，就标成已读继续潜水。”
 * 而编排层在模型没用发送工具时会把文本自动转发 —— 内心独白就漏到群里了。
 *
 * 判断分两档：
 * - 硬特征（“已读/标成/唤醒/没插进去”）：命中一个就够了，正常人不会在聊天里说这些
 * - 软特征（“潜水/观察/会话”）：命中两个及以上才判定，避免误伤正常玩笑
 */

const HARD_TERMS = [
  '已读', '标成', '标记为', 'readThrough', '唤醒', '快照',
  '没插', '插不进去', '插不上话', '继续等', '本轮', '这轮', '工具调用', 'token', '令牌',
];

const SOFT_TERMS = [
  '潜水', '观察', '内心', '会话', '桥接', '记下', '判断', '结论', '沉默', '不接话',
];

const PATTERNS = [
  /我(先|就|也)?把.{0,12}(标|设|置).{0,8}(已读|已看)/,
  /(继续|接着|先).{0,4}潜(水|着)/,
  /没(有)?插(进去|上话|话)/,
  /这(话|句|条).{0,10}(冲|对|是跟).{0,10}(说|讲)/,
  /(记|写)下.{0,6}(想法|判断|结论)/,
  /mark(ed)?\s*(it\s*)?as\s*read/i,
  /\bdiving\b|\bgo\s+quiet\b/i,
];

/**
 * @param {string} text 模型输出的文本
 * @param {{maxMetaLength?: number}} [options]
 * @returns {{ meta: boolean, reason?: string }}
 */
export function looksLikeProcessNarration(text, { maxMetaLength = 200 } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return { meta: false };
  if (value.length > maxMetaLength) return { meta: false };

  for (const pattern of PATTERNS) {
    if (pattern.test(value)) return { meta: true, reason: `pattern:${pattern.source.slice(0, 26)}` };
  }

  const hard = HARD_TERMS.filter((term) => value.includes(term));
  if (hard.length >= 1) return { meta: true, reason: `hard:${hard.join('/')}` };

  const soft = SOFT_TERMS.filter((term) => value.includes(term));
  if (soft.length >= 2) return { meta: true, reason: `soft:${soft.join('/')}` };

  return { meta: false };
}
