/**
 * 批量窗口：把短时间内的一串消息合并成一次唤醒
 */

export function createBatcher({ windowMs = 1500, onFlush, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new Map();

  function schedule(sessionKey) {
    const existing = pending.get(sessionKey);
    if (existing) clearTimer(existing.timer);
    const timer = setTimer(() => {
      const entry = pending.get(sessionKey);
      if (!entry) return;
      pending.delete(sessionKey);
      onFlush(sessionKey, entry.items);
    }, windowMs);
    pending.set(sessionKey, { timer, items: existing?.items ?? [] });
  }

  return {
    push(sessionKey, item) {
      const entry = pending.get(sessionKey);
      if (entry) entry.items.push(item);
      else pending.set(sessionKey, { timer: null, items: [item] });
      schedule(sessionKey);
      return pending.get(sessionKey).items.length;
    },
    pendingCount(sessionKey) {
      return pending.get(sessionKey)?.items.length ?? 0;
    },
    flush(sessionKey) {
      const entry = pending.get(sessionKey);
      if (!entry) return [];
      clearTimer(entry.timer);
      pending.delete(sessionKey);
      onFlush(sessionKey, entry.items);
      return entry.items;
    },
    flushAll() {
      for (const key of [...pending.keys()]) this.flush(key);
    },
    size() {
      return pending.size;
    },
  };
}
