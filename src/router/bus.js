/**
 * 进程内事件总线：router 发布新消息，工具（如 wait_for_messages）订阅
 */

import { EventEmitter } from 'node:events';

export function createBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

  return {
    emitMessage(msg) {
      emitter.emit('message', msg);
    },
    onMessage(listener) {
      emitter.on('message', listener);
      return () => emitter.off('message', listener);
    },
    /**
     * 等这个会话的入站消息，直到「安静 quietMs」或超时。
     * @returns {Promise<{messages: object[], waitedMs: number, timedOut: boolean}>}
     */
    waitQuiet(sessionKey, { timeoutMs = 8000, quietMs = 1500 } = {}) {
      return new Promise((resolve) => {
        const startedAt = Date.now();
        const messages = [];
        let quietTimer = null;
        let hardTimer = null;
        const finish = (timedOut) => {
          off();
          if (quietTimer) clearTimeout(quietTimer);
          if (hardTimer) clearTimeout(hardTimer);
          resolve({ messages, waitedMs: Date.now() - startedAt, timedOut });
        };
        const off = this.onMessage((msg) => {
          if (msg.sessionKey !== sessionKey) return;
          if (msg.direction !== 'inbound') return;
          messages.push(msg);
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(false), Math.max(0, quietMs));
          quietTimer.unref?.();
        });
        hardTimer = setTimeout(() => finish(true), Math.max(0, timeoutMs));
        hardTimer.unref?.();
      });
    },

    /** 等一条指定会话的入站消息 */
    waitFor(sessionKey, { timeoutMs = 30000 } = {}) {
      return new Promise((resolve) => {
        let timer = null;
        const off = this.onMessage((msg) => {
          if (msg.sessionKey !== sessionKey) return;
          if (msg.direction !== 'inbound') return;
          cleanup();
          resolve(msg);
        });
        const cleanup = () => {
          off();
          if (timer) clearTimeout(timer);
        };
        timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, Math.max(0, timeoutMs));
      });
    },
  };
}
