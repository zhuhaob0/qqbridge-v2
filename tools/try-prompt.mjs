#!/usr/bin/env node
/**
 * 真实 AgentPort 往返测试：创建 DSH 会话 → 发一条 prompt → 打印回复
 *
 *   node tools/try-prompt.mjs --url http://127.0.0.1:61337 --prompt "你好"
 *
 * 不连接 SnowLuma、不发 QQ 消息，只验证 agent 链路。
 */

import { createDshAgent } from '../src/agent/dsh.js';

function parseArgs(argv) {
  const out = { prompt: '用一句话介绍你自己。', url: 'http://127.0.0.1:61337', preset: null, timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--preset') out.preset = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const { NodeApiClient } = await import('../vendor/dsh-client.js');
const api = new NodeApiClient(args.url, undefined, {});
const agent = createDshAgent({
  api,
  workspacePath: args.cwd ?? null,
  preset: args.preset,
  logger: { info() {}, warn: (m, f) => console.warn('[warn]', m, f ?? ''), error() {}, debug() {} },
  turnTimeoutMs: args.timeoutMs,
});

const started = Date.now();
const sessionId = await agent.ensureSession('try-prompt');
console.log(`会话已创建：${sessionId}（${Date.now() - started}ms）`);

let text = '';
for await (const event of agent.send(sessionId, args.prompt)) {
  if (event.type === 'text') text += event.text;
}
console.log(`\n回复（${Date.now() - started}ms）：\n${text || '(空)'}`);

await agent.close();
process.exit(0);
