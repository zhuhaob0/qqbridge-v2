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

  async function ensureWorkspace() {
    if (!workspacePath) return null;
    // 相对路径会按 DSH 进程的 cwd 解析（不是桥接的 cwd），所以这里先转绝对路径
    const absolute = path.resolve(workspacePath);
    const params = { path: absolute };
    if (workspaceTitle) params.title = workspaceTitle;
    const value = api.workspace.create(params);
    const resolved = value?.then ? await value : value;
    const body = resolved?.result?.ok ? resolved.result.value : resolved;
    const workspaceId = body?.workspace?.workspaceId ?? body?.workspaceId ?? null;
    if (!workspaceId) logger?.warn?.('创建工作区失败，会话会落到默认工作区', { path: absolute, error: JSON.stringify(resolved?.result?.error ?? {}).slice(0, 200) });
    return workspaceId;
  }

  async function ensureSession(sessionKey, options = {}) {
    if (sessionByKey.has(sessionKey)) return sessionByKey.get(sessionKey);
    const workspaceId = await ensureWorkspace();
    const params = { ...(workspaceId ? { workspaceId } : {}) };
    const wantPreset = options.preset ?? preset;
    if (wantPreset) params.agentPreset = wantPreset;

    const selfKey = selfKeyFor(sessionKey);
    if (selfKey) params.sessionId = selfKey;

    let raw = await api.sessions.create(params);
    let body = raw?.result?.ok ? raw.result.value : raw;
    // 会话已存在（例如上次没清理干净）：直接复用同一个 id
    if (!body?.sessionId && selfKey) {
      const message = JSON.stringify(raw?.result?.error ?? raw);
      if (/exist|duplicate|already/i.test(message)) {
        body = { sessionId: selfKey };
        logger?.info?.('复用已存在的 DSH 会话', { sessionKey, sessionId: selfKey });
      } else {
        logger?.warn?.('创建 DSH 会话失败', { sessionKey, error: message.slice(0, 200) });
      }
    }
    const sessionId = body?.sessionId ?? null;
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
