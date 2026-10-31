/**
 * 结构化日志：JSON Lines，按天轮转
 */

import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', dir = '', sink = null, name = 'qqbridge' } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let currentDay = null;

  function dayFile(day) {
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${name}-${day}.jsonl`);
  }

  function ensureStream(day) {
    if (!dir) return null;
    if (stream && currentDay === day) return stream;
    try {
      stream?.end?.();
    } catch {
      /* 忽略 */
    }
    currentDay = day;
    stream = fs.createWriteStream(dayFile(day), { flags: 'a' });
    return stream;
  }

  function emit(levelName, message, fields = {}) {
    if ((LEVELS[levelName] ?? 0) < min) return;
    const record = { at: new Date().toISOString(), level: levelName, msg: String(message ?? ''), ...fields };
    const line = `${JSON.stringify(record)}\n`;
    if (sink) sink(record);
    else process.stdout.write(line);
    if (dir) {
      const day = record.at.slice(0, 10);
      ensureStream(day)?.write(line);
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child(extra = {}) {
      return {
        debug: (m, f) => emit('debug', m, { ...extra, ...f }),
        info: (m, f) => emit('info', m, { ...extra, ...f }),
        warn: (m, f) => emit('warn', m, { ...extra, ...f }),
        error: (m, f) => emit('error', m, { ...extra, ...f }),
      };
    },
    close() {
      try {
        stream?.end?.();
      } catch {
        /* 忽略 */
      }
    },
  };
}

export const LEVEL_NAMES = Object.keys(LEVELS);
