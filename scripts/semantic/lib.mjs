// lib.mjs — shared helpers для semantic-index / semantic-search.
//
// Состав:
//   • chunkMarkdown(text)        — разбивает MD-файл на чанки по заголовкам + ≤ MAX_CHUNK_CHARS.
//   • createEmbedder()           — singleton multilingual-e5-small через @xenova/transformers.
//   • passagePrefix / queryPrefix — обязательные e5-префиксы.
//   • openDb(path)               — better-sqlite3 + sqlite-vec, создаёт схему при первом вызове.
//   • insertChunk / deleteFileChunks — БД-операции для чанков (vec + FTS5 синхронно).
//   • searchVec / searchBM25 / searchHybrid — три режима поиска (RRF для гибрида).
//   • parseFrontmatterLinks / upsertLinks   — извлечение и хранение связей related: между файлами.
//   • walkMarkdown(roots)        — обход KB-слоёв.
//
// Зависимости: см. ./package.json. Запуск только через CLI-обёртки index.mjs / search.mjs.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { pipeline, env } from '@xenova/transformers';

// ---------- константы ----------

export const EMBED_MODEL = 'Xenova/multilingual-e5-small';
export const EMBED_DIM = 384;
export const MAX_CHUNK_CHARS = 1200;
export const MIN_CHUNK_CHARS = 80;
export const PASSAGE_PREFIX = 'passage: ';
export const QUERY_PREFIX = 'query: ';

// Корень репо относительно scripts/semantic/lib.mjs
const here = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const DB_PATH = resolve(REPO_ROOT, '.semantic-index.sqlite');

// Слои, которые индексируем. Порядок отражает каноническую иерархию из AGENTS.md.
//
// Если у вашего проекта другая структура — отредактируйте этот массив.
// Например, добавьте свой слой '07_phase3' / '08_launch' / '99_archive'.
// 01_raw намеренно НЕ индексируется целиком: канонический поток требует ходить через 02_sources
// (короткие summary вместо сырых артефактов). Если нужно — добавьте сюда и удалите из SKIP_DIRS.
export const INDEXABLE_LAYERS = [
  '00_context',
  '02_sources',
  '03_wiki',
  '04_synthesis',
  '05_decisions',
  '06_outputs',
];

// Кэш для @xenova/transformers — кладём рядом, чтобы не загрязнять ~/.cache.
env.cacheDir = resolve(here, '.transformers-cache');
env.allowLocalModels = true;
env.useBrowserCache = false;

// ---------- chunker ----------

/**
 * Разбивает Markdown-текст на чанки.
 * Алгоритм:
 *   1. Срезает YAML frontmatter (---...---), но добавляет его сжатый «type/owner/date/tags» в каждый чанк как hint.
 *   2. Режет по H1/H2/H3 (## и ###). Заголовок включается в чанк.
 *   3. Если секция > MAX_CHUNK_CHARS — дробит по абзацам, сохраняя заголовок в начале каждого подчанка.
 *   4. Пропускает чанки < MIN_CHUNK_CHARS (мусор).
 *
 * Возвращает массив { heading, text, charStart, charEnd, lineStart }.
 */
export function chunkMarkdown(text) {
  const { body, hint, headerOffset } = stripFrontmatter(text);
  const lines = body.split('\n');

  // Соберём индексы строк с заголовками H1/H2/H3.
  const headingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s+\S/.test(lines[i])) headingIdx.push(i);
  }

  // Секции: от заголовка до следующего того же или старшего уровня, либо до конца файла.
  // Упрощение: режем просто между ЛЮБЫМИ заголовками, без иерархии.
  const sections = [];
  if (headingIdx.length === 0) {
    sections.push({ heading: '(no-heading)', lineStart: 0, body: body });
  } else {
    if (headingIdx[0] > 0) {
      const preamble = lines.slice(0, headingIdx[0]).join('\n').trim();
      if (preamble) sections.push({ heading: '(preamble)', lineStart: 0, body: preamble });
    }
    for (let h = 0; h < headingIdx.length; h++) {
      const from = headingIdx[h];
      const to = headingIdx[h + 1] ?? lines.length;
      const heading = lines[from].replace(/^#{1,3}\s+/, '').trim();
      const body = lines.slice(from, to).join('\n').trim();
      sections.push({ heading, lineStart: from, body });
    }
  }

  // Внутри каждой секции дробим, если слишком большая.
  const chunks = [];
  let charCursor = 0;
  for (const section of sections) {
    const pieces = splitLong(section.body, MAX_CHUNK_CHARS);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (trimmed.length < MIN_CHUNK_CHARS) continue;
      chunks.push({
        heading: section.heading,
        text: hint ? `${hint}\n\n${trimmed}` : trimmed,
        rawText: trimmed,
        charStart: charCursor,
        charEnd: charCursor + trimmed.length,
        lineStart: section.lineStart + headerOffset + 1, // 1-based для удобства
      });
      charCursor += trimmed.length;
    }
  }

  return chunks;
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return { body: text, hint: '', headerOffset: 0 };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { body: text, hint: '', headerOffset: 0 };
  const fm = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  const headerOffset = text.slice(0, end + 4).split('\n').length - 1;

  // Из frontmatter берём ключи type/owner/date/tags/status — это семантические hint'ы.
  const want = ['type', 'owner', 'date', 'tags', 'status', 'domain', 'segment', 'confidence'];
  const found = [];
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/i);
    if (m && want.includes(m[1])) {
      found.push(`${m[1]}=${m[2].trim()}`);
    }
  }
  const hint = found.length ? `[meta: ${found.join('; ')}]` : '';
  return { body, hint, headerOffset };
}

function splitLong(text, maxChars) {
  if (text.length <= maxChars) return [text];
  // Режем по двойному переносу (абзацы). Если абзац всё ещё длинный — по одному переносу.
  const paragraphs = text.split(/\n\s*\n/);
  const out = [];
  let buf = '';
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      // Длиннющий абзац — режем по строкам.
      if (buf) { out.push(buf); buf = ''; }
      const lines = p.split('\n');
      let lbuf = '';
      for (const line of lines) {
        if ((lbuf + '\n' + line).length > maxChars && lbuf) {
          out.push(lbuf);
          lbuf = line;
        } else {
          lbuf = lbuf ? `${lbuf}\n${line}` : line;
        }
      }
      if (lbuf) out.push(lbuf);
      continue;
    }
    if ((buf + '\n\n' + p).length > maxChars && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  // Жёсткий резорт: кусок без переносов длиннее лимита (напр. одно слово/URL) — режем по символам,
  // иначе модель молча обрежет хвост на 512 токенах при индексации.
  const hard = [];
  for (const piece of out) {
    if (piece.length <= maxChars) { hard.push(piece); continue; }
    for (let i = 0; i < piece.length; i += maxChars) hard.push(piece.slice(i, i + maxChars));
  }
  return hard;
}

// ---------- embedder ----------

let _embedder = null;

export async function createEmbedder() {
  if (_embedder) return _embedder;
  // feature-extraction pipeline для предложений; e5 ожидает префикс.
  const pipe = await pipeline('feature-extraction', EMBED_MODEL, { quantized: true });
  _embedder = async (texts) => {
    const arr = Array.isArray(texts) ? texts : [texts];
    const out = await pipe(arr, { pooling: 'mean', normalize: true });
    // out — Tensor [N, dim]; возвращаем массив Float32Array длиной dim.
    const result = [];
    const data = out.data;
    const dim = out.dims[out.dims.length - 1];
    if (dim !== EMBED_DIM) {
      throw new Error(`Unexpected embed dim ${dim}, expected ${EMBED_DIM}`);
    }
    for (let i = 0; i < arr.length; i++) {
      result.push(new Float32Array(data.slice(i * dim, (i + 1) * dim)));
    }
    return result;
  };
  return _embedder;
}

// ---------- db ----------

export function openDb(path = DB_PATH) {
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      heading TEXT,
      line_start INTEGER,
      text TEXT NOT NULL,
      layer TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
    CREATE INDEX IF NOT EXISTS idx_chunks_layer ON chunks(layer);

    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      embedding float[${EMBED_DIM}]
    );

    -- FTS5 для BM25-канала гибридного поиска.
    -- Contentless нельзя: нам нужны snippet и фильтр по layer — храним текст копией.
    -- unicode61 + remove_diacritics 1 = базовая нормализация (ё→е, regis). Без стеммера —
    -- для русского лучше работает дополнение vector-каналом (см. searchHybrid).
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      text,
      tokenize='unicode61 remove_diacritics 1'
    );

    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime INTEGER NOT NULL,
      chunks INTEGER NOT NULL
    );

    -- Связи между документами. Заполняется при reindex из frontmatter related: и из
    -- inline [[путь]] (если введём в P2.6). Используется для backlinks и потенциально
    -- как граф-сигнал в hybrid retrieval.
    CREATE TABLE IF NOT EXISTS links (
      src TEXT NOT NULL,         -- нормализованный путь файла-источника
      dst TEXT NOT NULL,         -- нормализованный путь файла-цели
      type TEXT NOT NULL,        -- 'related' (frontmatter) | 'wiki' (inline [[]])
      PRIMARY KEY (src, dst, type)
    );
    CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst);
    CREATE INDEX IF NOT EXISTS idx_links_src ON links(src);
  `);
  return db;
}

export function deleteFileChunks(db, file) {
  const ids = db.prepare('SELECT id FROM chunks WHERE file = ?').all(file).map((r) => r.id);
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  // sqlite-vec требует BigInt для rowid-параметров (см. insertChunk).
  const bigIds = ids.map((x) => BigInt(x));
  db.prepare(`DELETE FROM vec_chunks WHERE rowid IN (${placeholders})`).run(...bigIds);
  db.prepare(`DELETE FROM fts_chunks WHERE rowid IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).run(...ids);
  return ids.length;
}

export function insertChunk(db, { file, mtime, heading, lineStart, text, layer, embedding }) {
  const info = db.prepare(
    'INSERT INTO chunks (file, mtime, heading, line_start, text, layer) VALUES (?,?,?,?,?,?)',
  ).run(file, mtime, heading, lineStart, text, layer);
  // sqlite-vec 0.1.x требует rowid именно как BigInt при параметризованном INSERT (Number → ошибка).
  const rowid = BigInt(info.lastInsertRowid);
  const json = floatArrayToJson(embedding);
  db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, vec_f32(?))').run(rowid, json);
  // FTS5: rowid = chunks.id (обычное число — FTS5 принимает Number).
  db.prepare('INSERT INTO fts_chunks (rowid, text) VALUES (?, ?)').run(Number(rowid), text);
  return Number(rowid);
}

function floatArrayToJson(arr) {
  // Аналогично JSON.stringify(Array.from(arr)), но без overhead создания обычного массива.
  let s = '[';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) s += ',';
    s += arr[i].toString();
  }
  s += ']';
  return s;
}

export function upsertFileRow(db, path, mtime, chunkCount) {
  db.prepare('INSERT OR REPLACE INTO files (path, mtime, chunks) VALUES (?,?,?)').run(path, mtime, chunkCount);
}

export function getFileMtime(db, path) {
  const r = db.prepare('SELECT mtime FROM files WHERE path = ?').get(path);
  return r ? r.mtime : 0;
}

export function searchVec(db, queryEmbedding, { topK = 10, layer = null } = {}) {
  // Кандидаты — top-K по vec, потом join с chunks для текста и фильтрации по layer.
  // sqlite-vec не умеет JOIN в одном запросе с WHERE по другой таблице,
  // поэтому берём с запасом и фильтруем в JS.
  const overhead = layer ? Math.max(topK * 5, 50) : topK;
  const matches = db.prepare(
    'SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH vec_f32(?) ORDER BY distance LIMIT ?',
  ).all(floatArrayToJson(queryEmbedding), overhead);
  if (matches.length === 0) return [];

  const ids = matches.map((m) => Number(m.rowid));
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, file, heading, line_start, text, layer FROM chunks WHERE id IN (${placeholders})`,
  ).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const results = [];
  for (const m of matches) {
    const row = byId.get(Number(m.rowid));
    if (!row) continue;
    if (layer && row.layer !== layer) continue;
    results.push({ ...row, distance: m.distance, similarity: 1 - m.distance / 2 });
    if (results.length >= topK) break;
  }
  return results;
}

// ---------- BM25 (FTS5) ----------

/**
 * BM25-поиск по FTS5. Возвращает массив { id, file, heading, line_start, text, layer, score, rank }.
 * Запрос конвертируем в OR-форму: «NRR ARR» → «"NRR" OR "ARR"». Это повышает recall на
 * терминологических запросах с несколькими словами (иначе FTS5-AND даёт пусто).
 *
 * FTS5 bm25() возвращает отрицательное число (чем меньше, тем релевантнее). Превращаем в
 * положительный score = -rank для удобства сортировки и логов.
 */
export function searchBM25(db, queryText, { topK = 10, layer = null } = {}) {
  const ftsQuery = buildFtsOrQuery(queryText);
  if (!ftsQuery) return [];
  const overhead = layer ? Math.max(topK * 5, 50) : topK;
  let matches;
  try {
    matches = db.prepare(
      'SELECT rowid, bm25(fts_chunks) AS rank FROM fts_chunks WHERE fts_chunks MATCH ? ORDER BY rank LIMIT ?',
    ).all(ftsQuery, overhead);
  } catch (e) {
    // Невалидный FTS-запрос (спецсимвол) ожидаем → []; прочие ошибки (повреждённый индекс,
    // ошибка схемы) логируем в stderr, чтобы деградация hybrid→vector не была невидимой.
    if (!/fts5|syntax|match|malformed|near /i.test(String(e && e.message))) {
      console.error(`[bm25] FTS5 error: ${e && e.message}`);
    }
    return [];
  }
  if (matches.length === 0) return [];

  const ids = matches.map((m) => Number(m.rowid));
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, file, heading, line_start, text, layer FROM chunks WHERE id IN (${placeholders})`,
  ).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const results = [];
  for (const m of matches) {
    const row = byId.get(Number(m.rowid));
    if (!row) continue;
    if (layer && row.layer !== layer) continue;
    results.push({ ...row, rank: m.rank, score: -m.rank });
    if (results.length >= topK) break;
  }
  return results;
}

// Превращает «NRR ARR-cohort» → «"NRR" OR "ARR-cohort"».
// Каждый токен оборачиваем в "..." — это в FTS5 значит «литеральная фраза», что снимает
// проблемы со спецсимволами (-, /, : etc.). Длина < 2 символов отбрасывается (стоп-шум).
function buildFtsOrQuery(text) {
  const clean = text
    .split(/\s+/)
    .map((t) => t.replace(/^["'`]+|["'`]+$/g, '').trim())
    .filter(Boolean);
  // Обычно отбрасываем 1-символьный шум; но если ВЕСЬ запрос состоит из коротких
  // токенов (RU-буква, аббревиатура) — не теряем BM25-канал целиком.
  let tokens = clean.filter((t) => t.length >= 2);
  if (tokens.length === 0) tokens = clean;
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// ---------- Hybrid (RRF) ----------

/**
 * Reciprocal Rank Fusion над vector + BM25 списками.
 *   score(doc) = Σ_i weight_i / (k + rank_i)
 * Канонический k=60 (Cormack et al. 2009). Веса 1.0 / 1.0 — нейтральные, можно тюнить
 * через опции, но дефолт хорошо работает для смешанных русско/английских запросов в KB.
 *
 * Принимает уже посчитанные списки vecResults и bm25Results (для переиспользования
 * embedder в одном вызове). Возвращает топ-K объединённых результатов с полем `fused`
 * (RRF score) и breakdown { vec_rank, bm25_rank, vec_sim, bm25_score }.
 */
export function fuseRRF(vecResults, bm25Results, { topK = 10, k = 60, vecWeight = 1.0, bm25Weight = 1.0 } = {}) {
  const byId = new Map();
  vecResults.forEach((r, i) => {
    byId.set(r.id, {
      ...r,
      _vec_rank: i + 1,
      _vec_sim: r.similarity,
      _bm25_rank: null,
      _bm25_score: null,
    });
  });
  bm25Results.forEach((r, i) => {
    const existing = byId.get(r.id);
    if (existing) {
      existing._bm25_rank = i + 1;
      existing._bm25_score = r.score;
    } else {
      byId.set(r.id, {
        ...r,
        _vec_rank: null,
        _vec_sim: null,
        _bm25_rank: i + 1,
        _bm25_score: r.score,
      });
    }
  });

  const fused = [];
  for (const r of byId.values()) {
    let score = 0;
    if (r._vec_rank !== null) score += vecWeight / (k + r._vec_rank);
    if (r._bm25_rank !== null) score += bm25Weight / (k + r._bm25_rank);
    fused.push({
      id: r.id,
      file: r.file,
      heading: r.heading,
      line_start: r.line_start,
      text: r.text,
      layer: r.layer,
      fused: score,
      vec_rank: r._vec_rank,
      vec_sim: r._vec_sim,
      bm25_rank: r._bm25_rank,
      bm25_score: r._bm25_score,
    });
  }
  fused.sort((a, b) => b.fused - a.fused);
  return fused.slice(0, topK);
}

// ---------- links / backlinks ----------

/**
 * Парсит frontmatter и возвращает список путей из поля related:.
 * Поддерживает два YAML-синтаксиса:
 *   related: [a.md, b.md]
 *   related:
 *     - a.md
 *     - b.md
 * Пути нормализуются: убирается ведущий слэш, обратные слэши → прямые.
 * Несуществующие файлы НЕ фильтруются (это работа kb-doctor).
 */
export function parseFrontmatterLinks(text) {
  if (!text.startsWith('---')) return [];
  const end = text.indexOf('\n---', 3);
  if (end < 0) return [];
  const fm = text.slice(3, end);
  const lines = fm.split('\n');

  const out = [];
  let inRelatedBlock = false;
  for (const line of lines) {
    // Inline-форма: related: [a, b, "c"]
    const inline = line.match(/^related:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const raw of inline[1].split(',')) {
        const cleaned = raw.replace(/^["'\s]+|["'\s]+$/g, '');
        const norm = normalizeRelPath(cleaned);
        if (norm) out.push(norm);
      }
      inRelatedBlock = false;
      continue;
    }
    // Block-form начало
    if (/^related:\s*$/.test(line)) {
      inRelatedBlock = true;
      continue;
    }
    if (inRelatedBlock) {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) {
        const cleaned = item[1].replace(/^["'\s]+|["'\s]+$/g, '');
        const norm = normalizeRelPath(cleaned);
        if (norm) out.push(norm);
      } else if (/^\S/.test(line)) {
        // Следующее frontmatter-поле — конец related-блока
        inRelatedBlock = false;
      }
    }
  }
  return Array.from(new Set(out));
}

function normalizeRelPath(p) {
  if (!p) return '';
  let s = p.replace(/\\/g, '/').trim();
  s = s.replace(/^\.\//, '');
  s = s.replace(/^\/+/, '');
  return s;
}

/**
 * Полностью переписывает связи файла-источника: удаляет существующие и вставляет новые.
 * Вызывается из index.mjs после успешной индексации файла.
 */
export function upsertLinks(db, src, links) {
  db.prepare('DELETE FROM links WHERE src = ?').run(src);
  if (!links || links.length === 0) return 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO links (src, dst, type) VALUES (?, ?, ?)');
  let n = 0;
  for (const link of links) {
    const dst = typeof link === 'string' ? link : link.dst;
    const type = typeof link === 'string' ? 'related' : (link.type || 'related');
    if (!dst) continue;
    const r = stmt.run(src, dst, type);
    n += r.changes;
  }
  return n;
}

export function getBacklinks(db, path) {
  const norm = normalizeRelPath(path);
  return db.prepare('SELECT src, type FROM links WHERE dst = ? ORDER BY src').all(norm);
}

export function getForwardLinks(db, path) {
  const norm = normalizeRelPath(path);
  return db.prepare('SELECT dst, type FROM links WHERE src = ? ORDER BY dst').all(norm);
}

// ---------- walker ----------

// Директории, в которые walker не заходит — внутри INDEXABLE_LAYERS.
// Добавьте сюда свои спецдиректории, если они попадают внутрь слоёв и не должны индексироваться.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.context',     // рабочая зона, gitignored
  '.remember',    // working memory
  '.claude',      // конфиги Claude Code
  'scripts',      // сам инструментарий не индексируем
  'docs',         // обычно служебная документация
]);

const ALLOWED_EXT = new Set(['.md']);

export function* walkMarkdown(rootDir = REPO_ROOT, layers = INDEXABLE_LAYERS) {
  for (const layer of layers) {
    const layerRoot = join(rootDir, layer);
    let st;
    try { st = statSync(layerRoot); } catch { continue; }
    if (!st.isDirectory()) continue;
    yield* walkDir(layerRoot, layer, rootDir);
  }
}

function* walkDir(dir, layer, rootDir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, layer, rootDir);
    } else if (entry.isFile() && ALLOWED_EXT.has(extname(entry.name))) {
      const st = statSync(full);
      yield {
        absPath: full,
        relPath: relative(rootDir, full),
        layer,
        mtime: Math.floor(st.mtimeMs),
      };
    }
  }
}

export function readFileSafe(absPath) {
  try { return readFileSync(absPath, 'utf8'); } catch { return ''; }
}
