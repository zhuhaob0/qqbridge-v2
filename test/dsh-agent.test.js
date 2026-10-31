import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnCollector } from '../src/agent/collector.js';
import { createDshAgent } from '../src/agent/dsh.js';
import { collectText } from '../src/agent/port.js';

test('收集器：turn 文本由 assistant/message 累加', () => {
  const c = createTurnCollector();
  assert.equal(c.push({ type: 'turn/start', data: { turn: 1 } }), null);
  c.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } } });
  c.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '世界' }] } } });
  const ended = c.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(ended.text, '你好世界');
});

test('收集器：忽略 chunk，避免文本翻倍', () => {
  const c = createTurnCollector();
  c.push({ type: 'turn/start', data: { turn: 1 } });
  c.push({ type: 'assistant/chunk', data: { turn: 1, delta: '你好' } });
  c.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '你好' }] } } });
  const ended = c.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(ended.text, '你好');
});

test('收集器：迟到事件不会建空壳', () => {
  const c = createTurnCollector();
  assert.equal(c.push({ type: 'session/title', data: {} }), null);
  assert.equal(c.size(), 0);
});

test('collectText 拼接文本事件', async () => {
  async function* gen() {
    yield { type: 'text', text: 'a' };
    yield { type: 'text', text: 'b' };
    yield { type: 'done' };
  }
  assert.equal(await collectText(gen()), 'ab');
});

/** 假 DSH api：模拟 mux 事件流与会话创建 */
function makeFakeApi({ reply = '你好', reason = { kind: 'completed' }, hang = false } = {}) {
  const calls = { created: 0, prompts: [], follows: [], workspaces: [] };
  const listeners = [];
  let turn = 0;

  const api = {
    calls,
    workspace: {
      async create({ path }) {
        calls.workspaces.push(path);
        return { result: { ok: true, value: { workspace: { workspaceId: 'ws1' } } } };
      },
    },
    sessions: {
      async create(params) {
        calls.created += 1;
        assert.equal(params.agentPreset, 'qq-chat-v2');
        return { result: { ok: true, value: { sessionId: 's1' } } };
      },
      async prompt({ sessionId, content }) {
        calls.prompts.push({ sessionId, text: content[0].text });
        if (hang) return { result: { ok: true } };
        turn += 1;
        const t = turn;
        queueMicrotask(() => {
          for (const l of listeners) {
            l({ payload: { type: 'session/event', sessionId, event: { type: 'turn/start', data: { turn: t } } } });
            l({ payload: { type: 'session/event', sessionId, event: { type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: reply }] } } } } });
            l({ payload: { type: 'session/event', sessionId, event: { type: 'turn/end', data: { turn: t, reason } } } });
          }
        });
        return { result: { ok: true } };
      },
    },
    events: {
      follow(id) { calls.follows.push(id); },
      async *mux() {
        const queue = [];
        let resolve;
        listeners.push((item) => {
          queue.push(item);
          resolve?.();
        });
        for (;;) {
          if (queue.length === 0) {
            await new Promise((r) => { resolve = r; });
          }
          while (queue.length) yield queue.shift();
        }
      },
    },
  };
  return api;
}

test('DSH AgentPort：确保会话 + 发送 + 收文本', async () => {
  const api = makeFakeApi({ reply: '嘿嘿，来了' });
  const agent = createDshAgent({ api, workspacePath: 'D:/ws', preset: 'qq-chat-v2' });
  const sessionId = await agent.ensureSession('private:1');
  assert.equal(sessionId, 's1');
  assert.equal(api.calls.created, 1);
  assert.deepEqual(api.calls.follows, ['s1']);

  const text = await collectText(agent.send(sessionId, '在吗'));
  assert.equal(text, '嘿嘿，来了');
  assert.equal(api.calls.prompts[0].text, '在吗');

  await agent.close();
});

test('DSH AgentPort：同一会话复用 sessionId', async () => {
  const api = makeFakeApi();
  const agent = createDshAgent({ api, workspacePath: 'D:/ws', preset: 'qq-chat-v2' });
  const a = await agent.ensureSession('private:1');
  const b = await agent.ensureSession('private:1');
  assert.equal(a, b);
  assert.equal(api.calls.created, 1);
  await agent.close();
});

test('DSH AgentPort：回合非正常完成时抛错', async () => {
  const api = makeFakeApi({ reason: { kind: 'aborted' } });
  const agent = createDshAgent({ api, workspacePath: 'D:/ws', preset: 'qq-chat-v2' });
  const sid = await agent.ensureSession('private:1');
  await assert.rejects(() => collectText(agent.send(sid, 'hi')), /未正常完成/);
  await agent.close();
});
