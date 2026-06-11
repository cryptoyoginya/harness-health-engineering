#!/usr/bin/env node
// index.mjs — индексатор KB вашего проекта для семантического поиска.
//
// Использование:
//   node scripts/semantic/index.mjs              # инкрементальный апдейт (по mtime)
//   node scripts/semantic/index.mjs --full       # полная переиндексация (сначала очищает БД)
//   node scripts/semantic/index.mjs --layer 04_synthesis  # только один слой
//
// Что делает:
//   1. Обходит INDEXABLE_LAYERS (см. lib.mjs).
//   2. Для каждого MD-файла, если mtime > сохранённого — режет на чанки, эмбедит, пишет в БД.
//   3. Удаляет осиротевшие записи (файл удалён из FS).
//
// БД: .semantic-index.sqlite в корне репо (gitignored).

import { unlinkSync, existsSync } from 'node:fs';
import {
  chunkMarkdown,
  createEmbedder,
  PASSAGE_PREFIX,
  openDb,
  deleteFileChunks,
  insertChunk,
  upsertFileRow,
  getFileMtime,
  walkMarkdown,
  readFileSafe,
  parseFrontmatterLinks,
  upsertLinks,
  DB_PATH,
  REPO_ROOT,
  INDEXABLE_LAYERS,
} from './lib.mjs';

const args = process.argv.slice(2);
const isFull = args.includes('--full');
const layerArgIdx = args.indexOf('--layer');
const layerFilter = layerArgIdx >= 0 ? args[layerArgIdx + 1] : null;

if (layerFilter && !INDEXABLE_LAYERS.includes(layerFilter)) {
  console.error(`[index] --layer должен быть одним из: ${INDEXABLE_LAYERS.join(', ')}`);
  process.exit(1);
}

if (isFull && existsSync(DB_PATH)) {
  console.log(`[index] --full: удаляю ${DB_PATH}`);
  unlinkSync(DB_PATH);
  // WAL-файлы
  for (const suffix of ['-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

const t0 = Date.now();
console.log(`[index] загружаю модель multilingual-e5-small (первый запуск — скачивает ~120 MB)`);
const embed = await createEmbedder();
console.log(`[index] модель готова за ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const db = openDb();

const layers = layerFilter ? [layerFilter] : INDEXABLE_LAYERS;
const filesSeen = new Set();
let processedFiles = 0;
let skippedFiles = 0;
let totalChunks = 0;
const tStart = Date.now();

for (const file of walkMarkdown(REPO_ROOT, layers)) {
  filesSeen.add(file.relPath);
  const stored = getFileMtime(db, file.relPath);
  if (!isFull && stored >= file.mtime) {
    skippedFiles++;
    continue;
  }

  const text = readFileSafe(file.absPath);
  if (!text.trim()) {
    upsertFileRow(db, file.relPath, file.mtime, 0);
    upsertLinks(db, file.relPath, []);
    continue;
  }

  const chunks = chunkMarkdown(text);
  const links = parseFrontmatterLinks(text);
  if (chunks.length === 0) {
    deleteFileChunks(db, file.relPath);
    upsertFileRow(db, file.relPath, file.mtime, 0);
    upsertLinks(db, file.relPath, links);
    continue;
  }

  // Эмбеддим батчами (e5-small быстрая, но всё-таки)
  const BATCH = 16;
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map((c) => PASSAGE_PREFIX + c.text);
    const result = await embed(batch);
    embeddings.push(...result);
  }

  const tx = db.transaction(() => {
    deleteFileChunks(db, file.relPath);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      insertChunk(db, {
        file: file.relPath,
        mtime: file.mtime,
        heading: c.heading,
        lineStart: c.lineStart,
        text: c.rawText,
        layer: file.layer,
        embedding: embeddings[i],
      });
    }
    upsertFileRow(db, file.relPath, file.mtime, chunks.length);
    upsertLinks(db, file.relPath, links);
  });
  tx();

  processedFiles++;
  totalChunks += chunks.length;
  const dt = ((Date.now() - tStart) / 1000).toFixed(1);
  process.stdout.write(`\r[index] processed=${processedFiles} skipped=${skippedFiles} chunks=${totalChunks} elapsed=${dt}s`);
}

// Удаляем осиротевшие файлы (если не делаем layer-filter — иначе можем дропнуть чужие)
if (!layerFilter) {
  const known = db.prepare('SELECT path FROM files').all().map((r) => r.path);
  let orphanCount = 0;
  for (const path of known) {
    if (!filesSeen.has(path)) {
      deleteFileChunks(db, path);
      db.prepare('DELETE FROM files WHERE path = ?').run(path);
      db.prepare('DELETE FROM links WHERE src = ?').run(path);
      orphanCount++;
    }
  }
  if (orphanCount > 0) console.log(`\n[index] удалено осиротевших файлов: ${orphanCount}`);
}

const totalFiles = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
const totalChunksDb = db.prepare('SELECT COUNT(*) as c FROM chunks').get().c;
const dt = ((Date.now() - tStart) / 1000).toFixed(1);
process.stdout.write('\n');
console.log(`[index] готово: обработано ${processedFiles} файлов (пропущено ${skippedFiles}), записано ${totalChunks} новых чанков за ${dt}s.`);
console.log(`[index] всего в БД: ${totalFiles} файлов, ${totalChunksDb} чанков. БД: ${DB_PATH}`);

db.close();
