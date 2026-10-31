/**
 * v1 → v2 迁移
 *
 * 只读 v1 的数据，写入 v2 的 SQLite 与 mnema；不修改 v1。
 * memory 客户端可注入（测试时用假实现）。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as q from '../storage/queries.js';
import { parseSessionKey, participantsFor, channelIdFor } from '../router/session.js';

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** v1 config.json → v2 config 片段 */
export function mapConfig(v1Config = {}) {
  return {
    qq: {
      ownerQQ: Number(v1Config.ownerQQ ?? 0),
      selfQQ: Number(v1Config.snowluma?.selfQQ ?? v1Config.selfQQ ?? 0),
      snowluma: {
        url: v1Config.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001',
        token: v1Config.snowluma?.accessToken ?? '',
      },
      botNames: v1Config.botNames ?? [],
    },
    allow: {
      private: (v1Config.allow?.private ?? []).map(String).map(Number),
      groups: (v1Config.allow?.groups ?? []).map(String).map(Number),
      emptyGroupsMeansAll: v1Config.allowAllWhenEmpty ?? true,
    },
    console: {
      port: Number(v1Config.consolePort ?? 3100),
      token: v1Config.consoleToken ?? '',
    },
    agent: {
      preset: v1Config.agentPreset ?? 'qq-chat-v2',
      sessionCwd: v1Config.sessionCwd ?? './sessions',
    },
    send: {
      minGapMs: Number(v1Config.sendDelayMs ?? 600),
      maxGapMs: Math.max(Number(v1Config.sendDelayMs ?? 600) * 3, 1800),
      maxPerMinute: 10,
      splitThreshold: 60,
    },
    speech: { provider: 'none' },
  };
}

/**
 * @param {object} options
 * @param {string} options.v1Dir
 * @param {object} options.db
 * @param {object} [options.memory]  需有 ingest/persona 方法
 * @param {boolean} [options.dryRun]
 */
export async function migrateV1({ v1Dir, db, memory = null, dryRun = false, logger = null } = {}) {
  const state = path.join(v1Dir, 'state');
  const report = {
    sessions: 0, messages: 0, interactions: 0, events: 0, facts: 0,
    stickers: 0, slang: 0, persona: false, dryRun,
  };

  const sessionsFile = readJson(path.join(state, 'sessions.json'), {}) ?? {};
  const social = readJson(path.join(state, 'social-v2.json'), {}) ?? {};
  const conversations = social.conversations ?? {};
  const shared = readJson(path.join(state, 'shared-memory.json'), {}) ?? {};
  const stickers = readJson(path.join(state, 'stickers.json'), []) ?? [];
  const slang = readJson(path.join(state, 'slang.json'), []) ?? [];

  // 1) 会话
  for (const [key, agentSession] of Object.entries(sessionsFile.sessions ?? {})) {
    const parsed = parseSessionKey(key);
    if (!parsed) continue;
    const conv = conversations[key] ?? {};
    const participants = participantsFor(key, { selfId: 'self' });
    if (!dryRun) {
      q.upsertSession(db, {
        sessionKey: key,
        kind: parsed.kind,
        participants,
        agentSession: agentSession ?? null,
        wakeState: conv.wakeConfig ? { mode: 'diving', triggers: conv.wakeConfig } : {},
        lastEventAt: conv.lastIncomingAt ?? null,
        createdAt: new Date().toISOString(),
      });
      q.ensureAgentToken(db, key);
    }
    report.sessions += 1;
  }

  // 2) 最近消息（保留上下文） + 3) 交互流（关系度）
  const memoryEvents = [];
  const memoryFacts = [];
  const interactions = [];

  for (const [key, conv] of Object.entries(conversations)) {
    const parsed = parseSessionKey(key);
    if (!parsed) continue;
    const participants = participantsFor(key, { selfId: 'self' });
    const channelId = channelIdFor(key);

    for (const m of conv.recentMessages ?? []) {
      // v1 的字段：sender(显示名) / userId(私聊才有) / isSelf / time(毫秒) / messageId / seq
      const senderId = String(m.userId ?? m.senderId ?? m.user_id ?? '');
      const isSelf = m.isSelf === true || (senderId && senderId === String(conv.selfQQ ?? ''));
      const direction = isSelf ? 'outbound' : 'inbound';
      const at = m.at ?? (m.time ? new Date(Number(m.time)).toISOString() : new Date().toISOString());
      const msg = {
        msgId: String(m.messageId ?? m.msgId ?? m.seq ?? `${key}-${at}-${senderId}`),
        sessionKey: key,
        direction,
        senderId,
        senderName: String(m.sender ?? m.senderName ?? m.name ?? ''),
        text: String(m.text ?? m.plain ?? ''),
        at,
      };
      if (!msg.text) continue;
      if (!dryRun) q.insertMessage(db, msg);
      report.messages += 1;

      if (senderId && !isSelf) {
        interactions.push({ contactId: `user:${senderId}`, channelId, at: msg.at, chars: msg.text.length });
        report.interactions += 1;
      }
      memoryEvents.push({
        text: msg.text,
        at: msg.at,
        participants,
        contentClass: 'event',
        sensitivity: parsed.kind === 'direct' ? 'channel' : 'channel',
      });
    }

    // 话题 → 事件
    for (const topic of conv.activeTopics ?? []) {
      const text = String(topic.text ?? '').trim();
      if (!text) continue;
      memoryEvents.push({
        text,
        at: topic.lastMentionAt ?? new Date().toISOString(),
        participants,
        contentClass: 'event',
        sensitivity: 'channel',
      });
      report.events += 1;
    }

    // 印象 → 事实
    const nameToUin = new Map();
    for (const m of conv.recentMessages ?? []) {
      const uid = String(m.userId ?? m.senderId ?? '');
      if (m.sender && uid) nameToUin.set(String(m.sender), uid);
    }
    for (const [name, value] of Object.entries(conv.memberImpressions ?? {})) {
      const uin = nameToUin.get(name);
      // v1 的 impression 可能是字符串，也可能是 { traits: [...], interactionCount, lastSeenAt }
      const text = typeof value === 'string'
        ? value
        : Array.isArray(value?.traits)
          ? value.traits.join('；')
          : String(value?.text ?? value?.note ?? value?.impression ?? JSON.stringify(value));
      memoryFacts.push({
        text: `${name}：${text}`,
        participants: [uin ? `user:${uin}` : `node:${name}`],
        contentClass: 'preference',
        sensitivity: 'contact',
        at: new Date().toISOString(),
      });
      report.facts += 1;
    }
  }

  // 4) 共享记忆 → shared 事实
  for (const note of shared.notes ?? []) {
    const text = String(note.content ?? '').trim();
    if (!text) continue;
    memoryFacts.push({
      text,
      participants: [],
      contentClass: 'preference',
      sensitivity: 'shared',
      at: note.at ? new Date(note.at).toISOString() : new Date().toISOString(),
    });
    report.facts += 1;
  }

  // 5) 表情
  for (const s of stickers) {
    if (!dryRun) {
      q.upsertSticker(db, {
        id: String(s.id ?? s.md5 ?? ''),
        desc: s.desc ?? '',
        note: s.localNote ?? '',
        tags: Array.isArray(s.tags) ? s.tags : [],
        url: s.url ?? '',
      });
    }
    report.stickers += 1;
  }

  // 6) 黑话
  for (const s of slang) {
    const term = String(s.content ?? s.term ?? '').trim();
    if (!term) continue;
    if (!dryRun) {
      q.upsertSlang(db, {
        term,
        meaning: s.meaning ?? '',
        usage: s.usage ?? s.example ?? '',
        status: s.status === 'candidate' ? 'candidate' : 'confirmed',
      });
    }
    report.slang += 1;
  }

  // 7) 性格（role.md 或 roles/*.md）
  // 角色卡选择：v1 config.role.name → 小鲸鱼.md → 其余第一个
  const v1Config = readJson(path.join(v1Dir, 'config.json'), {}) ?? {};
  const roleFiles = safeReaddir(path.join(v1Dir, 'roles')).filter((n) => n.endsWith('.md') && n !== 'README.md');
  const roleName = String(v1Config?.role?.name ?? v1Config?.roleName ?? '').trim();
  const preferred = roleName && roleFiles.includes(`${roleName}.md`)
    ? `${roleName}.md`
    : roleFiles.includes('小鲸鱼.md') ? '小鲸鱼.md' : roleFiles[0];
  const personaCandidates = [
    path.join(v1Dir, 'role.md'),
    ...(preferred ? [path.join(v1Dir, 'roles', preferred)] : []),
    ...roleFiles.filter((n) => n !== preferred).map((n) => path.join(v1Dir, 'roles', n)),
  ];
  for (const file of personaCandidates) {
    const markdown = readText(file);
    if (!markdown || !markdown.trim()) continue;
    if (memory && !dryRun) {
      await memory.setPersona?.({ markdown });
    }
    report.persona = true;
    report.personaFile = path.basename(file);
    break;
  }

  // 8) 写入 mnema（一次批量）
  if (memory && !dryRun && (memoryEvents.length || memoryFacts.length || interactions.length)) {
    await memory.ingestBatch?.({ events: memoryEvents, facts: memoryFacts, interactions });
    report.memoryImported = true;
  } else if (dryRun) {
    report.memoryPending = { events: memoryEvents.length, facts: memoryFacts.length, interactions: interactions.length };
  }

  logger?.info?.('迁移完成', report);
  return report;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
