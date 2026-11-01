import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { extractImageCandidates, resolveImageSource } from '../src/tools/image-source.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('图片解析：og:image 优先，相对路径补全为绝对地址', () => {
  const html = `<html><head>
    <meta property="og:image" content="/cover.png">
    <img src="body.jpg">
  </head></html>`;
  const list = extractImageCandidates(html, 'https://example.com/post/1');
  assert.equal(list[0], 'https://example.com/cover.png');
  assert.ok(list.some((url) => url.endsWith('body.jpg')), '正文图应被补全为绝对地址');
});

test('图片解析：没有 og:image 时退回正文第一张图（含懒加载 data-src）', () => {
  const html = `<p><img data-src="//cdn.example.com/a.webp" src="placeholder.gif"></p>`;
  const list = extractImageCandidates(html, 'https://example.com/p');
  assert.ok(list.includes('https://cdn.example.com/a.webp'));
});

test('图片解析：网页地址自动提取主图并下载字节', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/img.png') {
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><head><meta property="og:image" content="/img.png"></head></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const got = await resolveImageSource(`http://127.0.0.1:${port}/article`);
    assert.equal(got.mimeType, 'image/png');
    assert.ok(got.buffer.length > 0);
    assert.notEqual(got.source, 'direct');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('图片解析：直链直接下载，不再请求页面', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'image/png');
    res.end(PNG);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const got = await resolveImageSource(`http://127.0.0.1:${port}/x.png`);
    assert.equal(got.source, 'direct');
    assert.equal(got.mimeType, 'image/png');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('图片解析：页面里没有图片时报明确错误', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>没有图片</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(() => resolveImageSource(`http://127.0.0.1:${port}/empty`), /没有找到可用图片/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
