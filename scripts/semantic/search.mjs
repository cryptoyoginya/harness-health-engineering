#!/usr/bin/env node
// search.mjs — гибридный поиск по индексу KB вашего проекта (vector + BM25 + RRF).
//
// Использование:
//   node scripts/semantic/search.mjs "ваш запрос"
//   node scripts/semantic/search.mjs "ваш запрос" --top 15
//   node scripts/semantic/search.mjs "ваш запрос" --layer 04_synthesis
//   node scripts/semantic/search.mjs "ваш запрос" --mode bm25     # только BM25
//   node scripts/semantic/search.mjs "ваш запрос" --mode vector   # только vector (старое поведение)
//   node scripts/semantic/search.mjs "ваш запрос" --mode hybrid   # default: RRF(vec, bm25)
//   node scripts/semantic/search.mjs "ваш запрос" --explain       # показать вклад каналов
//   node scripts/semantic/search.mjs "ваш запрос" --json           # для использования в pipe / hook
//
// Возвращает топ-K чанков. По умолчанию — гибридный режим: vector ловит синонимы и
// перефразирования, BM25 ловит точные термины (NRR, ARR, аббревиатуры). RRF объединяет.

import { existsSync } from 'node:fs';
import {
  createEmbedder,
  QUERY_PREFIX,
  openDb,
  searchVec,
  searchBM25,
  fuseRRF,
  DB_PATH,
  INDEXABLE_LAYERS,
} from './lib.mjs';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('Использование: node scripts/semantic/search.mjs "ваш запрос" [--top N] [--layer X] [--mode hybrid|vector|bm25] [--explain] [--json]');
  process.exit(1);
}

let topK = 10;
let layer = null;
let mode = 'hybrid';
let asJson = false;
let explain = false;
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
  } else if (a === '--mode') {
    mode = argv[++i];
    if (!['hybrid', 'vector', 'bm25'].includes(mode)) {
      console.error('--mode должен быть hybrid | vector | bm25');
      process.exit(1);
    }
  } else if (a === '--json') {
    asJson = true;
  } else if (a === '--explain') {
    explain = true;
  } else {
    queryParts.push(a);
  }
}

const query = queryParts.join(' ').trim();
if (!query) {
  console.error('Пустой запрос.');
  process.exit(1);
}

if (!existsSync(DB_PATH)) {
  console.error(`[search] БД не найдена: ${DB_PATH}.\nЗапустите: node scripts/semantic/index.mjs`);
  process.exit(1);
}

const db = openDb();

let results;
if (mode === 'bm25') {
  results = searchBM25(db, query, { topK, layer }).map((r) => ({
    ...r,
    similarity: null,
    fused: null,
  }));
} else if (mode === 'vector') {
  const embed = await createEmbedder();
  const [queryEmbedding] = await embed([QUERY_PREFIX + query]);
  results = searchVec(db, queryEmbedding, { topK, layer });
} else {
  // hybrid: оба канала с запасом, потом RRF.
  const overK = Math.max(topK * 3, 20);
  const embed = await createEmbedder();
  const [queryEmbedding] = await embed([QUERY_PREFIX + query]);
  const vecResults = searchVec(db, queryEmbedding, { topK: overK, layer });
  const bmResults = searchBM25(db, query, { topK: overK, layer });
  results = fuseRRF(vecResults, bmResults, { topK });
}

db.close();

if (asJson) {
  console.log(JSON.stringify(
    results.map((r) => ({
      file: r.file,
      line: r.line_start,
      heading: r.heading,
      layer: r.layer,
      similarity: r.similarity != null ? Number(r.similarity.toFixed(4)) : null,
      bm25_score: r.bm25_score != null ? Number(r.bm25_score.toFixed(4)) : null,
      fused: r.fused != null ? Number(r.fused.toFixed(6)) : null,
      vec_rank: r.vec_rank ?? null,
      bm25_rank: r.bm25_rank ?? null,
      text: r.text,
    })),
    null,
    2,
  ));
  process.exit(0);
}

if (results.length === 0) {
  console.log('Ничего не найдено.');
  process.exit(0);
}

console.log(`\n[search] запрос: «${query}»   mode=${mode}${layer ? `   layer=${layer}` : ''}   top=${topK}\n`);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const snippet = r.text.replace(/\s+/g, ' ').slice(0, 240);
  console.log(`${String(i + 1).padStart(2)}. ${r.file}:${r.line_start}   [${r.layer}]   ${r.heading || ''}`);
  let scoreLine = '    ';
  if (mode === 'vector') {
    scoreLine += `similarity=${r.similarity.toFixed(3)}`;
  } else if (mode === 'bm25') {
    scoreLine += `bm25_score=${r.score.toFixed(3)}`;
  } else {
    scoreLine += `fused=${r.fused.toFixed(5)}`;
    if (explain) {
      const v = r.vec_rank ? `vec#${r.vec_rank} sim=${r.vec_sim.toFixed(3)}` : 'vec—';
      const b = r.bm25_rank ? `bm25#${r.bm25_rank} score=${r.bm25_score.toFixed(2)}` : 'bm25—';
      scoreLine += `   (${v}; ${b})`;
    }
  }
  console.log(scoreLine);
  console.log(`    ${snippet}${r.text.length > 240 ? '…' : ''}`);
  console.log('');
}
