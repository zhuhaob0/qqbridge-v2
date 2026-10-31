/**
 * AgentPort：与 agent 宿主的边界（DSH 或测试用假宿主）
 *
 * interface AgentPort {
 *   ensureSession(sessionKey, options): Promise<sessionId>
 *   send(sessionId, message): AsyncIterable<AgentEvent>
 *   close(sessionId): Promise<void>
 * }
 *
 * AgentEvent:
 *   { type: 'text', text } | { type: 'tool', name, args } | { type: 'done' } | { type: 'error', error }
 */

export function assertAgentPort(agent) {
  const required = ['ensureSession', 'send'];
  for (const method of required) {
    if (typeof agent?.[method] !== 'function') {
      throw new TypeError(`AgentPort 缺少方法：${method}`);
    }
  }
  return agent;
}

/** 从事件流里收集纯文本 */
export async function collectText(stream) {
  const chunks = [];
  for await (const event of stream) {
    if (event?.type === 'text' && event.text) chunks.push(String(event.text));
    else if (event?.type === 'error') throw new Error(event.error?.message ?? String(event.error));
  }
  return chunks.join('');
}
