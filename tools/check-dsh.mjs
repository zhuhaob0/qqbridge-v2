#!/usr/bin/env node
/**
 * DSH 连通性检查（只读）：确认凭据发现与 RPC 调用都能走通
 *
 *   node tools/check-dsh.mjs [baseUrl]
 *
 * 只调用 session/modelCatalog 这类只读 RPC，不创建会话、不发 prompt。
 */

const baseUrl = process.argv[2] ?? process.env.DSH_URL ?? 'http://127.0.0.1:3080';

const { NodeApiClient } = await import('../vendor/dsh-client.js');
const api = new NodeApiClient(baseUrl, undefined, {});

try {
  const catalog = await api.callUnary('session.modelCatalog', {});
  const models = catalog?.value?.models ?? catalog?.models ?? catalog;
  console.log(`✓ DSH 可达：${baseUrl}`);
  console.log(`  session/modelCatalog → ${JSON.stringify(models).slice(0, 200)}`);
  process.exit(0);
} catch (error) {
  console.log(`✗ DSH 不可用：${baseUrl}`);
  console.log(`  ${error?.message ?? error}`);
  process.exit(1);
}
