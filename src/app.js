/**
 * 应用装配：router + wake + batcher + orchestrator
 * 传输层（SnowLuma）在 index.js 注入，便于测试时替换。
 */

import { createRouter } from './router/router.js';
import { shouldWake } from './wake/policy.js';
import { createBatcher } from './wake/batcher.js';
import { createOrchestrator } from './orchestrator/run.js';
import * as q from './storage/queries.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadAudio, toWav, cleanup } from './speech/audio.js';

export function createApp({
  db, config, agent, qq, memory = null, speech = null, logger = null,
  clock = () => new Date(), random = Math.random, sleep, bus = null,
} = {}) {
  const orchestrator = createOrchestrator({ db, config, agent, qq, memory, logger, clock, random, sleep });

  const batcher = createBatcher({
    windowMs: config?.wake?.batchWindowMs ?? 1500,
    onFlush: async (sessionKey) => {
      try {
        await orchestrator.run(sessionKey);
      } catch (error) {
        logger?.error?.('编排异常', { key: sessionKey, reason: error?.message ?? String(error) });
      }
    },
  });

  /** 记忆写入与「是否回复」无关：否则没被叫到的群聊内容永远不会进记忆 */
  function rememberMessage(msg, ctx) {
    if (!memory || !msg.text) return;
    const shareScope = memory.shareScope ?? 'group';
    const isGroup = msg.kind !== 'direct';
    const sensitivity = shareScope === 'all' ? 'shared' : isGroup ? (shareScope === 'group' ? 'shared' : 'channel') : 'channel';
    Promise.resolve(memory.ingest({
      channel: {
        id: ctx?.channelId,
        kind: msg.kind,
        participants: ctx?.participants ?? [],
        recordPublic: config?.memory?.recordGroupChatter !== false,
      },
      events: [{ role: 'user', text: msg.text, at: msg.at, sensitivity }],
    })).catch((error) => logger?.warn?.('记忆写入失败', { key: msg.sessionKey, reason: error?.message ?? String(error) }));
  }

  function wake(msg) {
    // 用库里真实的会话状态：群聊/私聊默认活跃；潜水（diving）只认 @/点名/提问
    const dbSession = q.getSession(db, msg.sessionKey);
    const session = dbSession ?? { wakeState: { mode: 'active' } };
    const decision = shouldWake({ msg, session, config, now: clock().getTime(), random });
    if (!decision.wake) {
      logger?.debug?.('不唤醒', { key: msg.sessionKey, reason: decision.reason });
      return;
    }
    batcher.push(msg.sessionKey, msg);
  }

  /** 语音：下载 → 解码 SILK → 16k wav → SenseVoice → 文本回填，再走唤醒 */
  async function transcribeVoice(msg, ctx) {
    const media = (msg.media ?? []).find((m) => m.type === 'record');
    let file = null;
    let wav = null;
    try {
      let buffer = null;
      if (media?.url) {
        try {
          const downloaded = await downloadAudio(media.url);
          file = downloaded.file;
        } catch (error) {
          logger?.warn?.('语音 url 下载失败，尝试 get_record', { key: msg.sessionKey, reason: error?.message ?? String(error) });
        }
      }
      if (!file && media?.file && typeof qq.getRecord === 'function') {
        buffer = await qq.getRecord(media.file);
        if (buffer) {
          const tmpDir = path.join(os.tmpdir(), 'qqbridge-speech');
          fs.mkdirSync(tmpDir, { recursive: true });
          file = path.join(tmpDir, `voice-${Date.now()}.bin`);
          fs.writeFileSync(file, buffer);
        }
      }
      if (!file) throw new Error('语音既没有可用链接，也取不到音频字节');
      wav = await toWav(file);
      const started = clock().getTime();
      const text = await speech.transcribe({ audioPath: wav });
      if (text) {
        const display = `[语音：${text}]`;
        q.updateMessageText(db, msg.sessionKey, msg.msgId, display);
        msg.text = display;
        logger?.info?.('语音已转写', { key: msg.sessionKey, chars: text.length, elapsedMs: clock().getTime() - started });
      } else {
        logger?.warn?.('语音转写为空', { key: msg.sessionKey });
      }
    } catch (error) {
      logger?.warn?.('语音转写失败', { key: msg.sessionKey, reason: error?.message ?? String(error) });
    } finally {
      cleanup(file, wav);
    }
    rememberMessage(msg, ctx);
    wake(msg);
  }

  const router = createRouter({
    db,
    config,
    logger,
    clock,
    onMessage: (msg, ctx) => {
      bus?.emitMessage?.(msg);
      const hasRecord = (msg.media ?? []).some((m) => m.type === 'record');
      if (hasRecord && speech && speech.provider !== 'none') {
        void transcribeVoice(msg, ctx);
        return;
      }
      rememberMessage(msg, ctx);
      wake(msg);
    },
  });

  return { router, orchestrator, batcher };
}
