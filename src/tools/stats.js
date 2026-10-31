/**
 * 本轮工具发送计数
 *
 * 目的：如果 AI 在回合里已经用发送类工具发过消息，编排层就不要再把它返回的文本自动发一遍。
 * 旧桥接里也是这个策略（"发送类工具成功过 → 跳过自动转发"），否则一次回复会出现两条。
 */

const counts = new Map();

export function markToolSend(sessionKey) {
  if (!sessionKey) return;
  counts.set(sessionKey, (counts.get(sessionKey) ?? 0) + 1);
}

/** 取出并清零 */
export function takeToolSend(sessionKey) {
  const n = counts.get(sessionKey) ?? 0;
  counts.delete(sessionKey);
  return n;
}

export function peekToolSend(sessionKey) {
  return counts.get(sessionKey) ?? 0;
}

export const SEND_TOOLS = new Set([
  'qq_send_message',
  'qq_reply',
  'qq_send_private_message',
  'qq_send_group_message',
  'qq_send_image',
  'qq_send_sticker',
  'qq_send_voice',
]);
