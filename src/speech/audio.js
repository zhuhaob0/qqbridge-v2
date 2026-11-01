/**
 * 语音音频处理：下载 → 解码（SILK/AMR）→ 16kHz 单声道 wav
 *
 * QQ 语音实际是 SILK 编码（文件头 `#!SILK_V3`，文件名却常写成 .amr），
 * ffmpeg 不认 SILK，所以先用 silk-wasm 解成 PCM，再交给 ffmpeg 重采样。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  'ffmpeg',
  'D:\\dev_tools\\ffmpeg\\bin\\ffmpeg.exe',
].filter(Boolean);

function run(file, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(file)} 失败：${String(stderr || error.message).slice(0, 200)}`));
      else resolve({ stdout, stderr });
    });
  });
}

let ffmpegPath = null;
async function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  for (const candidate of FFMPEG_CANDIDATES) {
    try {
      await run(candidate, ['-version'], 5000);
      ffmpegPath = candidate;
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到 ffmpeg（语音转写需要它做重采样）');
}

function tempDir() {
  const dir = path.join(os.tmpdir(), 'qqbridge-speech');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 下载音频到临时文件 */
export async function downloadAudio(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载语音失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('下载到的语音是空文件');
    const file = path.join(tempDir(), `voice-${Date.now()}.bin`);
    fs.writeFileSync(file, buf);
    return { file, bytes: buf.length, buffer: buf };
  } finally {
    clearTimeout(timer);
  }
}

/** 是否是 SILK（QQ/微信语音的真实格式） */
export function isSilk(buffer) {
  return Buffer.isBuffer(buffer) && buffer.includes('#!SILK') && buffer.length > 16;
}

/**
 * SILK → 16k wav
 * @param {Buffer} buffer
 * @param {{sampleRate?: number}} [options] QQ 语音通常是 24000
 */
export async function silkToWav(buffer, { sampleRate = 24000 } = {}) {
  const { decode } = require('silk-wasm');
  const { data } = await decode(buffer, sampleRate);
  const pcm = Buffer.from(data.buffer ?? data);
  const pcmFile = path.join(tempDir(), `voice-${Date.now()}.pcm`);
  fs.writeFileSync(pcmFile, pcm);
  const ffmpeg = await resolveFfmpeg();
  const out = `${pcmFile}.wav`;
  await run(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', pcmFile,
    '-ar', '16000', '-ac', '1', '-f', 'wav', out,
  ], 60000);
  cleanup(pcmFile);
  if (!fs.existsSync(out)) throw new Error('ffmpeg 没有生成 wav');
  return out;
}

/** 任意音频（amr/mp3/wav…）→ 16k wav */
export async function toWav(inputFile) {
  const buffer = fs.readFileSync(inputFile);
  if (isSilk(buffer)) return silkToWav(buffer);
  const ffmpeg = await resolveFfmpeg();
  const out = `${inputFile}.wav`;
  await run(ffmpeg, ['-y', '-loglevel', 'error', '-i', inputFile, '-ar', '16000', '-ac', '1', '-f', 'wav', out], 60000);
  if (!fs.existsSync(out)) throw new Error('ffmpeg 没有生成 wav');
  return out;
}

/** 清掉临时文件（尽力而为） */
export function cleanup(...files) {
  for (const file of files) {
    if (!file) continue;
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}
