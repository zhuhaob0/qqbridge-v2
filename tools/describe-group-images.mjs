/**
 * 给历史群聊图片补描述：用 DSH agent 真正"看"一次图，再把描述写进记忆。
 *
 * 背景：某张群图发来时会话还在潜水（没有触发回合），模型从没看过它，
 * 记忆里只剩一个 "[图片]"。这里把历史图片重新过一遍模型，补上语义。
 *
 * 用法：
 *   node tools/describe-group-images.mjs            # 处理所有没描述的群图
 *   node tools/describe-group-images.mjs --dry-run  # 只列出要处理的
 */

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createDshAgentFromConfig } from '../src/agent/dsh.js';
import { collectText } from '../src/agent/port.js';
import { createMemoryClient } from '../src/memory/client.js';

const dryRun = process.argv.includes('--dry-run');
const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const db = new DatabaseSync(config.storagePath.replace(/\//g, '\\'));

const rows = db
  .prepare(`SELECT session_key, msg_id, at, media FROM messages
    WHERE session_key LIKE 'group:%' AND has_media = 1 AND direction = 'inbound'
    ORDER BY at`)
  .all();

const targets = [];
for (const row of rows) {
  let media = null;
  try { media = JSON.parse(row.media ?? 'null'); } catch { media = null; }
  const image = (media ?? []).find((m) => m.type === 'image');
  if (!image?.url) continue;
  const gist = String(row.at).slice(0, 16);
  targets.push({ ...row, image, gist });
}

console.log(`待处理群图 ${targets.length} 张`);
if (targets.length === 0) process.exit(0);
if (dryRun) {
  for (const t of targets) console.log(`  ${t.at} ${t.session_key} ${String(t.image.file).slice(0, 24)}`);
  process.exit(0);
}

const logger = {
  info: (msg, extra) => console.log(`[info] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
  warn: (msg, extra) => console.warn(`[warn] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
  error: (msg, extra) => console.error(`[error] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`),
  debug: () => {},
};

const memory = config.memory?.enabled
  ? createMemoryClient({
    baseUrl: config.memory.baseUrl,
    token: config.memory.token,
    tenant: config.memory.tenant,
    timeoutMs: config.memory.timeoutMs,
    shareScope: config.memory.shareScope,
    logger,
  })
  : null;

const agent = await createDshAgentFromConfig(config, { logger });
let done = 0;

for (const t of targets) {
  try {
    const res = await fetch(t.image.url);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('空文件');
    const mime = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : null;
    if (!mime) throw new Error('不是可识别图片');

    const sessionId = await agent.ensureSession(t.session_key, { preset: config.agent?.preset });
    const text = await collectText(agent.send(sessionId, [
      { type: 'text', text: '用两三句话客观描述这张群聊表情包的内容（画面里有什么、可能想表达什么）。只描述，不要评论我。' },
      { type: 'image', mediaType: mime, data: buf.toString('base64'), name: 'group-image' },
    ]));
    const desc = text.trim();
    if (!desc) throw new Error('模型没有返回描述');

    if (memory) {
      const gid = t.session_key.slice('group:'.length);
      await memory.ingest({
        channel: { id: `chat:group:${gid}`, kind: 'public', participants: ['self', `group:${gid}`], recordPublic: true },
        events: [{
          role: 'assistant',
          text: `[群里的图片] ${desc}`.slice(0, 400),
          at: t.at,
          sensitivity: 'shared',
        }],
      });
    }
    done += 1;
    console.log(`✓ ${t.at} → ${desc.slice(0, 40)}…`);
  } catch (error) {
    console.warn(`✗ ${t.at} 失败：${error?.message ?? error}`);
  }
}

console.log(`完成：补了 ${done} 张图的描述`);
