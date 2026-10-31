/**
 * 单实例锁
 */

import fs from 'node:fs';
import path from 'node:path';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{ ok: boolean, reason?: string, release: () => void }}
 */
export function acquireLock(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      const pid = Number(raw.split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
        return { ok: false, reason: `已有实例在运行（pid ${pid}）`, release() {} };
      }
    }
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
    return {
      ok: true,
      release() {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          /* 忽略 */
        }
      },
    };
  } catch (error) {
    return { ok: false, reason: `无法创建锁文件：${error?.message ?? error}`, release() {} };
  }
}
