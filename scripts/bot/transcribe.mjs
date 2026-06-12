// transcribe.mjs — on-device расшифровка голосовых. Whisper (ONNX через @xenova/transformers)
// крутится локально, аудио НЕ покидает машину. OGG/Opus от Telegram декодируем prebuilt-ffmpeg.
//
// Модель грузится лениво (только при первом голосовом) и кэшируется в node_modules — первый
// запуск качает ~80–150 МБ, дальше из кэша. Модель меняется через env WHISPER_MODEL.

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { pipeline, env } from '@xenova/transformers';

env.allowRemoteModels = true; // первый раз нужно скачать модель

const MODEL = process.env.WHISPER_MODEL || 'Xenova/whisper-base';
const LANG = process.env.WHISPER_LANG || 'russian';

let asrPromise = null;
function getASR() {
  if (!asrPromise) asrPromise = pipeline('automatic-speech-recognition', MODEL, { quantized: true });
  return asrPromise;
}

// OGG/Opus (Buffer) → Float32Array PCM, 16 кГц моно — формат, который ждёт Whisper.
function oggToPcm(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg вышел с кодом ${code}`));
      const b = Buffer.concat(chunks);
      const n = Math.floor(b.byteLength / 4);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = b.readFloatLE(i * 4);
      resolve(f);
    });
    ff.stdin.on('error', () => {}); // не падать, если ffmpeg закрылся раньше
    ff.stdin.write(buf);
    ff.stdin.end();
  });
}

export async function transcribe(buf) {
  const pcm = await oggToPcm(buf);
  if (!pcm.length) return '';
  const asr = await getASR();
  const out = await asr(pcm, {
    language: LANG,
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  return (out.text || '').trim();
}

// Прогрев модели в фоне (необязательно) — чтобы первое голосовое не ждало загрузку.
export function warmup() {
  getASR().catch(() => {});
}
