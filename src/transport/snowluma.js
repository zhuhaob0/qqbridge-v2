/**
 * SnowLuma（OneBot）传输层
 *
 * 只做两件事：把原始事件抛给 router，把内部 key 翻译成 SDK 调用。
 * 真实客户端由 @snowluma/sdk 提供；测试注入假客户端。
 */

import { parseSessionKey } from '../router/session.js';

export function createSnowLumaTransport({ client, logger = null, onRaw, textFactory = (s) => s } = {}) {
  let started = false;

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
      const parsed = parseSessionKey(sessionKey);
      if (!parsed) return { ok: false, error: `非法会话 key：${sessionKey}` };
      const payload = textFactory(String(message ?? ''));
      try {
        const result = parsed.kind === 'direct'
          ? await client.sendPrivateMessage(Number(parsed.id), payload)
          : await client.sendGroupMessage(Number(parsed.id), payload);
        return { ok: true, msgId: String(result?.message_id ?? result?.data?.message_id ?? '') };
      } catch (error) {
        logger?.warn?.('发送失败', { key: sessionKey, reason: error?.message ?? String(error) });
        return { ok: false, error: error?.message ?? String(error) };
      }
    },

    /** 读历史（补拉切换窗口的消息用） */
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
    textFactory: sdk.text ?? ((s) => s),
  });
}
