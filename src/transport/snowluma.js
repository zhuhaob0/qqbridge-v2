/**
 * SnowLuma（OneBot）传输层
 *
 * 只做两件事：把原始事件抛给 router，把内部 key 翻译成 SDK 调用。
 * 真实客户端由 @snowluma/sdk 提供；测试注入假客户端。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseSessionKey } from '../router/session.js';

const fallbackBuilders = {
  text: (s) => String(s),
  image: (s) => ({ type: 'image', data: { file: s } }),
  record: (s) => ({ type: 'record', data: { file: s } }),
};

export function createSnowLumaTransport({
  client, logger = null, onRaw, builder = fallbackBuilders, voicesDir = './audio',
} = {}) {
  let started = false;
  const b = { ...fallbackBuilders, ...builder };

  function forward(event) {
    try {
      onRaw?.(event);
    } catch (error) {
      logger?.error?.('事件处理失败', { reason: error?.message ?? String(error) });
    }
  }

  client.onPrivateMessage?.((event) => forward(event));
  client.onGroupMessage?.((event) => forward(event));
  client.onNotice?.('notify', (event) => forward({ ...event, post_type: 'notice' }));

  async function sendTo(sessionKey, payload) {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return { ok: false, error: `非法会话 key：${sessionKey}` };
    try {
      const result = parsed.kind === 'direct'
        ? await client.sendPrivateMessage(Number(parsed.id), payload)
        : await client.sendGroupMessage(Number(parsed.id), payload);
      return { ok: true, msgId: String(result?.message_id ?? result?.data?.message_id ?? '') };
    } catch (error) {
      logger?.warn?.('发送失败', { key: sessionKey, reason: error?.message ?? String(error) });
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  return {
    client,

    start() {
      if (started) return;
      started = true;
      client.connect?.();
      logger?.info?.('SnowLuma 传输层启动');
    },

    stop() {
      started = false;
      client.close?.();
      logger?.info?.('SnowLuma 传输层停止');
    },

    async sendText(sessionKey, message) {
      return sendTo(sessionKey, b.text(String(message ?? '')));
    },

    async sendImage(sessionKey, url) {
      return sendTo(sessionKey, b.image(String(url)));
    },

    async sendSticker(sessionKey, stickerRef) {
      // QQ 收藏表情本质是图片；按 file 引用发送
      return sendTo(sessionKey, b.image(String(stickerRef)));
    },

    async sendVoice(sessionKey, voice) {
      const file = path.isAbsolute(String(voice ?? '')) ? String(voice) : path.join(voicesDir, String(voice ?? ''));
      return sendTo(sessionKey, b.record(file));
    },

    async sendPoke(sessionKey, targetUserId) {
      if (typeof client.sendPoke !== 'function') return { ok: false, error: 'SDK 不支持拍一拍' };
      const parsed = parseSessionKey(sessionKey);
      if (!parsed) return { ok: false, error: `非法会话 key：${sessionKey}` };
      try {
        const userId = Number(targetUserId ?? (parsed.kind === 'direct' ? parsed.id : 0));
        if (!userId) return { ok: false, error: '群聊里需要指定 targetUserId' };
        const options = parsed.kind === 'public' ? { group_id: Number(parsed.id) } : undefined;
        await client.sendPoke(userId, options);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },

    async listVoices() {
      try {
        return fs.readdirSync(voicesDir)
          .filter((name) => /\.(wav|mp3|silk|amr|ogg)$/i.test(name))
          .map((name) => ({
            name,
            size: (() => { try { return fs.statSync(path.join(voicesDir, name)).size; } catch { return 0; } })(),
          }));
      } catch {
        return [];
      }
    },

    async messageDetail(messageId) {
      if (typeof client.getMessage !== 'function') return null;
      try {
        return await client.getMessage(Number(messageId));
      } catch (error) {
        return null;
      }
    },

    async groupMembers(groupId) {
      if (typeof client.getGroupMemberList !== 'function') return [];
      try {
        const list = await client.getGroupMemberList(Number(groupId));
        return (Array.isArray(list) ? list : []).map((m) => ({
          userId: String(m.user_id ?? m.userId ?? ''),
          name: m.card || m.nickname || '',
          nickname: m.nickname ?? '',
          card: m.card ?? '',
        }));
      } catch (error) {
        logger?.warn?.('读取群成员失败', { reason: error?.message ?? String(error) });
        return [];
      }
    },

    async forwardMsg(id) {
      if (typeof client.getForwardMessage !== 'function') return { ok: false, error: 'SDK 不支持读取合并转发' };
      try {
        return await client.getForwardMessage({ id: String(id) });
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },

    async collectSticker(messageId, remark = '') {
      // OneBot 没有"收藏表情"标准动作：拿消息详情里的图片引用，落到本地表情库
      const detail = await this.messageDetail(messageId);
      const segments = detail?.message ?? detail?.data?.message ?? [];
      const image = (Array.isArray(segments) ? segments : []).find((s) => s?.type === 'image');
      if (!image) return { ok: false, error: '这条消息里没有图片/表情' };
      const file = image.data?.file ?? image.data?.url ?? '';
      return { ok: true, sticker: { id: String(messageId), desc: remark, url: file } };
    },

    async history(sessionKey, { limit = 20 } = {}) {
      const parsed = parseSessionKey(sessionKey);
      if (!parsed) return [];
      try {
        if (parsed.kind === 'direct') {
          const res = await client.getFriendMsgHistory?.(Number(parsed.id), limit);
          return res?.data ?? res ?? [];
        }
        const res = await client.getGroupMsgHistory?.(Number(parsed.id), limit);
        return res?.data ?? res ?? [];
      } catch (error) {
        logger?.warn?.('拉取历史失败', { key: sessionKey, reason: error?.message ?? String(error) });
        return [];
      }
    },
  };
}

/** 从配置创建真实传输层（动态 import，测试环境无需安装 SDK） */
export async function createSnowLumaTransportFromConfig(config, { logger = null, onRaw } = {}) {
  const sdk = await import('@snowluma/sdk');
  const client = new sdk.SnowLumaWebSocketClient({
    url: config?.qq?.snowluma?.url,
    accessToken: config?.qq?.snowluma?.token || undefined,
    reconnect: true,
  });
  return createSnowLumaTransport({
    client,
    logger,
    onRaw,
    builder: { text: sdk.text, image: sdk.image, record: sdk.record },
    voicesDir: config?.speech?.voicesDir ?? './audio',
  });
}
