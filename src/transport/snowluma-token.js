/**
 * SnowLuma token 发现
 *
 * 实测：SnowLuma 的 onebot 配置里，HTTP(3000) 与 WebSocket(3001) 是**两个不同的**
 * accessToken。旧桥接的 config.json 里存的是 HTTP token，直接拿去连 WS 会被拒
 * （表现为 "SnowLuma WebSocket closed before opening"）。
 *
 * 这里按 selfQQ 读 <home>/config/onebot_<uin>.json，取 wsServers[0].accessToken。
 * 找不到就回退到配置里给的值。
 */

import fs from 'node:fs';
import path from 'node:path';

export function readOneBotCredentials(homeDir, uin) {
  if (!homeDir || !uin) return null;
  const file = path.join(homeDir, 'config', `onebot_${uin}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);
    const ws = json?.networks?.wsServers?.[0] ?? null;
    const http = json?.networks?.httpServers?.[0] ?? null;
    return {
      file,
      ws: ws ? { token: String(ws.accessToken ?? ''), host: ws.host || '127.0.0.1', port: Number(ws.port) || 3001 } : null,
      http: http ? { token: String(http.accessToken ?? ''), host: http.host || '127.0.0.1', port: Number(http.port) || 3000 } : null,
    };
  } catch {
    return null;
  }
}

/**
 * @returns {{ token: string, source: 'ws-config'|'configured'|'none', file?: string }}
 */
export function resolveWsToken({ homeDir, selfQQ, configured = '', logger = null } = {}) {
  const creds = readOneBotCredentials(homeDir, selfQQ);
  if (creds?.ws?.token) {
    if (configured && configured !== creds.ws.token) {
      logger?.info?.('检测到 WS 与配置里的 token 不一致，使用 SnowLuma 配置中的 WS token', { file: creds.file });
    }
    return { token: creds.ws.token, source: 'ws-config', file: creds.file };
  }
  if (configured) return { token: configured, source: 'configured' };
  return { token: '', source: 'none' };
}
