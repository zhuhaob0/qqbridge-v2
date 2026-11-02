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
  db, q, config, logger = null, memory = null,
  runProactive,
  clock = () => Date.now(),
  random = Math.random,
  intervalMs = 60 * 60 * 1000,
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

  /** 说说的窗口/频率判定（纯逻辑，方便测试） */
  function qzoneDue({ now, cfg, lastAt, postedToday }) {
    const q = cfg().qzone ?? {};
    if (q.enabled !== true) return false;
    if (postedToday >= Number(q.perDay ?? 3)) return false;
    // 时间窗是可选的：不配就任何时间都能发（v1 没有时间限制）
    if (q.windowStartHour != null && q.windowEndHour != null) {
      const start = Number(q.windowStartHour);
      const end = Number(q.windowEndHour);
      const hour = new Date(now).getHours();
      if (start <= end ? (hour < start || hour >= end) : (hour < start && hour >= end)) return false;
    }
    const cooldown = Number(q.cooldownMs ?? 6 * 3600 * 1000);
    if (lastAt && now - lastAt < cooldown) return false;
    return random() < Number(q.probability ?? 0.3);
  }

  /** 按 tier 取规则：owner > L4 > L3 */
  function privateRuleFor(tier) {
    const qc = cfg().private ?? {};
    const tiers = qc.tiers ?? {};
    if (tier === 'owner') return { ...(qc.owner ?? {}), enabled: qc.enabled === true };
    const rule = tiers[tier] ?? null;
    if (!rule || rule.enabled === false) return null;
    return rule;
  }

  async function maybeProactivePrivate(now) {
    const qc = cfg().private ?? {};
    if (qc.enabled !== true) return;
    const ownerQQ = config?.qq?.ownerQQ;
    const candidates = [];
    if (ownerQQ) candidates.push({ sessionKey: 'private:' + ownerQQ, tier: 'owner' });

    // L3/L4 好友：来自 mnema 关系表
    try {
      const rels = await memory?.relationships?.() ?? [];
      for (const r of rels) {
        const qq = String(r.contactId ?? '').split(':').pop();
        if (!qq || qq === String(ownerQQ)) continue;
        if (r.tier !== 'L3' && r.tier !== 'L4') continue;
        candidates.push({ sessionKey: 'private:' + qq, tier: r.tier });
      }
    } catch (error) {
      logger?.debug?.('读取关系失败，跳过 L3/L4 主动私聊', { reason: error?.message ?? String(error) });
    }

    for (const { sessionKey, tier } of candidates) {
      const rule = privateRuleFor(tier);
      if (!rule) continue;
      const session = q.getSession?.(db, sessionKey);
      if (!session) continue;

      const dayKey = new Date(now).toISOString().slice(0, 10);
      const keyPrefix = 'private:proactive:' + sessionKey;
      const storedDay = q.getKv?.(db, keyPrefix + ':dayKey', '');
      const usedToday = storedDay === dayKey ? Number(q.getKv?.(db, keyPrefix + ':day', '0')) : 0;
      if (usedToday >= Number(rule.perDay ?? 1)) continue;

      const lastAt = Number(q.getKv?.(db, keyPrefix + ':last', '0')) || 0;
      if (lastAt && now - lastAt < Number(rule.cooldownMs ?? 6 * 3600 * 1000)) continue;

      const lastInbound = lastInboundAt(sessionKey);
      if (lastInbound && now - lastInbound < Number(rule.minIdleHours ?? 24) * 3600 * 1000) continue;

      if (random() >= Number(rule.probability ?? 0.2)) continue;

      q.setKv?.(db, keyPrefix + ':last', String(now));
      q.setKv?.(db, keyPrefix + ':dayKey', dayKey);
      q.setKv?.(db, keyPrefix + ':day', String(usedToday + 1));
      logger?.info?.('社交模式：尝试主动私聊', { sessionKey, tier });
      await runProactive(sessionKey, 'private');
    }
  }

  async function maybePostQzone(now) {
    const ownerQQ = config?.qq?.ownerQQ;
    if (!ownerQQ) return;
    const sessionKey = 'private:' + ownerQQ;
    const lastAt = Number(q.getKv?.(db, 'qzone:proactive:last', '0')) || 0;
    const postedToday = Number(q.getKv?.(db, 'qzone:proactive:day', '0')) || 0;
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const storedDay = q.getKv?.(db, 'qzone:proactive:dayKey', '');
    const posted = storedDay === dayKey ? postedToday : 0;
    if (!qzoneDue({ now, cfg, lastAt, postedToday: posted })) return;
    q.setKv?.(db, 'qzone:proactive:last', String(now));
    q.setKv?.(db, 'qzone:proactive:dayKey', dayKey);
    q.setKv?.(db, 'qzone:proactive:day', String(posted + 1));
    logger?.info?.('社交模式：尝试发说说', { sessionKey });
    await runProactive(sessionKey, 'qzone');
  }

  /** 主动开口后安排一次精准的冷场检查（不依赖 tick 频率） */
  function scheduleProbe(key) {
    const delay = Number(cfg().probeAfterIdleMs ?? 3 * 60 * 1000) + 1000;
    const timer = setTimeout(async () => {
      const st = states.get(key);
      if (!st || st.phase !== 'active') return;
      const now = clock();
      const lastAt = lastInboundAt(key);
      if (now - Math.max(st.lastActiveAt, lastAt) < Number(cfg().probeAfterIdleMs ?? 3 * 60 * 1000)) return;
      if (!enabled()) return;
      if (random() >= Number(cfg().probeProbability ?? 0.25)) {
        st.phase = 'idle';
        logger?.info?.('社交模式：冷场回观望（定时检查）', { key });
        return;
      }
      logger?.info?.('社交模式：冷场试探（定时检查）', { key });
      const result = await runProactive(key, 'probe');
      st.phase = 'probing';
      st.probeDeadline = clock() + Number(cfg().probeWaitMs ?? 2 * 60 * 1000);
      st.lastActiveAt = now;
    }, Math.max(1000, delay));
    timer.unref?.();
  }

  async function tick() {
    if (!enabled() || busy) return;
    busy = true;
    try {
      const now = clock();
      await maybeProactivePrivate(now);
      await maybePostQzone(now);
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
            scheduleProbe(key);
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
