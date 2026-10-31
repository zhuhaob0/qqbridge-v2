/**
 * 假宿主：单测用（不依赖 DSH）
 */

export function createFakeAgent({ replies = ['好的'], delayMs = 0, failOn = null } = {}) {
  const prompts = [];
  const sessions = new Map();
  let index = 0;

  return {
    prompts,
    sessions,
    async ensureSession(sessionKey, options = {}) {
      if (!sessions.has(sessionKey)) sessions.set(sessionKey, `sess_${sessions.size + 1}`);
      void options;
      return sessions.get(sessionKey);
    },
    async *send(sessionId, message) {
      prompts.push({ sessionId, message });
      if (failOn && prompts.length === failOn) {
        yield { type: 'error', error: new Error('fake agent failure') };
        return;
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      yield { type: 'text', text: reply };
      yield { type: 'done' };
    },
    async close() {},
  };
}
