/**
 * 语音识别端口（可插拔）
 *
 * provider:
 *   none   - 关闭（默认）
 *   sherpa - 本地 SenseVoice（sherpa-onnx-node，纯 Node，不需要 Python/独立服务）
 *   http   - OpenAI 兼容转写接口（自备 key）
 */

import { createSherpaSpeech } from './sherpa.js';

export function createSpeech(config = {}, deps = {}) {
  const provider = config.provider ?? 'none';
  const logger = deps.logger ?? null;

  if (provider === 'none') {
    return { provider, status: () => ({ provider: 'none' }), async transcribe() { return null; } };
  }

  if (provider === 'sherpa') {
    const speech = createSherpaSpeech({
      modelDir: config.modelDir || undefined,
      numThreads: config.numThreads ?? 2,
      language: config.language ?? 'zh',
      logger,
    });
    return {
      provider,
      status: () => speech.status(),
      transcribe: (input) => speech.transcribe(input),
    };
  }

  if (provider === 'http') {
    const { url, apiKey = '', model = 'whisper-1' } = config.http ?? {};
    if (!url) throw new Error('speech.http.url 未配置');
    return {
      provider,
      status: () => ({ provider: 'http', url }),
      async transcribe({ audioBase64, mimeType = 'audio/wav' } = {}) {
        if (!audioBase64) return null;
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: mimeType }), 'audio.wav');
        form.append('model', model);
        const res = await fetch(url, {
          method: 'POST',
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body: form,
        });
        if (!res.ok) throw new Error(`转写接口失败 HTTP ${res.status}`);
        const data = await res.json().catch(() => ({}));
        return String(data.text ?? '').trim() || null;
      },
    };
  }

  throw new Error(`未知的 speech.provider：${provider}`);
}
