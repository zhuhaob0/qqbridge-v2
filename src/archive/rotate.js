/**
 * 会话轮转与归档
 *
 * 理念：QQ 的一条会话不能无限长。达到阈值时——
 *   1. 让模型把旧会话总结成几条要点（一次额外调用）
 *   2. 把旧 DSH 会话归档（从侧边栏移走，文件留在磁盘）
 *   3. 摘要 + sessionId 作为**普通记忆**写进 mnema（会随遗忘曲线淡出）
 *   4. 代次 +1，下一轮用新 sessionId（qqb-p-123-g2）
 *
 * 刻意不做的事：
 * - 不建“归档全文检索索引”：想找回旧会话，必须先被记忆命中（像人一样，忘了就找不到）
 * - 不删除原始文件：只是从界面上移走
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decompress } from 'fzstd';
import { channelIdFor, participantsFor } from '../router/session.js';

/** DSH 会话文件路径（扫描 sessions 目录，按目录名匹配） */
export function sessionFileOf(sessionId, sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  try {
    for (const ws of fs.readdirSync(sessionsRoot)) {
      const wsDir = path.join(sessionsRoot, ws);
      if (!fs.statSync(wsDir).isDirectory()) continue;
      const candidate = path.join(wsDir, sessionId, 'session.v4.jsonl.zstd');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* 忽略 */ }
  return null;
}

export function sessionSizeOf(sessionId) {
  const file = sessionFileOf(sessionId);
  if (!file) return 0;
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** 是否该轮转：消息数或文件大小任一超限 */
export function shouldRotate({ config, sessionKey, sessionId, messageCount }) {
  const cfg = config?.rotate ?? {};
  if (cfg.enabled === false) return null;
  const isGroup = String(sessionKey).startsWith('group:');
  const limit = Number(isGroup ? (cfg.groupMessages ?? 800) : (cfg.privateMessages ?? 1500));
  if (Number(messageCount) >= limit) {
    return { reason: 'messages', detail: `${messageCount} >= ${limit}` };
  }
  const size = sessionSizeOf(sessionId);
  const maxBytes = Number(cfg.maxBytes ?? 8 * 1024 * 1024);
  if (size >= maxBytes) {
    return { reason: 'bytes', detail: `${Math.round(size / 1024 / 1024)}MB >= ${Math.round(maxBytes / 1024 / 1024)}MB` };
  }
  return null;
}

/**
 * 归档一个会话。
 * @param {object} options
 * @param {object} options.agent 需要有 summarize(sessionId, prompt) 和 archiveSession(sessionId)
 */
/** 归档标题：原标题 + 时间范围 */
export function formatArchiveTitle(baseTitle, firstAt, lastAt) {
  const fmt = (iso) => String(iso ?? '').slice(5, 10).replace('-', '-');
  const range = firstAt && lastAt ? `${fmt(firstAt)}~${fmt(lastAt)}` : '';
  const base = String(baseTitle ?? '').trim() || 'QQ 会话';
  return range ? `${base}（归档 ${range}）` : `${base}（归档）`;
}

export async function rotateSession({
  db, q, config, agent, memory, sessionKey, sessionId, generation, logger = null,
}) {
  const summaryPrompt = config?.rotate?.summaryPrompt
    ?? '把上面这段对话总结成不超过 8 条要点：主题、结论、未完成的事。只输出要点，不要寒暄。';

  const file = sessionFileOf(sessionId);
  let sizeBytes = 0;
  if (file) { try { sizeBytes = fs.statSync(file).size; } catch { sizeBytes = 0; } }

  // 摘要用「转录文本 + 临时 standard 会话」：QQ preset 的模型只会用工具说话，直接问它不会回文本
  let summary = '';
  try {
    const { text: transcript } = readTranscript(file, { limit: 120, maxChars: 8000 });
    if (transcript && typeof agent.summarizeWithText === 'function') {
      const label0 = String(sessionKey).startsWith('group:') ? 'QQ 群聊' : 'QQ 私聊';
      summary = String(await agent.summarizeWithText(
        `以下是一段${label0}记录（${sessionKey}）。请按下面的要求输出，不要调用任何工具：\n${summaryPrompt}\n\n===== 记录开始 =====\n${transcript}\n===== 记录结束 =====`,
      ) ?? '').trim();
    }
  } catch (error) {
    logger?.warn?.('归档摘要生成失败，使用占位摘要', { key: sessionKey, reason: error?.message ?? String(error) });
  }
  if (!summary) summary = `（第 ${generation} 代会话，摘要生成失败）`;
  const range = q.messageRange(db, sessionKey);
  const messageCount = q.countMessages(db, sessionKey);
  const archivedAt = new Date().toISOString();

  // 归档前改标题，带上时间范围（侧边栏里能一眼看出是哪一段）
  const archivedTitle = formatArchiveTitle(title, range.firstAt, range.lastAt);
  try {
    if (typeof agent.renameSession === 'function') await agent.renameSession(sessionId, archivedTitle);
  } catch (error) {
    logger?.warn?.('归档标题重命名失败', { key: sessionKey, sessionId, reason: error?.message ?? String(error) });
  }

  // 1) DSH 侧归档（失败也继续：至少本地有记录）
  let archived = false;
  try {
    await agent.archiveSession(sessionId);
    archived = true;
  } catch (error) {
    logger?.warn?.('DSH 归档失败', { sessionKey, sessionId, reason: error?.message ?? String(error) });
  }

  // 2) 本地归档表（只做存储，检索必须经过记忆）
  try {
    q.insertArchive(db, {
      sessionKey, generation, sessionId, summary,
      messageCount, sizeBytes, firstAt: range.firstAt, lastAt: range.lastAt,
      filePath: file, archivedAt,
    });
  } catch (error) {
    logger?.warn?.('归档记录写入失败', { key: sessionKey, reason: error?.message ?? String(error) });
  }

  // 3) 记忆映射：普通事件，走正常衰减/巩固（会忘）
  if (memory) {
    const isGroup = String(sessionKey).startsWith('group:');
    const label = isGroup ? '群聊' : '私聊';
    const text = `[归档] 第${generation}代${label}会话（${sessionKey}，${String(range.firstAt ?? '').slice(0, 10)} ~ ${String(range.lastAt ?? '').slice(0, 10)}，${messageCount} 条，sessionId=${sessionId}）：${summary.replace(/\s+/g, ' ').slice(0, 400)}`;
    try {
      await memory.ingest({
        channel: {
          id: channelIdFor(sessionKey),
          kind: isGroup ? 'group' : 'private',
          participants: participantsFor(sessionKey),
          recordPublic: isGroup,
        },
        events: [{ role: 'assistant', text, at: archivedAt, sensitivity: isGroup ? 'shared' : 'channel' }],
      });
    } catch (error) {
      logger?.warn?.('归档记忆写入失败', { key: sessionKey, reason: error?.message ?? String(error) });
    }
  }

  // 4) 代次 +1
  const nextGeneration = Number(generation) + 1;
  q.setKv(db, `gen:${sessionKey}`, String(nextGeneration));

  logger?.info?.('会话已轮转归档', {
    key: sessionKey, generation, nextGeneration, sessionId,
    messages: messageCount, sizeMB: Math.round(sizeBytes / 1024 / 1024), archived,
  });
  return { generation, nextGeneration, summary, messageCount, sizeBytes, archived, sessionId };
}


/** 单条事件里的纯文本（兼容 data.text 与 data.content 块） */
function extractEventText(ev) {
  const data = ev?.data ?? {};
  if (typeof data.text === 'string' && data.text) return data.text;
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
  if (text) return text;
  if (typeof data.message?.text === 'string') return data.message.text;
  const content = data.message?.content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
  return '';
}

/** 从归档文件里抽取对话正文（user/assistant 文本），可按关键词过滤 */
export function readTranscript(filePath, { keyword = '', limit = 30, maxChars = 3000 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { text: '', matched: 0 };
  let raw;
  try { raw = Buffer.from(decompress(fs.readFileSync(filePath))).toString('utf8'); } catch { return { text: '', matched: 0 }; }
  const lines = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue;
    const text = extractEventText(ev);
    if (!text) continue;
    if (keyword && !text.includes(keyword)) continue;
    lines.push(`${ev.type === 'user/message' ? '用户' : 'AI'}：${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  const picked = lines.slice(0, limit).join('\n');
  return { text: picked.slice(0, maxChars), matched: lines.length };
}


/** 彻底删除一个会话（仅用于摘要用的临时会话；归档会话禁止调用） */
export function removeSessionFiles(sessionId, sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions')) {
  let removed = 0;
  try {
    for (const ws of fs.readdirSync(sessionsRoot)) {
      const dir = path.join(sessionsRoot, ws, sessionId);
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; }
    }
  } catch { /* 忽略 */ }
  try {
    const cache = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', sessionId + '.json');
    if (fs.existsSync(cache)) { fs.unlinkSync(cache); removed += 1; }
  } catch { /* 忽略 */ }
  return removed;
}
