/**
 * 应用装配：router + wake + batcher + orchestrator
 * 传输层（SnowLuma）在 index.js 注入，便于测试时替换。
 */

import { createRouter } from './router/router.js';
import { shouldWake } from './wake/policy.js';
import { createBatcher } from './wake/batcher.js';
import { createOrchestrator } from './orchestrator/run.js';

export function createApp({
  db, config, agent, qq, memory = null, logger = null, clock = () => new Date(), random = Math.random, sleep,
} = {}) {
  const orchestrator = createOrchestrator({ db, config, agent, qq, memory, logger, clock, random, sleep });

  const batcher = createBatcher({
    windowMs: config?.wake?.batchWindowMs ?? 1500,
    onFlush: async (sessionKey) => {
      try {
        await orchestrator.run(sessionKey);
      } catch (error) {
        logger?.error?.('编排异常', { key: sessionKey, reason: error?.message ?? String(error) });
      }
    },
  });

  const router = createRouter({
    db,
    config,
    logger,
    clock,
    onMessage: (msg) => {
      const session = { wakeState: { mode: 'active' } };
      const decision = shouldWake({ msg, session, config, now: clock().getTime(), random });
      if (!decision.wake) {
        logger?.debug?.('不唤醒', { key: msg.sessionKey, reason: decision.reason });
        return;
      }
      batcher.push(msg.sessionKey, msg);
    },
  });

  return { router, orchestrator, batcher };
}
