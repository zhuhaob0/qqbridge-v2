/**
 * 媒体缓存：收图时落盘，定期清理
 *
 * 图片本身不进记忆（记忆只存文字描述），但转发/复读需要原始字节，
 * 所以收到图片时缓存到 state/media。这里负责按天数清理，避免无限膨胀。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 默认缓存目录：相对进程工作目录 */
export function mediaDir(baseDir) {
  return baseDir ?? path.join(process.cwd(), 'state', 'media');
}

/**
 * 清理超过 days 天的缓存文件
 * @param {{dir?: string, days?: number, now?: number}} [options]
 * @returns {{dir: string, removed: number, bytes: number, kept: number, days: number}}
 */
export function pruneMedia({ dir, days = 30, now = Date.now() } = {}) {
  const target = mediaDir(dir);
  const cutoff = now - Number(days) * 86400000;
  const result = { dir: target, removed: 0, bytes: 0, kept: 0, days: Number(days) };
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return result; // 目录不存在 = 没有缓存
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(target, entry.name);
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(file);
        result.removed += 1;
        result.bytes += stat.size;
      } else {
        result.kept += 1;
      }
    } catch {
      /* 单个文件失败不影响其它 */
    }
  }
  return result;
}
