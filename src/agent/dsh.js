/**
 * AgentPort 的 DSH 实现
 *
 * 只做三件事：确保会话、发一条 prompt、把该会话的 turn 事件收成文本。
 * 协议细节留在 vendor/dsh-client.js（见 vendor/README.md）。
 */

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
  turnTimeoutMs = 180000,
} = {}) {
  const waiters = new Map(); // sessionId -> { collector, resolve, reject, timer }
  const sessionByKey = new Map();
  let pumpRunning = false;
  let pumpStop = null;

  async function ensureWorkspace() {
    if (!workspacePath) return null;
    const value = api.workspace.create({ path: workspacePath });
    const resolved = value?.then ? await value : value;
    const body = resolved?.result?.ok ? resolved.result.value : resolved;
    return body?.workspace?.workspaceId ?? body?.workspaceId ?? null;
  }

  async function ensureSession(sessionKey, options = {}) {
    if (sessionByKey.has(sessionKey)) return sessionByKey.get(sessionKey);
    const workspaceId = await ensureWorkspace();
    const params = { ...(workspaceId ? { workspaceId } : {}) };
    const wantPreset = options.preset ?? preset;
    if (wantPreset) params.agentPreset = wantPreset;

    const raw = await api.sessions.create(params);
    const body = raw?.result?.ok ? raw.result.value : raw;
    const sessionId = body?.sessionId ?? body?.session?.sessionId ?? null;
    if (!sessionId) throw new Error('DSH 未返回 sessionId');
    sessionByKey.set(sessionKey, sessionId);
    api.events?.follow?.(sessionId);
    logger?.info?.('已创建 DSH 会话', { sessionKey, sessionId, preset: wantPreset ?? null });
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
    try {
      for await (const envelope of api.events.mux({}, controller.signal)) {
        dispatch(envelope?.payload ?? envelope);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        logger?.warn?.('DSH 事件流中断', { reason: error?.message ?? String(error) });
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

    await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: String(message ?? '') }],
    });

    const ended = await result;
    if (ended?.reason?.kind && ended.reason.kind !== 'completed') {
      throw new Error(`回合未正常完成：${ended.reason.kind}`);
    }
    if (ended?.text) yield { type: 'text', text: ended.text };
    yield { type: 'done' };
  }

  return {
    api,
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
  const api = new NodeApiClient(config?.agent?.baseUrl ?? '', undefined, {
    token: config?.agent?.authToken ?? '',
    header: config?.agent?.authHeader,
    prefix: config?.agent?.authPrefix,
    allowRemote: config?.agent?.allowRemote === true,
  });
  return createDshAgent({
    api,
    workspacePath: config?.agent?.sessionCwd ?? null,
    preset: config?.agent?.preset ?? null,
    logger,
  });
}
