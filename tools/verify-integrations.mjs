#!/usr/bin/env node
/**
 * 集成体检：真实依赖装好之后，逐项确认我们调用的 API 存在
 *
 *   node tools/verify-integrations.mjs
 *
 * 退出码 0 = 全部通过；1 = 有缺失项
 */

const checks = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) });
  }
}

// 1) SnowLuma SDK
let sdk = null;
await check('@snowluma/sdk 可加载', async () => {
  sdk = await import('@snowluma/sdk');
  return Object.keys(sdk).filter((k) => /Client|text|image|record|chain/.test(k)).slice(0, 8);
});

if (sdk) {
  await check('导出 SnowLumaWebSocketClient', () => {
    if (typeof sdk.SnowLumaWebSocketClient !== 'function') throw new Error('不是构造函数');
    return 'function';
  });

  await check('导出消息构造器 text/image/record', () => {
    const missing = ['text', 'image', 'record'].filter((k) => typeof sdk[k] !== 'function');
    if (missing.length) throw new Error(`缺少：${missing.join(', ')}`);
    return { text: 'ok', image: 'ok', record: 'ok' };
  });

  await check('客户端具备我们调用的方法', () => {
    const client = new sdk.SnowLumaWebSocketClient({
      url: 'ws://127.0.0.1:1', accessToken: undefined, reconnect: false,
    });
    const methods = [
      'onPrivateMessage', 'onGroupMessage', 'onNotice', 'onEvent',
      'sendPrivateMessage', 'sendGroupMessage',
      'getMessage', 'getGroupMemberList', 'sendPoke', 'getForwardMessage',
      'getGroupMessageHistory', 'getFriendMessageHistory',
    ];
    const missing = methods.filter((m) => typeof client[m] !== 'function');
    if (missing.length) throw new Error(`缺少方法：${missing.join(', ')}`);
    return { count: methods.length };
  });
}

// 2) DSH 客户端（vendor）
let dsh = null;
await check('vendor/dsh-client.js 可加载', async () => {
  dsh = await import('../vendor/dsh-client.js');
  return ['NodeApiClient', 'createTurnCollector', 'unwrap'].filter((k) => typeof dsh[k] === 'function');
});

if (dsh) {
  await check('NodeApiClient 关键方法', () => {
    const proto = dsh.NodeApiClient.prototype;
    const missing = ['callUnary', 'ensureAuth', 'openRemoteEventStream'].filter((m) => typeof proto[m] !== 'function');
    if (missing.length) throw new Error(`缺少：${missing.join(', ')}`);
    return { methods: 3 };
  });
}

// 3) 本地模块
await check('工具注册表 26 个', async () => {
  const { createToolRegistry } = await import('../src/tools/index.js');
  const registry = createToolRegistry();
  if (registry.size() !== 26) throw new Error(`实际 ${registry.size()}`);
  return { tools: 26 };
});

for (const c of checks) {
  const mark = c.ok ? '✓' : '✗';
  console.log(`${mark} ${c.name}${c.ok ? ` → ${JSON.stringify(c.detail)}` : ` → ${c.error}`}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过');
process.exit(failed.length ? 1 : 0);
