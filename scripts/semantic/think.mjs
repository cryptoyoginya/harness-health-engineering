#!/usr/bin/env node
// think.mjs — собирает контекст под вопрос и формирует промпт для синтеза.
//
// Использование:
//   node scripts/semantic/think.mjs "что такое CDX-сегмент"
//   node scripts/semantic/think.mjs "..." --top 15 --layer 04_synthesis
//   node scripts/semantic/think.mjs "..." --execute      # попробовать запустить claude CLI
//   node scripts/semantic/think.mjs "..." --json         # машинный вывод (context + prompt)
//
// Что делает:
//   1. Hybrid search (vector + BM25 + RRF) — топ-K чанков.
//   2. Для каждого чанка считает «возраст» источника (mtime). Если все источники старше
//      порога (90 дней по умолчанию) — добавляет предупреждение «контекст не обновлялся».
//   3. Формирует промпт по правилам AGENTS.md: метки FACT/INFERENCE/ASSUMPTION/UNKNOWN,
//      цитаты [source: /path], запрет на recommendations без evidence.
//   4. По умолчанию печатает промпт в stdout (копируешь и вставляешь в Claude / любой LLM).
//      С флагом --execute пробует запустить `claude -p "..."` (если claude CLI в PATH).
//
// Не пишет в БД и не модифицирует KB.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  createEmbedder,
  QUERY_PREFIX,
  openDb,
  searchVec,
  searchBM25,
  fuseRRF,
  DB_PATH,
  REPO_ROOT,
  INDEXABLE_LAYERS,
} from './lib.mjs';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('Использование: node scripts/semantic/think.mjs "вопрос" [--top N] [--layer X] [--execute] [--json]');
  process.exit(1);
}

let topK = 12;
let layer = null;
let asJson = false;
let execute = false;
const queryParts = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--top') {
    topK = parseInt(argv[++i], 10);
    if (!Number.isFinite(topK) || topK <= 0) {
      console.error('--top должно быть положительным числом');
      process.exit(1);
    }
  } else if (a === '--layer') {
    layer = argv[++i];
    if (!INDEXABLE_LAYERS.includes(layer)) {
      console.error(`--layer должен быть одним из: ${INDEXABLE_LAYERS.join(', ')}`);
      process.exit(1);
    }
  } else if (a === '--json') {
    asJson = true;
  } else if (a === '--execute') {
    execute = true;
  } else {
    queryParts.push(a);
  }
}

const question = queryParts.join(' ').trim();
if (!question) {
  console.error('Пустой вопрос.');
  process.exit(1);
}

if (!existsSync(DB_PATH)) {
  console.error(`[think] БД не найдена: ${DB_PATH}.\nЗапустите: node scripts/semantic/index.mjs`);
  process.exit(1);
}

const db = openDb();

const overK = Math.max(topK * 3, 30);
const embed = await createEmbedder();
const [queryEmbedding] = await embed([QUERY_PREFIX + question]);
const vecResults = searchVec(db, queryEmbedding, { topK: overK, layer });
const bmResults = searchBM25(db, question, { topK: overK, layer });
const fused = fuseRRF(vecResults, bmResults, { topK });

// Свежесть источников: уникальные файлы → их mtime из таблицы files (это секунды UNIX*1000).
const uniqueFiles = Array.from(new Set(fused.map((r) => r.file)));
const fileMeta = new Map();
const now = Date.now();
const STALE_DAYS = 90;
let allStale = uniqueFiles.length > 0;
for (const f of uniqueFiles) {
  let mtimeMs = 0;
  const abs = join(REPO_ROOT, f);
  try { mtimeMs = statSync(abs).mtimeMs; } catch { mtimeMs = 0; }
  const ageDays = mtimeMs ? Math.floor((now - mtimeMs) / 86_400_000) : null;
  if (ageDays !== null && ageDays < STALE_DAYS) allStale = false;
  fileMeta.set(f, { mtimeMs, ageDays });
}
db.close();

// open-questions.md и contradictions.md — отдельно подсветим, если они попали в топ.
const openQuestionsHit = fused.find((r) => r.file === '04_synthesis/open-questions.md');
const contradictionsHit = fused.find((r) => r.file === '04_synthesis/contradictions.md');

const promptText = buildPrompt(question, fused, fileMeta, { allStale, openQuestionsHit, contradictionsHit });

if (asJson) {
  console.log(JSON.stringify({
    question,
    topK,
    layer,
    allStale,
    sources: uniqueFiles.map((f) => ({
      file: f,
      age_days: fileMeta.get(f).ageDays,
    })),
    chunks: fused.map((r) => ({
      file: r.file,
      line: r.line_start,
      layer: r.layer,
      heading: r.heading,
      vec_rank: r.vec_rank,
      bm25_rank: r.bm25_rank,
      fused: Number(r.fused.toFixed(6)),
      text: r.text,
    })),
    prompt: promptText,
  }, null, 2));
  process.exit(0);
}

if (execute) {
  // Попытка вызвать claude CLI. Если нет — fallback на печать промпта.
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (which.status !== 0) {
    console.error('[think] claude CLI не найден в PATH. Печатаю промпт ниже — скопируйте его в любой LLM.\n');
    console.log(promptText);
    process.exit(0);
  }
  // Передаём промпт через stdin: claude -p "" --print
  const res = spawnSync('claude', ['-p', promptText], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000, killSignal: 'SIGTERM' });
  if (res.error) {
    console.error(`[think] claude не ответил за 5 мин: ${res.error.code || res.error.message}. Запусти без --execute (или с --json), чтобы получить промпт.`);
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

console.log(promptText);

// --------- prompt-builder ----------

// Если в корне репо есть AGENTS.md — он становится системным промптом (это и есть
// канонический контракт «как агент должен работать с KB»). Если нет — используем generic
// дефолт с метками FACT/INFERENCE/UNKNOWN.
function loadSystemPrompt() {
  const path = join(REPO_ROOT, 'AGENTS.md');
  try {
    const text = readFileSync(path, 'utf8');
    if (text.trim()) return text;
  } catch { /* fallthrough */ }
  return [
    'Ты помогаешь по KB этого проекта. Отвечай на русском.',
    'Каждое нетривиальное утверждение помечай меткой и сопровождай цитатой:',
    '  • `FACT:` — прямо из источника, требует [source: /path].',
    '  • `INFERENCE:` — вывод из источников, объясни ход и цитируй.',
    '  • `ASSUMPTION:` — гипотеза без evidence, явно помечай.',
    '  • `UNKNOWN:` — пробел; назови, какой артефакт его закрыл бы.',
    '  • `RISK:` — стратегический/operational/доходный риск.',
    '  • `DECISION:` — явное решение из /05_decisions/.',
    '  • `RECOMMENDATION:` — предложение, не факт. Запрещено выдавать за факт.',
    '',
    'Никогда не сваливай факты, гипотезы и решения в один абзац без меток.',
    'Если evidence недостаточно — отвечай `UNKNOWN:` и перечисли пробелы, а не выдумывай.',
    '',
    'Структура ответа:',
    '  1. Короткий ответ (1–3 предложения) с метками и цитатами.',
    '  2. Детали — только если они меняют ответ. Каждый блок с меткой.',
    '  3. Раздел «Пробелы» — что неизвестно, какой артефакт нужен.',
  ].join('\n');
}

function buildPrompt(question, chunks, fileMeta, { allStale, openQuestionsHit, contradictionsHit }) {
  const lines = [];
  lines.push('# Системная инструкция (источник: AGENTS.md, при наличии)');
  lines.push('');
  lines.push(loadSystemPrompt());
  lines.push('');
  if (allStale) {
    lines.push(`> ⚠️ Все цитируемые источники старше ${90} дней. Указывай это в ответе как RISK: stale evidence.`);
    lines.push('');
  }
  if (openQuestionsHit) {
    lines.push(`> Вопрос частично уже в /04_synthesis/open-questions.md (chunk ${openQuestionsHit.line_start}). Сошлись.`);
    lines.push('');
  }
  if (contradictionsHit) {
    lines.push(`> Есть зафиксированные противоречия в /04_synthesis/contradictions.md (chunk ${contradictionsHit.line_start}). Не сглаживай.`);
    lines.push('');
  }
  lines.push('# Вопрос пользователя');
  lines.push('');
  lines.push(question);
  lines.push('');
  lines.push('# Контекст из KB (топ чанков, hybrid retrieval)');
  lines.push('');
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const meta = fileMeta.get(c.file);
    const age = meta?.ageDays != null ? `${meta.ageDays}д` : '?';
    lines.push(`## [${i + 1}] /${c.file}:${c.line_start}   layer=${c.layer}   heading=«${c.heading || '—'}»   age=${age}`);
    lines.push('');
    lines.push(c.text);
    lines.push('');
  }
  lines.push('# Список источников (используй ровно эти пути в [source: ...])');
  lines.push('');
  for (const f of Array.from(new Set(chunks.map((c) => `/${c.file}`)))) {
    lines.push(`- ${f}`);
  }
  lines.push('');
  return lines.join('\n');
}
