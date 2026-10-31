/**
 * 语音识别端口（可插拔）
 *
 * provider:
 *   none       - 关闭
 *   http       - OpenAI 兼容转写接口
 *   sensevoice - 本地 sherpa-onnx（execFile python transcribe.py）
 *   whisper    - 本地 faster-whisper / whisper.cpp 命令行
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runCommand({ command, args = [], timeoutMs = 20000, env = process.env }) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  return String(stdout ?? '').trim();
}

export function createSpeech(config = {}, deps = {}) {
  const provider = config.provider ?? 'none';

  if (provider === 'none') {
    return { provider, async transcribe() { return null; } };
  }

  if (provider === 'http') {
    const { url, apiKey = '', model = 'whisper-1' } = config.http ?? {};
    const fetchImpl = deps.fetchImpl ?? fetch;
    return {
      provider,
      async transcribe({ audioBase64, mimeType = 'audio/wav' } = {}) {
        if (!url || !audioBase64) return null;
        const form = new FormData();
        const bytes = Buffer.from(audioBase64, 'base64');
        form.append('file', new Blob([bytes], { type: mimeType }), 'audio.wav');
        form.append('model', model);
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          body: form,
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.text ? { text: data.text } : null;
      },
    };
  }

  const exec = deps.exec ?? runCommand;

  if (provider === 'sensevoice') {
    const { script = 'transcribe.py', model = '', python = 'python', threads = 2 } = config.sensevoice ?? {};
    return {
      provider,
      async transcribe({ audioPath } = {}) {
        if (!audioPath) return null;
        const args = ['-X', 'utf8', script, audioPath, '--json'];
        if (model) args.push('--model', model);
        args.push('--threads', String(threads));
        const out = await exec({ command: python, args });
        try {
          const data = JSON.parse(out);
          return data?.text ? { text: data.text, confidence: data.confidence } : null;
        } catch {
          return out ? { text: out } : null;
        }
      },
    };
  }

  if (provider === 'whisper') {
    const { command = 'whisper', model = 'small', extraArgs = [] } = config.whisper ?? {};
    return {
      provider,
      async transcribe({ audioPath } = {}) {
        if (!audioPath) return null;
        const out = await exec({ command, args: ['--model', model, '--output-format', 'txt', ...extraArgs, audioPath] });
        return out ? { text: out } : null;
      },
    };
  }

  return { provider: 'none', async transcribe() { return null; } };
}
