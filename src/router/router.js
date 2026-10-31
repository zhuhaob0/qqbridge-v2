/**
 * 路由：屏蔽 → 幂等 → 落库 → 交给上层
 */

import { normalizeEvent } from '../transport/normalize.js';
import { sessionAllowed } from '../security/policy.js';
import { channelIdFor, participantsFor } from './session.js';
import * as q from '../storage/queries.js';

export function createRouter({ db, config, logger, onMessage, clock = () => new Date() }) {
  return {
    /**
     * @param {object} raw OneBot 事件
     * @returns {{ accepted: boolean, reason?: string, msg?: object }}
     */
    handle(raw) {
      const msg = normalizeEvent(raw, { selfQQ: config?.qq?.selfQQ });
      if (!msg) return { accepted: false, reason: '非消息事件' };

      if (!sessionAllowed(msg.sessionKey, config)) {
        logger?.debug?.('会话不在白名单，忽略', { key: msg.sessionKey });
        return { accepted: false, reason: '会话不在白名单' };
      }

      if (!msg.msgId) return { accepted: false, reason: '缺少 message_id' };

      const dedupeKey = `${msg.sessionKey}:${msg.msgId}`;
      if (q.seenDedupe(db, dedupeKey)) return { accepted: false, reason: '重复消息' };

      const inserted = q.insertMessage(db, {
        ...msg,
        raw: undefined, // 原始事件太大，默认不落库（需要时打开）
      });
      q.markDedupe(db, dedupeKey, clock().toISOString());
      if (!inserted) return { accepted: false, reason: '重复消息（唯一约束）' };

      const now = clock().toISOString();
      const existing = q.getSession(db, msg.sessionKey);
      if (!existing) {
        q.upsertSession(db, {
          sessionKey: msg.sessionKey,
          kind: msg.kind,
          participants: participantsFor(msg.sessionKey, { selfId: 'self' }),
          lastEventAt: now,
          createdAt: now,
        });
      } else {
        q.upsertSession(db, { ...existing, lastEventAt: now });
      }

      if (msg.direction === 'inbound') {
        onMessage?.(msg, {
          channelId: channelIdFor(msg.sessionKey),
          participants: participantsFor(msg.sessionKey, { selfId: 'self' }),
        });
      }

      return { accepted: true, msg };
    },
  };
}
