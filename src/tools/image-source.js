/**
 * 把一个「网页地址」解析成可直接发送的图片
 *
 * 模型经常只能拿到页面链接（搜索结果、文章），而不是图片直链。
 * 这里按优先级抽：og:image → twitter:image → link[rel=image_src] → 正文第一张 <img>，
 * 然后下载字节，交给桥接以 base64 发送（不依赖外链长期有效）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function absolute(base, value) {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

/** 从 HTML 里按优先级抽候选图片地址 */
export function extractImageCandidates(html, pageUrl) {
  const out = [];
  const push = (value) => {
    const url = value ? absolute(pageUrl, String(value).trim()) : null;
    if (url && !out.includes(url)) out.push(url);
  };
  const meta = (attr, key) => {
    const re = new RegExp(`<meta[^>]+${attr}=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*${attr}=["']${key}["']`, 'i');
    const m = re.exec(html) ?? re2.exec(html);
    if (m) push(m[1]);
  };

  meta('property', 'og:image');
  meta('property', 'og:image:secure_url');
  meta('name', 'twitter:image');
  const link = /<link[^>]+rel=["']image_src["'][^>]*href=["']([^"']+)["']/i.exec(html);
  if (link) push(link[1]);

  // 正文图片：优先 data-src / srcset（懒加载），再退回 src
  const imgRe = /<img\b[^>]*>/gi;
  let match;
  let count = 0;
  while ((match = imgRe.exec(html)) && count < 8) {
    const tag = match[0];
    const dataSrc = /data-src=["']([^"']+)["']/i.exec(tag) ?? /data-original=["']([^"']+)["']/i.exec(tag);
    if (dataSrc) push(dataSrc[1]);
    const srcset = /srcset=["']([^"']+)["']/i.exec(tag);
    if (srcset) push(srcset[1].split(',')[0].trim().split(/\s+/)[0]);
    const src = /src=["']([^"']+)["']/i.exec(tag);
    if (src) push(src[1]);
    count += 1;
  }
  // 过滤明显的非图片资源
  return out.filter((url) => !/\.(svg|ico|gifv)(\?|$)/i.test(url));
}

async function fetchBuffer(url, { timeoutMs, maxBytes, accept }) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, accept },
  });
  if (!res.ok) return null;
  const type = String(res.headers.get('content-type') ?? '').toLowerCase();
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > maxBytes) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > maxBytes) return null;
  return { buffer, contentType: type };
}

function sniff(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (buffer.slice(0, 4).toString() === 'RIFF') return 'image/webp';
  return null;
}

/**
 * @param {string} url 图片直链或网页地址
 * @param {{timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{buffer: Buffer, mimeType: string, source: string}>}
 */
export async function resolveImageSource(url, { timeoutMs = 12000, maxBytes = 3 * 1024 * 1024 } = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('只接受 http(s) 地址');

  // ① 当直链试一次
  const direct = await fetchBuffer(target, { timeoutMs, maxBytes, accept: 'image/*' }).catch(() => null);
  if (direct) {
    const mimeType = sniff(direct.buffer) ?? (direct.contentType.startsWith('image/') ? direct.contentType.split(';')[0] : null);
    if (mimeType) return { buffer: direct.buffer, mimeType, source: 'direct' };
  }

  // ② 当网页处理：抽候选图
  const page = await fetch(target, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
  }).catch(() => null);
  if (!page || !page.ok) throw new Error(`打不开这个地址（HTTP ${page?.status ?? '无响应'}）`);
  const html = (await page.text()).slice(0, 1_500_000);
  const candidates = extractImageCandidates(html, target);
  if (candidates.length === 0) throw new Error('页面里没有找到可用图片');

  for (const candidate of candidates.slice(0, 6)) {
    const got = await fetchBuffer(candidate, { timeoutMs, maxBytes, accept: 'image/*' }).catch(() => null);
    if (!got) continue;
    const mimeType = sniff(got.buffer) ?? (got.contentType.startsWith('image/') ? got.contentType.split(';')[0] : null);
    if (mimeType) return { buffer: got.buffer, mimeType, source: candidate };
  }
  throw new Error('找到候选图但都下载失败（可能是防盗链或链接失效）');
}
