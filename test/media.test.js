import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pruneMedia } from '../src/storage/media.js';

test('媒体缓存：超过保留期的文件被删，未超期的保留', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-media-'));
  const old = path.join(dir, 'old.jpg');
  const fresh = path.join(dir, 'fresh.jpg');
  fs.writeFileSync(old, Buffer.alloc(1024, 1));
  fs.writeFileSync(fresh, Buffer.alloc(2048, 1));

  const now = Date.now();
  const oldTime = new Date(now - 31 * 86400000);
  fs.utimesSync(old, oldTime, oldTime);

  const result = pruneMedia({ dir, days: 30, now });

  assert.equal(result.removed, 1, '应删掉 31 天前的那张');
  assert.equal(result.kept, 1, '30 天内的应保留');
  assert.equal(result.bytes, 1024, '应统计释放的字节数');
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('媒体缓存：目录不存在时安全返回', () => {
  const result = pruneMedia({ dir: path.join(os.tmpdir(), 'qqb-media-not-exist-' + Date.now()) });
  assert.equal(result.removed, 0);
  assert.equal(result.kept, 0);
});
