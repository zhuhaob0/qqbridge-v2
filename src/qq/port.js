/**
 * QqPort：与 QQ（OneBot/SnowLuma）的边界
 *
 * interface QqPort {
 *   sendText(sessionKey, text, opts?): Promise<{ ok, msgId? , error? }>
 *   sendImage?(sessionKey, url, opts?): Promise<{ ok, msgId? }>
 *   markRead?(sessionKey, throughSeq): Promise<void>
 *   history?(sessionKey, { limit }): Promise<Message[]>
 * }
 */

export function assertQqPort(qq) {
  if (typeof qq?.sendText !== 'function') throw new TypeError('QqPort 缺少 sendText');
  return qq;
}
