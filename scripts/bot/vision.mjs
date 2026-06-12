// vision.mjs — on-device определение типа фото (селфи / еда / стул) без подписи.
// Zero-shot классификация через CLIP (ONNX, @xenova/transformers) — картинка НЕ покидает машину.
// Модель грузится лениво и кэшируется в node_modules. Меняется через env VISION_MODEL.

import { pipeline, env, RawImage } from '@xenova/transformers';

env.allowRemoteModels = true;

const MODEL = process.env.VISION_MODEL || 'Xenova/clip-vit-base-patch32';

// Несколько формулировок на класс (CLIP лучше понимает английский), суммируем по классу.
const LABELS = [
  { kind: 'selfie', text: 'a selfie photo of a human face' },
  { kind: 'selfie', text: 'a portrait of a person' },
  { kind: 'food',   text: 'a photo of a plate of food or a meal' },
  { kind: 'food',   text: 'a close-up photo of food' },
  { kind: 'stool',  text: 'a photo of stool or feces in a toilet bowl' },
  { kind: 'stool',  text: 'a dirty toilet bowl' },
];

let clsPromise = null;
function getClassifier() {
  if (!clsPromise) clsPromise = pipeline('zero-shot-image-classification', MODEL, { quantized: true });
  return clsPromise;
}

// Buffer (jpg/png) → 'selfie' | 'food' | 'stool'. Селфи — безопасный фолбэк при неуверенности.
export async function classifyImage(buf) {
  const img = await RawImage.fromBlob(new Blob([buf]));
  const cls = await getClassifier();
  const out = await cls(img, LABELS.map((l) => l.text));

  const score = { selfie: 0, food: 0, stool: 0 };
  for (const o of out) {
    const l = LABELS.find((x) => x.text === o.label);
    if (l) score[l.kind] += o.score;
  }
  let best = 'selfie';
  for (const k of ['food', 'stool']) if (score[k] > score[best]) best = k;
  // на не-селфи переключаемся только при уверенности — иначе остаёмся на нейтральном селфи
  if (best !== 'selfie' && score[best] < 0.45) best = 'selfie';
  return { kind: best, score: score[best] };
}

export function warmup() { getClassifier().catch(() => {}); }
