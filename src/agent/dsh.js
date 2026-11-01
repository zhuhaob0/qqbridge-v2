/**
 * AgentPort 的 DSH 实现
 *
 * 只做三件事：确保会话、发一条 prompt、把该会话的 turn 事件收成文本。
 * 协议细节留在 vendor/dsh-client.js（见 vendor/README.md）。
 */

import path from 'node:path';

/** DSH 会话 id 要编码 QQ 会话：preset 的 qq-tool-restrict 靠它做跨会话绑定校验 */
function selfKeyFor(sessionKey) {
  const m = /^(private|group):(\d{1,20})$/.exec(String(sessionKey ?? ''));
  if (!m) return null;
  return `qqb-${m[1] === 'group' ? 'g' : 'p'}-${m[2]}`;
}
import { createTurnCollector } from './collector.js';

/**
 * @param {object} options
 * @param {object} options.api        NodeApiClient（可注入假实现用于测试）
 * @param {string} [options.workspacePath]
 * @param {string} [options.preset]
 * @param {object} [options.logger]
 * @param {number} [options.turnTimeoutMs]
 */
export function createDshAgent({
  api,
  workspacePath = null,
  preset = null,
  logger = null,
  turnTimeoutMs = 90000,
  workspaceTitle = null,
  resolveBase = null,
} = {}) {
  const waiters = new Map(); // sessionId -> { collector, resolve, reject, timer }
  const sessionByKey = new Map();
  let pumpRunning = false;
  let pumpStop = null;

  // 工作区只建一次：DSH 的 create 对同一路径是幂等的，但标题参数会被忽略，
  // 需要在创建后单独 rename（已存在的同名工作区会让 rename 报 name-conflict，忽略即可）。
  let workspaceIdCache = null;
  async function ensureWorkspace() {
    if (!workspacePath) return null;
    if (workspaceIdCache) return workspaceIdCache;
    // 相对路径会按 DSH 进程的 cwd 解析（不是桥接的 cwd），所以这里先转绝对路径
    const absolute = path.resolve(workspacePath);
    const value = api.workspace.create({ path: absolute });
    const resolved = value?.then ? await value : value;
    const body = resolved?.result?.ok ? resolved.result.value : resolved;
    const workspaceId = body?.workspace?.workspaceId ?? body?.workspaceId ?? null;
    if (!workspaceId) {
      logger?.warn?.('创建工作区失败，会话会落到默认工作区', { path: absolute, error: JSON.stringify(resolved?.result?.error ?? {}).slice(0, 200) });
      return null;
    }
    workspaceIdCache = workspaceId;
    const currentTitle = body?.workspace?.title ?? body?.title ?? '';
    if (workspaceTitle && currentTitle !== workspaceTitle) {
      try {
        const renamed = await api.workspace.rename({ workspaceId, title: workspaceTitle });
        if (!renamed?.result?.ok) {
          logger?.debug?.('工作区改名失败（通常同名已存在）', { workspaceId, title: workspaceTitle, error: renamed?.result?.error?.code });
        }
      } catch (error) {
        logger?.debug?.('工作区改名异常', { reason: error?.message ?? String(error) });
      }
    }
    return workspaceId;
  }

  /** 当前 DSH 里已有的会话 id（用于复用，避免每次重启都新建一个） */
  let knownSessions = null;
  async function refreshKnownSessions() {
    try {
      const raw = await api.sessions.list({});
      const body = raw?.result?.ok ? raw.result.value : raw;
      const list = body?.sessions ?? body?.items ?? (Array.isArray(body) ? body : []);
      knownSessions = new Map(list.filter((s) => s?.sessionId).map((s) => [s.sessionId, s?.projections?.values?.title ?? s?.title ?? '']));
      return knownSessions;
    } catch (error) {
      logger?.warn?.('读取会话列表失败', { reason: error?.message ?? String(error) });
      knownSessions = null;
      return null;
    }
  }

  /** 让会话标题可读（DSH 默认会用首条消息当标题，QQ 这边首条是【你的性格】） */
  async function ensureTitle(sessionId, sessionKey, titleOverride = '') {
    if (!sessionId) return;
    const desired = titleOverride || (/^group:(\d{1,20})$/.test(sessionKey)
      ? 'QQ 群 · ' + sessionKey.slice('group:'.length)
      : 'QQ 私聊 · ' + sessionKey.slice('private:'.length));
    const current = knownSessions?.get(sessionId) ?? '';
    // 已经是我们起的名字就不动（尊重手动重命名）；只有空标题或自动生成的才改
    const auto = current === '' || current.startsWith('【') || current.startsWith('session-') || /^QQ (私聊|群) ·/.test(current);
    if (!auto || current === desired) return;
    try {
      const raw = await api.sessions.rename({ sessionId, title: desired });
      if (raw?.result?.ok) {
        knownSessions?.set(sessionId, desired);
        logger?.info?.('会话标题已设为可读', { sessionKey, title: desired });
      } else {
        logger?.debug?.('会话改名失败', { sessionKey, error: raw?.result?.error?.code });
      }
    } catch (error) {
      logger?.debug?.('会话改名异常', { reason: error?.message ?? String(error) });
    }
  }

  async function ensureSession(sessionKey, options = {}) {
    if (sessionByKey.has(sessionKey)) return sessionByKey.get(sessionKey);
    const workspaceId = await ensureWorkspace();
    const params = { ...(workspaceId ? { workspaceId } : {}) };
    const wantPreset = options.preset ?? preset;
    if (wantPreset) params.agentPreset = wantPreset;

    const selfKey = selfKeyFor(sessionKey);

    // 先看这个 QQ 会话是否已经有对应的 DSH 会话：
    // DSH 的 create 在 id 已存在时会**新建一个 uuid 会话**（实测），
    // 所以必须先 list、命中就复用，否则每次重启都会多一个会话。
    if (selfKey) {
      const known = knownSessions ?? await refreshKnownSessions();
      if (known?.has(selfKey)) {
        sessionByKey.set(sessionKey, selfKey);
        api.events?.follow?.(selfKey);
        logger?.info?.('复用已有的 DSH 会话', { sessionKey, sessionId: selfKey });
        await ensureTitle(selfKey, sessionKey, options.title);
        return selfKey;
      }
      params.sessionId = selfKey;
    }

    let raw = await api.sessions.create(params);
    let body = raw?.result?.ok ? raw.result.value : raw;
    if (!body?.sessionId && selfKey) {
      const message = JSON.stringify(raw?.result?.error ?? raw);
      logger?.warn?.('创建 DSH 会话失败', { sessionKey, error: message.slice(0, 200) });
    }
    const sessionId = body?.sessionId ?? null;
    if (!sessionId) throw new Error('DSH 未返回 sessionId');
    knownSessions?.set(sessionId, '');
    sessionByKey.set(sessionKey, sessionId);
    api.events?.follow?.(sessionId);
    logger?.info?.('已创建 DSH 会话', { sessionKey, sessionId, preset: wantPreset ?? null });
    await ensureTitle(sessionId, sessionKey, options.title);
    return sessionId;
  }

  function dispatch(frame) {
    if (!frame || frame.type !== 'session/event') return;
    const waiter = waiters.get(frame.sessionId);
    if (!waiter) return;
    const ended = waiter.collector.push(frame.event);
    if (!ended) return;
    waiters.delete(frame.sessionId);
    clearTimeout(waiter.timer);
    waiter.resolve(ended);
  }

  async function pump() {
    if (pumpRunning) return;
    pumpRunning = true;
    const controller = new AbortController();
    pumpStop = () => controller.abort();
    let frames = 0;
    try {
      for await (const envelope of api.events.mux({}, controller.signal)) {
        frames += 1;
        dispatch(envelope?.payload ?? envelope);
      }
      logger?.info?.('DSH 事件流自然结束', { frames });
    } catch (error) {
      if (!controller.signal.aborted) {
        logger?.warn?.('DSH 事件流中断', { reason: error?.message ?? String(error), frames });
      }
    } finally {
      pumpRunning = false;
    }
  }

  async function* send(sessionId, message) {
    if (!pumpRunning) pump().catch(() => {});
    api.events?.follow?.(sessionId);

    const collector = createTurnCollector();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(sessionId);
        reject(new Error('DSH 回合超时'));
      }, turnTimeoutMs);
      waiters.set(sessionId, { collector, resolve, reject, timer });
    });

    // message 可以是字符串，也可以是内容块数组（文本 + 图片），后者用于让模型真正「看到」图片
    const content = Array.isArray(message)
      ? message
      : [{ type: 'text', text: String(message ?? '') }];
    const promptTimeoutMs = turnTimeoutMs;
    await Promise.race([
      api.sessions.prompt({ sessionId, mode: 'queue', content }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('DSH prompt 请求超时')), promptTimeoutMs);
        timer.unref?.();
      }),
    ]);

    const ended = await result;
    if (ended?.reason?.kind && ended.reason.kind !== 'completed') {
      throw new Error(`回合未正常完成：${ended.reason.kind}`);
    }
    if (ended?.text) yield { type: 'text', text: ended.text };
    yield { type: 'done' };
  }

  /** DSH 换了端口：重新解析并切过去（调用方在 fetch failed 时调用） */
  function refreshBase() {
    if (typeof resolveBase !== 'function') return null;
    const next = resolveBase();
    if (!next?.baseUrl || next.baseUrl === api.baseUrl) return null;
    logger?.warn?.('DSH 端口变化，切换 baseUrl', { from: api.baseUrl, to: next.baseUrl, source: next.source });
    api.baseUrl = next.baseUrl;
    try { api.invalidateAuth?.(); } catch { /* 忽略 */ }
    return next.baseUrl;
  }

  return {
    api,
    refreshBase,
    ensureSession,
    send,
    startPump: pump,
    stopPump: () => pumpStop?.(),
    async close() {
      for (const [sid, waiter] of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('会话关闭'));
        waiters.delete(sid);
      }
      pumpStop?.();
    },
  };
}

/** 从配置创建（动态 import，避免测试环境强制安装依赖） */
export async function createDshAgentFromConfig(config, { logger = null } = {}) {
  const { NodeApiClient } = await import('../../vendor/dsh-client.js');
  const { resolveDshBase } = await import('./dsh-port.js');
  const dir = config?.agent?.sessionCwd ? path.resolve(config.agent.sessionCwd, '..') : process.cwd();
  const resolved = resolveDshBase({ dir, fallback: config?.agent?.baseUrl ?? '' });
  if (resolved.source !== 'env') logger?.info?.('DSH baseUrl 解析', { baseUrl: resolved.baseUrl, source: resolved.source });
  const api = new NodeApiClient(resolved.baseUrl || config?.agent?.baseUrl || '', undefined, {
    token: config?.agent?.authToken ?? '',
    header: config?.agent?.authHeader,
    prefix: config?.agent?.authPrefix,
    allowRemote: config?.agent?.allowRemote === true,
  });
  return createDshAgent({
    api,
    workspacePath: config?.agent?.sessionCwd ?? null,
    workspaceTitle: config?.agent?.workspaceTitle ?? 'QQ 聊天',
    preset: config?.agent?.preset ?? null,
    logger,
    resolveBase: () => resolveDshBase({ dir, fallback: config?.agent?.baseUrl ?? '' }),
  });
}
