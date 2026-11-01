/**
 * 社交循环（与 v1 语义一致）
 *
 * 每 5 秒看一次群里有没有动静，按「观望 / 活跃 / 试探」三态推进：
 *
 *   idle（观望）
 *     群安静超过 idleThresholdMs 后，每隔 checkMin~checkMax 随机检查一次，
 *     以 probability 的概率主动开话题 → active
 *
 *   active（活跃）
 *     自己开口后，若 probeAfterIdleMs 内没人接话：
 *       小概率 probe（试探一句）→ probing
 *       否则回 idle
 *
 *   probing（试探）
 *     等 probeWaitMs 还没有人说话 → idle
 *
 * 与 v1 的差别：v1 还有"活跃期选择性沉默/退场发言"，这里只保留主动开话题与试探，
 * 因为 v2 的唤醒策略已经负责"要不要回"。
 */

export function createSocialLoop({
  db, q, config, logger = null,
  runProactive,
  clock = () => Date.now(),
  random = Math.random,
  intervalMs = 5000,
} = {}) {
  const states = new Map();
  let timer = null;
  let busy = false;

  const cfg = () => config?.social ?? {};
  const enabled = () => config?.social?.enabled !== false && config?.social?.proactiveEnabled !== false;

  function stateFor(key) {
    if (!states.has(key)) {
      states.set(key, { phase: 'idle', nextCheckAt: 0, lastActiveAt: 0, probeDeadline: 0 });
    }
    return states.get(key);
  }

  function randInt(min, max) {
    const a = Number(min) || 0;
    const b = Number(max) || a;
    if (b <= a) return Math.max(0, a);
    return Math.floor(a + random() * (b - a));
  }

  function lastInboundAt(sessionKey) {
    const row = q.latestInbound?.(db, sessionKey);
    const at = row?.at ? Date.parse(row.at) : 0;
    return Number.isFinite(at) ? at : 0;
  }

  async function tick() {
    if (!enabled() || busy) return;
    busy = true;
    try {
      const now = clock();
      const sessions = q.listSessions(db, 200).filter((s) => String(s.sessionKey ?? s.session_key ?? '').startsWith('group:'));
      for (const item of sessions) {
        const key = String(item.sessionKey ?? item.session_key);
        const st = stateFor(key);
        const lastAt = lastInboundAt(key);

        if (st.phase === 'idle') {
          const idleFor = now - lastAt;
          if (idleFor < Number(cfg().idleThresholdMs ?? 30 * 60 * 1000)) continue;
          if (!st.nextCheckAt) {
            st.nextCheckAt = now + randInt(cfg().checkMinMs ?? 45 * 60 * 1000, cfg().checkMaxMs ?? 90 * 60 * 1000);
            continue;
          }
          if (now < st.nextCheckAt) continue;
          st.nextCheckAt = now + randInt(cfg().checkMinMs ?? 45 * 60 * 1000, cfg().checkMaxMs ?? 90 * 60 * 1000);
          if (random() >= Number(cfg().probability ?? 0.2)) continue;
          logger?.info?.('社交模式：观望期主动开话题', { key, idleForMs: idleFor });
          const result = await runProactive(key, 'open');
          if (result?.ok && result.sent > 0) {
            st.phase = 'active';
            st.lastActiveAt = now;
          }
          continue;
        }

        if (st.phase === 'active') {
          const silentFor = now - Math.max(st.lastActiveAt, lastAt);
          if (silentFor < Number(cfg().probeAfterIdleMs ?? 3 * 60 * 1000)) continue;
          if (random() < Number(cfg().probeProbability ?? 0.25)) {
            logger?.info?.('社交模式：冷场试探', { key, silentForMs: silentFor });
            const result = await runProactive(key, 'probe');
            st.phase = 'probing';
            st.probeDeadline = now + Number(cfg().probeWaitMs ?? 2 * 60 * 1000);
            st.lastActiveAt = now;
          } else {
            st.phase = 'idle';
            logger?.info?.('社交模式：冷场回观望', { key });
          }
          continue;
        }

        if (st.phase === 'probing') {
          if (now < st.probeDeadline) continue;
          if (lastAt > st.probeDeadline) {
            // 期间有人说话：交给正常唤醒链路
            st.phase = 'idle';
            continue;
          }
          st.phase = 'idle';
          logger?.info?.('社交模式：试探无回应，回观望', { key });
        }
      }
    } catch (error) {
      logger?.warn?.('社交循环异常', { reason: error?.message ?? String(error) });
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref?.();
      logger?.info?.('社交循环已启动', { intervalMs });
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    states,
  };
}
