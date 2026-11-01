/**
 * DSH 端口发现
 *
 * DSH 每次启动端口都随机；写死在配置里的 baseUrl 迟早过期（表现：agent 调用 fetch failed）。
 * 解析顺序：
 *   1. 环境变量 DSH_BASE_URL（守护插件启动时注入，最可靠）
 *   2. state/dsh-port.json（守护插件写入）
 *   3. state/launcher/plugin.log 里最后一条「宿主端口判定为 N」
 *   4. 配置里的 agent.baseUrl
 */

import fs from 'node:fs';
import path from 'node:path';

export function resolveDshBase({ env = process.env, dir = '.', fallback = '' } = {}) {
  // state/dsh-port.json 优先：守护插件每次判定宿主端口都会刷新它，
  // 而 DSH_BASE_URL 是进程启动时注入的，DSH 重启后就会过期（表现：401 / fetch failed）。
  const portFile = path.join(dir, 'state', 'dsh-port.json');
  try {
    const raw = fs.readFileSync(portFile, 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    if (json?.baseUrl) return { baseUrl: json.baseUrl, source: 'dsh-port.json' };
    if (json?.port) return { baseUrl: `http://127.0.0.1:${json.port}`, source: 'dsh-port.json' };
  } catch { /* 忽略 */ }

  const fromEnv = env.DSH_BASE_URL;
  if (fromEnv) return { baseUrl: fromEnv, source: 'env' };

  const logFile = path.join(dir, 'state', 'launcher', 'plugin.log');
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const matches = [...text.matchAll(/宿主端口判定为\s*(\d+)/g)];
    const last = matches.at(-1);
    if (last) return { baseUrl: `http://127.0.0.1:${last[1]}`, source: 'plugin.log' };
  } catch { /* 忽略 */ }

  return fallback ? { baseUrl: fallback, source: 'config' } : { baseUrl: '', source: 'none' };
}
