/**
 * 假 QqPort：单测用
 */

export function createFakeQq({ failTimes = 0 } = {}) {
  const sent = [];
  let failures = 0;

  return {
    sent,
    async sendText(sessionKey, text, opts = {}) {
      if (failures < failTimes) {
        failures += 1;
        return { ok: false, error: 'fake send failure' };
      }
      sent.push({ sessionKey, text, opts, at: new Date().toISOString() });
      return { ok: true, msgId: `m${sent.length}` };
    },
    async markRead() {},
    async history() {
      return [];
    },
  };
}
