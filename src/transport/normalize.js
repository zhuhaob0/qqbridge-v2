/**
 * 把 OneBot/SnowLuma 原始事件归一化成内部消息（纯函数，可单测）
 */

const MEDIA_TYPES = new Set(['image', 'record', 'video', 'file']);

function textFromSegments(segments) {
  if (!Array.isArray(segments)) {
    return { text: String(segments ?? '').trim(), hasMedia: false, media: [] };
  }
  const parts = [];
  let hasMedia = false;
  const media = [];

  for (const seg of segments) {
    const type = seg?.type;
    const data = seg?.data ?? {};
    if (type === 'text') parts.push(data.text ?? '');
    else if (type === 'at') parts.push(`@${data.qq ?? ''}`);
    else if (type === 'face') parts.push('[表情]');
    else if (MEDIA_TYPES.has(type)) {
      hasMedia = true;
      media.push({ type, ...(data.file ? { file: data.file } : {}), ...(data.url ? { url: data.url } : {}) });
      parts.push(type === 'record' ? '[语音]' : type === 'image' ? '[图片]' : `[${type}]`);
    } else if (data.text) parts.push(data.text);
  }
  return { text: parts.join('').trim(), hasMedia, media };
}

/**
 * @param {object} raw       OneBot 事件
 * @param {object} opts      { selfQQ, ownerQQ }
 * @returns {null|object}    NormalizedMessage
 */
export function normalizeEvent(raw, { selfQQ } = {}) {
  if (!raw || raw.post_type !== 'message') return null;

  const type = raw.message_type;
  if (type !== 'private' && type !== 'group') return null;

  const isGroup = type === 'group';
  const id = isGroup ? String(raw.group_id ?? '') : String(raw.user_id ?? '');
  if (!id || id === '0') return null;

  const sessionKey = isGroup ? `group:${id}` : `private:${id}`;
  const senderId = String(raw.sender?.user_id ?? raw.user_id ?? '');
  if (!senderId) return null;

  const direction = selfQQ && senderId === String(selfQQ) ? 'outbound' : 'inbound';
  const { text, hasMedia, media } = textFromSegments(raw.message ?? raw.raw_message ?? '');

  return {
    msgId: String(raw.message_id ?? raw.msg_id ?? ''),
    sessionKey,
    kind: isGroup ? 'public' : 'direct',
    direction,
    senderId,
    senderName: raw.sender?.card || raw.sender?.nickname || '',
    text,
    hasMedia,
    media,
    at: raw.time ? new Date(Number(raw.time) * 1000).toISOString() : new Date().toISOString(),
    raw,
  };
}

/** 是否是"自己发的"（用于跳过自己触发的唤醒） */
export function isSelfMessage(msg, selfQQ) {
  return Boolean(selfQQ) && String(msg?.senderId ?? '') === String(selfQQ);
}
