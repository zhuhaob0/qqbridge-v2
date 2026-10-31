#!/usr/bin/env node
/**
 * 全链路仿真：真实 DSH + 真实 mnema + 假 QQ（不连 SnowLuma、不发真消息）
 *
 *   node tools/simulate.mjs --dsh http://127.0.0.1:61337 --memory http://127.0.0.1:8321 \
 *     --text "你好，我是小明"
 *
 * 流程：造一条入站消息 → router → wake → orchestrator → DSH 回复 → 分条 → 假 QQ → 写记忆 → 检索验证
 */

import { openDatabase } from '../src/storage/db.js';
import * as q from '../src/storage/queries.js';
import { createApp } from '../src/app.js';
import { createFakeQq } from '../src/qq/fake.js';
import { createMemoryClient } from '../src/memory/client.js';
import { createDshAgent } from '../src/agent/dsh.js';

function parseArgs(argv) {
  const out = { dsh: 'http://127.0.0.1:61337', memory: 'http://127.0.0.1:8321', text: '你好，我是小明', waitMs: 15000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dsh') out.dsh = argv[++i];
    else if (a === '--memory') out.memory = argv[++i];
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--wait') out.waitMs = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const config = {
  qq: { ownerQQ: 100, selfQQ: 200, botNames: ['小鲸鱼'] },
  allow: { private: [1], groups: [], emptyGroupsMeansAll: false },
  wake: { batchWindowMs: 20, triggers: { at: true, name: true, question: true, probability: 0 } },
  send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 10, splitThreshold: 40 },
  memory: { enabled: true, baseUrl: args.memory, tenant: 'sim', timeoutMs: 2000 },
  agent: { preset: null },
  console: { token: '' },
};

const db = openDatabase(':memory:');
const qq = createFakeQq();
const memory = createMemoryClient({ baseUrl: args.memory, tenant: 'sim', timeoutMs: 2000, logger: console });

const { NodeApiClient } = await import('../vendor/dsh-client.js');
const api = new NodeApiClient(args.dsh, undefined, {});
const agent = createDshAgent({
  api,
  logger: { info() {}, warn: (m, f) => console.warn('[warn]', m, f ?? ''), error() {}, debug() {} },
});

const logger = { debug: () => {}, info: (m, f) => console.log('[info]', m, f ?? ''), warn: (m, f) => console.warn('[warn]', m, f ?? ''), error: (m, f) => console.error('[error]', m, f ?? '') };
const app = createApp({ db, config, agent, qq, memory, logger });

// 先写一条记忆（用 import 绕过门控，专门验证检索通路）
await memory.ingestBatch({
  events: [{
    text: '我特别喜欢吃火锅，尤其是牛油锅底',
    participants: ['self', 'user:1'],
    contentClass: 'preference',
    sensitivity: 'contact',
    at: new Date().toISOString(),
  }],
});

const started = Date.now();
const handled = app.router.handle({
  post_type: 'message',
  message_type: 'private',
  user_id: 1,
  message_id: 9001,
  time: Math.floor(Date.now() / 1000),
  message: [{ type: 'text', data: { text: args.text } }],
  sender: { user_id: 1, nickname: '小明' },
});
console.log('router:', JSON.stringify({ accepted: handled.accepted, reason: handled.reason }));

await new Promise((r) => setTimeout(r, args.waitMs));

console.log(`\n=== 结果（${Date.now() - started}ms）===`);
console.log(`假 QQ 收到 ${qq.sent.length} 条：`);
for (const m of qq.sent) console.log(`  - ${m.text}`);

const recalled = await memory.recall({
  channelId: 'chat:user:1',
  participants: ['self', 'user:1'],
  query: '火锅',
});
console.log('\n记忆检索：');
console.log(recalled?.rendered ?? '(无)');

await agent.close();
db.close();
process.exit(0);
