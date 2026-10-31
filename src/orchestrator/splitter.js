/**
 * 分条：把一段回复拆成"真人打字"的节奏（纯函数）
 */

const HARD_BREAK = /[。！？!?…\n]/;
const SOFT_BREAK = /[，,；;、：:]/;

/**
 * @param {string} text
 * @param {{threshold?: number, maxParts?: number}} [opts]
 * @returns {string[]}
 */
export function split(text, { threshold = 60, maxParts = 5 } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  // 1) 先按换行与句末标点切成句子（保留标点）
  const sentences = [];
  let buffer = '';
  for (const ch of raw) {
    buffer += ch;
    if (HARD_BREAK.test(ch)) {
      sentences.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim());

  // 2) 合并短句到 threshold，过长的再按逗号切
  const parts = [];
  let current = '';
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (sentence.length > threshold * 1.6) {
      if (current) {
        parts.push(current);
        current = '';
      }
      parts.push(...splitLong(sentence, threshold));
      continue;
    }
    if (current && current.length + sentence.length > threshold) {
      parts.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current) parts.push(current);

  // 3) 条数上限：多余的并到最后一 条
  if (parts.length > maxParts) {
    const head = parts.slice(0, maxParts - 1);
    const tail = parts.slice(maxParts - 1).join('');
    return [...head, tail];
  }
  return parts.map((p) => p.trim()).filter(Boolean);
}

function splitLong(sentence, threshold) {
  const out = [];
  let buffer = '';
  for (const ch of sentence) {
    buffer += ch;
    if (SOFT_BREAK.test(ch) && buffer.length >= threshold * 0.5) {
      out.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}
