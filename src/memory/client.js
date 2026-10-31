/**
 * 记忆客户端（mnema HTTP）：超时 + 熔断 + 降级
 *
 * 约定：任何失败都不抛给调用方，返回 null 表示"这次没有记忆"。
 */

export function createMemoryClient({
  baseUrl,
  token = '',
  tenant = 'default',
  timeoutMs = 800,
  failureThreshold = 3,
  openMs = 60000,
  logger = null,
  fetchImpl = fetch,
  clock = () => Date.now(),
} = {}) {
  let consecutiveFailures = 0;
  let openUntil = 0;

  function circuitOpen() {
    return openUntil > clock();
  }

  async function request(method, path, body) {
    if (circuitOpen()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`memory HTTP ${res.status}`);
      consecutiveFailures = 0;
      return await res.json();
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) {
        openUntil = clock() + openMs;
        logger?.warn?.('记忆服务熔断', { reason: error?.message ?? String(error) });
      } else {
        logger?.warn?.('记忆调用失败（降级）', { path, reason: error?.message ?? String(error) });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const call = (path, body) => request('POST', path, body);

  return {
    get degraded() {
      return circuitOpen();
    },

    async get(path) {
      return request('GET', path);
    },

    async recall({ channelId, participants, query, maxItems }) {
      const res = await call('/v1/recall', { tenant, channelId, participants, query, budget: maxItems ? { maxItems } : undefined });
      return res ? { rendered: res.rendered, items: res.items ?? [] } : null;
    },

    async ingest({ channel, events }) {
      return call('/v1/events', { tenant, channel, events });
    },

    async persona(tenantOverride) {
      const t = encodeURIComponent(tenantOverride ?? tenant);
      const res = await request('GET', `/v1/persona?tenant=${t}`);
      return res?.persona ?? null;
    },

    async setPersona({ markdown, traits }) {
      return request('PUT', '/v1/persona', { tenant, markdown, traits });
    },

    /** 批量导入（迁移用） */
    async ingestBatch({ events = [], facts = [], interactions = [] } = {}) {
      return call('/v1/import', { tenant, events, facts, interactions });
    },

    async narrative(tenantOverride) {
      const t = encodeURIComponent(tenantOverride ?? tenant);
      const res = await request('GET', `/v1/narrative?tenant=${t}`);
      return res?.narrative ?? null;
    },

    async consolidate() {
      return call('/v1/consolidate', { tenant });
    },

    async feedback({ op, memoryId, text }) {
      return call('/v1/feedback', { tenant, op, memoryId, text });
    },

    async health() {
      try {
        const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/v1/health`, { method: 'GET' });
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    },
  };
}
