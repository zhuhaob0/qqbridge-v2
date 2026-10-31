import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, loadConfig, requireConfig, validateConfig, ConfigError, deepMerge } from '../src/config.js';

const base = () => ({ qq: { ownerQQ: 100, selfQQ: 200 } });

test('默认值合并且不覆盖用户值', () => {
  const { config } = loadConfig(base());
  assert.equal(config.qq.ownerQQ, 100);
  assert.equal(config.memory.timeoutMs, DEFAULTS.memory.timeoutMs);
  assert.equal(config.send.maxPerMinute, 10);
});

test('深层合并保留未覆盖的嵌套字段', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } });
  assert.equal(merged.a.b, 1);
  assert.equal(merged.a.c, 3);
});

test('ownerQQ 缺失报错', () => {
  const { errors } = validateConfig({ ...DEFAULTS });
  assert.ok(errors.some((e) => e.includes('ownerQQ')));
});

test('ownerQQ 与 selfQQ 相同报错', () => {
  const { errors } = validateConfig({ ...DEFAULTS, qq: { ownerQQ: 1, selfQQ: 1 } });
  assert.ok(errors.some((e) => e.includes('不能相同')));
});

test('群白名单为空时必须显式声明语义', () => {
  const bad = { ...DEFAULTS, qq: { ownerQQ: 1, selfQQ: 2 }, allow: { private: [], groups: [], emptyGroupsMeansAll: undefined } };
  const { errors } = validateConfig(bad);
  assert.ok(errors.some((e) => e.includes('emptyGroupsMeansAll')));
});

test('memory.baseUrl 非法时报错', () => {
  const bad = { ...DEFAULTS, qq: { ownerQQ: 1, selfQQ: 2 }, memory: { ...DEFAULTS.memory, baseUrl: 'not-a-url' } };
  const { errors } = validateConfig(bad);
  assert.ok(errors.some((e) => e.includes('baseUrl')));
});

test('发送间隔颠倒时报错', () => {
  const bad = { ...DEFAULTS, qq: { ownerQQ: 1, selfQQ: 2 }, send: { ...DEFAULTS.send, minGapMs: 2000, maxGapMs: 100 } };
  const { errors } = validateConfig(bad);
  assert.ok(errors.some((e) => e.includes('minGapMs')));
});

test('未知顶层字段给警告而非错误', () => {
  const { errors, warnings } = validateConfig({ ...DEFAULTS, qq: { ownerQQ: 1, selfQQ: 2 }, wat: 1 });
  assert.equal(errors.length, 0);
  assert.ok(warnings.some((w) => w.includes('wat')));
});

test('requireConfig 在非法时抛 ConfigError', () => {
  assert.throws(() => requireConfig({}), ConfigError);
});

test('语音 provider 校验', () => {
  const bad = { ...DEFAULTS, qq: { ownerQQ: 1, selfQQ: 2 }, speech: { ...DEFAULTS.speech, provider: 'nope' } };
  const { errors } = validateConfig(bad);
  assert.ok(errors.some((e) => e.includes('speech.provider')));
});
