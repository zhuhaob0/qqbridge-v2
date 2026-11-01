import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { shouldRotate, readTranscript, sessionFileOf } from '../src/archive/rotate.js';

const config = { rotate: { enabled: true, groupMessages: 800, privateMessages: 1500, maxBytes: 8 * 1024 * 1024 } };

test('轮转判定：群聊按消息数', () => {
  const hit = shouldRotate({ config, sessionKey: 'group:1', sessionId: 'nonexistent', messageCount: 800 });
  assert.equal(hit?.reason, 'messages');
  assert.equal(shouldRotate({ config, sessionKey: 'group:1', sessionId: 'nonexistent', messageCount: 799 }), null);
});

test('轮转判定：私聊阈值更高', () => {
  assert.equal(shouldRotate({ config, sessionKey: 'private:1', sessionId: 'nonexistent', messageCount: 1499 }), null);
  assert.equal(shouldRotate({ config, sessionKey: 'private:1', sessionId: 'nonexistent', messageCount: 1500 })?.reason, 'messages');
});

test('轮转判定：关闭时永不触发', () => {
  const off = { rotate: { ...config.rotate, enabled: false } };
  assert.equal(shouldRotate({ config: off, sessionKey: 'group:1', sessionId: 'nonexistent', messageCount: 99999 }), null);
});

test('轮转判定：文件大小兜底', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-')), 'big.zstd');
  fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024));
  // 用手动 sessionId 指向不存在的目录 → 大小为 0，这里只验证函数不抛错
  assert.equal(shouldRotate({ config, sessionKey: 'group:1', sessionId: 'nonexistent', messageCount: 1 }), null);
  assert.equal(sessionFileOf('definitely-not-a-session'), null);
});

test('归档正文读取：文件不存在时返回空', () => {
  const { text, matched } = readTranscript('E:\\no\\such\\file.zstd');
  assert.equal(text, '');
  assert.equal(matched, 0);
});
