/**
 * 本地语音识别：Sherpa-ONNX + SenseVoice
 *
 * 用 DSH 同款模型（SenseVoiceSmall ONNX），纯 Node（sherpa-onnx-node 自带 ONNX Runtime），
 * 不需要 Python、不需要单独起服务。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function defaultModelDir() {
  return path.join(process.cwd(), 'state', 'models', 'sensevoice');
}

/**
 * @param {{modelDir?: string, numThreads?: number, language?: string, logger?: object}} [options]
 */
export function createSherpaSpeech({ modelDir, numThreads = 2, language = 'zh', logger = null } = {}) {
  const dir = modelDir ?? defaultModelDir();
  let recognizer = null;
  let loading = null;

  function modelFiles() {
    const model = path.join(dir, 'model.int8.onnx');
    const tokens = path.join(dir, 'tokens.txt');
    return { model, tokens, ready: fs.existsSync(model) && fs.existsSync(tokens) };
  }

  async function ensure() {
    if (recognizer) return recognizer;
    if (loading) return loading;
    const files = modelFiles();
    if (!files.ready) {
      throw new Error(`语音模型不完整（需要 model.int8.onnx + tokens.txt）：${dir}`);
    }
    loading = (async () => {
      const sherpa = require('sherpa-onnx-node');
      recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: files.model,
            language,
            useInverseTextNormalization: 1,
          },
          tokens: files.tokens,
          numThreads,
          provider: 'cpu',
          debug: 0,
        },
      });
      logger?.info?.('语音模型已加载', { dir, numThreads });
      return recognizer;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  return {
    provider: 'sherpa',
    get modelDir() { return dir; },
    status() {
      const files = modelFiles();
      return { provider: 'sherpa', modelDir: dir, ready: files.ready, loaded: Boolean(recognizer) };
    },
    /** @param {{audioPath: string}} input 16kHz 单声道 wav 路径 */
    async transcribe({ audioPath } = {}) {
      if (!audioPath || !fs.existsSync(audioPath)) throw new Error('音频文件不存在');
      const rec = await ensure();
      const sherpa = require('sherpa-onnx-node');
      const wave = sherpa.readWave(audioPath);
      if (Number(wave.sampleRate) !== 16000) throw new Error(`采样率必须是 16kHz，实际 ${wave.sampleRate}`);
      const stream = rec.createStream();
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
      rec.decode(stream);
      const result = rec.getResult(stream);
      return String(result?.text ?? '').trim();
    },
  };
}
