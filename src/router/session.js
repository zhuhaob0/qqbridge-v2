/**
 * 会话键与参与者
 *
 * 内部统一用 OneBot 风格 key：private:<qq> / group:<gid>
 * 记忆通道用 mnema 风格：chat:user:<qq> / chat:group:<gid>
 */

export function parseSessionKey(key) {
  const m = /^(private|group):(\d+)$/.exec(String(key ?? ''));
  if (!m) return null;
  return { kind: m[1] === 'private' ? 'direct' : 'public', id: m[2] };
}

export function isSessionKey(key) {
  return parseSessionKey(key) !== null;
}

/** 本项目的"自己"在记忆里的 id */
export const SELF_ID = 'self';

export function participantsFor(key, { selfId = SELF_ID } = {}) {
  const parsed = parseSessionKey(key);
  if (!parsed) return [selfId];
  if (parsed.kind === 'direct') return [selfId, `user:${parsed.id}`];
  return [selfId, `group:${parsed.id}`];
}

/** 记忆通道 id */
export function channelIdFor(key) {
  const parsed = parseSessionKey(key);
  if (!parsed) return null;
  return parsed.kind === 'direct' ? `chat:user:${parsed.id}` : `chat:group:${parsed.id}`;
}

/** 会话里的"对方"（一对一场景） */
export function counterpartFor(key) {
  const parsed = parseSessionKey(key);
  return parsed?.kind === 'direct' ? `user:${parsed.id}` : null;
}
