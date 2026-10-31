import { test } from 'node:test';
import assert from 'node:assert/strict';

import { split } from '../src/orchestrator/splitter.js';
import { buildPrompt } from '../src/orchestrator/prompt.js';

test('分条：按句号切分短句', () => {
  const parts = split('今天好累。晚上想吃火锅。你呢？', { threshold: 6 });
  assert.equal(parts.length, 3);
  assert.equal(parts[0], '今天好累。');
});

test('分条：短句合并到阈值', () => {
  const parts = split('好。行。可以。', { threshold: 10 });
  assert.equal(parts.length, 1, '短句应合并成一条');
});

test('分条：长句按逗号切', () => {
  const long = '我最近在考虑要不要换个工作，因为现在这份工作实在太累了，但是又担心跳槽会有风险，所以一直很纠结要不要动';
  const parts = split(long, { threshold: 30 });
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 60), '每段不应过长');
});

test('分条：空输入返回空数组', () => {
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   '), []);
});

test('分条：超过上限时合并尾巴', () => {
  const parts = split('一。二。三。四。五。六。七。八。', { threshold: 2, maxParts: 3 });
  assert.equal(parts.length, 3);
});

test('分条：换行也作为分隔', () => {
  const parts = split('第一行\n第二行', { threshold: 4 });
  assert.equal(parts.length, 2);
});

test('提示词：包含性格、叙事、记忆与规则', () => {
  const prompt = buildPrompt({
    persona: { markdown: '# 性格\n- 嘴上毒心里软' },
    narrative: { markdown: '# 我的状态\n- 最近在帮他找工作' },
    memoryRendered: '【你记得的】\n- 他打算跳槽',
    session: { sessionKey: 'private:1', kind: 'direct', participants: ['self', 'user:1'] },
    recent: [
      { direction: 'inbound', senderName: '小明', text: '在吗' },
      { direction: 'outbound', text: '嗯' },
    ],
  });

  assert.match(prompt, /你的性格/);
  assert.match(prompt, /我的状态/);
  assert.match(prompt, /他打算跳槽/);
  assert.match(prompt, /小明：在吗/);
  assert.match(prompt, /你：嗯/);
  assert.match(prompt, /怎么回/);
  assert.match(prompt, /这是私聊/);
});

test('提示词：群聊时给出不同约束', () => {
  const prompt = buildPrompt({
    session: { kind: 'public' },
    recent: [{ direction: 'inbound', senderName: 'A', text: '你好' }],
  });
  assert.match(prompt, /在群里/);
  assert.match(prompt, /别把私聊里的细节带出来/);
});

test('提示词：没有记忆时不留空段', () => {
  const prompt = buildPrompt({ session: { kind: 'direct' }, recent: [] });
  assert.doesNotMatch(prompt, /你记得的/);
  assert.match(prompt, /本轮对话/);
});
