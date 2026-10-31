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
