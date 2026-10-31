/**
 * 干跑模式：不真正发消息，只记录（用于影子验证）
 */

export function createDryRunQq({ logger = null } = {}) {
  const sent = [];
  return {
    sent,
    async sendText(sessionKey, message) {
      sent.push({ sessionKey, message, at: new Date().toISOString() });
      logger?.info?.('[dry-run] 本应发送', { key: sessionKey, text: String(message).slice(0, 60) });
      return { ok: true, msgId: `dry_${sent.length}` };
    },
    async markRead() {},
    async history() {
      return [];
    },
  };
}
