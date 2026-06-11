#!/usr/bin/env node
// kb-doctor.mjs — health-check KB (по аналогии с gbrain doctor).
//
// Использование:
//   node scripts/kb-doctor.mjs                 # человекочитаемый отчёт
//   node scripts/kb-doctor.mjs --json          # JSON для CI/pipe
//   node scripts/kb-doctor.mjs --fix-dryrun    # показать команды для фиксов (не выполняет)
//
// Проверки (без LLM, без сети):
//   1. missing-frontmatter — файлы в значимых слоях без обязательных полей
//   2. broken-related      — frontmatter related: указывает на несуществующий путь
//   3. orphan              — файл, на который никто не ссылается (только для wiki/synthesis/decisions)
//   4. stale-synthesis     — synthesis-файлы старше 60 дней
//   5. ghost-in-index      — записи в links/files для несуществующих файлов на диске
//
// Источник правды: файловая система + indexed links (если БД есть).

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, extname, dirname, normalize as pnormalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(here, '..');
const DB_PATH = resolve(REPO_ROOT, '.semantic-index.sqlite');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const fixDryrun = argv.includes('--fix-dryrun');

const STALE_DAYS = 60;
const NOW = Date.now();

// Слои и их правила. Подстройте под структуру своего проекта.
//   requireFm     — должен ли файл иметь YAML frontmatter
//   requireFields — обязательные поля frontmatter (ругаемся если их нет)
//   staleCheck    — проверять ли возраст файла (вычислять stale флаг)
const LAYERS = {
  '00_context':   { requireFm: false, requireFields: [],                 staleCheck: false },
  '01_raw':       { requireFm: false, requireFields: [],                 staleCheck: false },
  '02_sources':   { requireFm: true,  requireFields: ['type'],           staleCheck: false },
  '03_wiki':      { requireFm: true,  requireFields: ['type'],           staleCheck: false },
  '04_synthesis': { requireFm: true,  requireFields: ['type'],           staleCheck: true  },
  '05_decisions': { requireFm: true,  requireFields: ['type'],           staleCheck: false },
  '06_outputs':   { requireFm: true,  requireFields: ['type', 'version'], staleCheck: false },
};

const EXEMPT_BASENAMES = new Set(['readme.md', 'index.md', 'nav.md', '_toc.md']);

// Слои, где orphan имеет смысл (если на synthesis/wiki/decisions никто не ссылается — подозрительно).
const ORPHAN_CHECK_LAYERS = new Set(['03_wiki', '04_synthesis', '05_decisions']);

// ---------- walk ----------

function* walkMd(layer) {
  const root = join(REPO_ROOT, layer);
  if (!existsSync(root)) return;
  yield* walkDir(root);
}

function* walkDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDir(full);
    else if (entry.isFile() && extname(entry.name) === '.md') yield full;
  }
}

// ---------- frontmatter ----------

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { fm: null, fields: {} };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: null, fields: {} };
  const fm = text.slice(3, end);
  const fields = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([a-z_]+)\s*:\s*(.*)$/i);
    if (m) fields[m[1].toLowerCase()] = m[2].trim();
  }
  return { fm, fields };
}

function parseRelatedFromText(text) {
  const { fm } = parseFrontmatter(text);
  if (!fm) return [];
  const lines = fm.split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    const inline = line.match(/^related:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const raw of inline[1].split(',')) {
        const c = raw.replace(/^["'\s]+|["'\s]+$/g, '');
        if (c) out.push(normalize(c));
      }
      inBlock = false;
      continue;
    }
    if (/^related:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) {
        const c = item[1].replace(/^["'\s]+|["'\s]+$/g, '');
        if (c) out.push(normalize(c));
      } else if (/^\S/.test(line)) inBlock = false;
    }
  }
  return Array.from(new Set(out));
}

function normalize(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

// ---------- сбор фактов ----------

const issues = {
  missingFrontmatter: [],
  brokenRelated: [],
  orphan: [],
  staleSynthesis: [],
  ghostInIndex: [],
};

const allFiles = new Map(); // relPath → { layer, fields, related, mtimeMs }
const backlinksByDst = new Map(); // dst → Set<src>

for (const layer of Object.keys(LAYERS)) {
  for (const absPath of walkMd(layer)) {
    const rel = relative(REPO_ROOT, absPath);
    const basename = rel.split('/').pop().toLowerCase();
    if (EXEMPT_BASENAMES.has(basename)) continue;

    const text = readFileSync(absPath, 'utf8');
    const { fm, fields } = parseFrontmatter(text);
    const related = parseRelatedFromText(text);
    const stat = statSync(absPath);

    allFiles.set(rel, {
      layer,
      fields,
      related,
      mtimeMs: stat.mtimeMs,
    });

    for (const dst of related) {
      if (!backlinksByDst.has(dst)) backlinksByDst.set(dst, new Set());
      backlinksByDst.get(dst).add(rel);
    }

    const rules = LAYERS[layer];

    // 1. missing frontmatter / fields
    if (rules.requireFm) {
      if (!fm) {
        issues.missingFrontmatter.push({ file: rel, layer, missing: ['<frontmatter целиком>'] });
      } else {
        const missing = rules.requireFields.filter((f) => !fields[f]);
        if (missing.length > 0) {
          issues.missingFrontmatter.push({ file: rel, layer, missing });
        }
      }
    }

    // 4. stale synthesis (sub-checks ниже после полного обхода — нужно знать mtime всех)
    if (rules.staleCheck) {
      const ageDays = Math.floor((NOW - stat.mtimeMs) / 86_400_000);
      if (ageDays >= STALE_DAYS) {
        issues.staleSynthesis.push({ file: rel, age_days: ageDays });
      }
    }
  }
}

// 2. broken related — резолвим путь либо от REPO_ROOT (абсолютный),
//    либо от директории src (относительный). URL'ы помечаем как «url» и
//    пытаемся вытащить из них путь /blob/<branch>/<path>.
// 2. broken related — резолвим в порядке:
//   а) URL → если github.com/.../blob/<branch>/<path> — пробуем как путь от корня; иначе skip (external)
//   б) Путь с ведущим /  → от REPO_ROOT
//   в) Иначе:
//      ① как от REPO_ROOT (для `AGENTS.md`, `tools/...`, `03_wiki/...`);
//      ② если не нашёлся — как relative от dirname(src).
//   Берём первый существующий вариант, в репорт пишем оба пробных пути.
function resolveRelated(src, dst) {
  if (/^https?:\/\//i.test(dst)) {
    const m = dst.match(/github\.com\/[^/]+\/[^/]+\/(?:blob|tree)\/[^/]+\/(.+)$/);
    if (m) return [{ kind: 'github-url', resolved: pnormalize(m[1]) }];
    return [{ kind: 'external-url', resolved: dst, skip: true }];
  }
  if (dst.startsWith('/')) {
    return [{ kind: 'absolute', resolved: dst.replace(/^\/+/, '') }];
  }
  const fromRoot = pnormalize(dst);
  const fromDir = pnormalize(join(dirname(src), dst));
  return [
    { kind: 'from-root', resolved: fromRoot },
    { kind: 'from-src-dir', resolved: fromDir },
  ];
}

for (const [src, meta] of allFiles) {
  for (const dst of meta.related) {
    const candidates = resolveRelated(src, dst);
    if (candidates[0].skip) continue;
    const hit = candidates.find((c) => existsSync(join(REPO_ROOT, c.resolved)));
    if (!hit) {
      issues.brokenRelated.push({
        src,
        dst,
        tried: candidates.map((c) => c.resolved),
      });
    }
  }
}

// 3. orphan — только для wiki/synthesis/decisions, файл без backlinks И без forward-links
for (const [rel, meta] of allFiles) {
  if (!ORPHAN_CHECK_LAYERS.has(meta.layer)) continue;
  // Living-документы (status: living) — точки входа/журналы (open-questions, contradictions):
  // на них не обязаны ссылаться, это не осиротевшие узлы.
  if (String(meta.fields?.status || '').toLowerCase() === 'living') continue;
  const hasBacklinks = backlinksByDst.has(rel) && backlinksByDst.get(rel).size > 0;
  const hasForward = meta.related.length > 0;
  // README/index/_toc уже отфильтрованы выше.
  if (!hasBacklinks && !hasForward) {
    issues.orphan.push({ file: rel, layer: meta.layer });
  }
}

// 5. ghost-in-index — если есть БД, сверяем files.path с FS
let ghostCount = 0;
if (existsSync(DB_PATH)) {
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(DB_PATH, { readonly: true });
    const dbFiles = db.prepare('SELECT path FROM files').all().map((r) => r.path);
    for (const p of dbFiles) {
      if (!existsSync(join(REPO_ROOT, p))) {
        issues.ghostInIndex.push({ file: p, source: 'files' });
        ghostCount++;
      }
    }
    const linkSrcs = db.prepare('SELECT DISTINCT src FROM links').all().map((r) => r.src);
    for (const p of linkSrcs) {
      if (!existsSync(join(REPO_ROOT, p))) {
        issues.ghostInIndex.push({ file: p, source: 'links' });
      }
    }
    db.close();
  } catch (e) {
    // БД есть, но не открывается — пропустим.
  }
}

// ---------- вывод ----------

const summary = {
  total_files: allFiles.size,
  missing_frontmatter: issues.missingFrontmatter.length,
  broken_related: issues.brokenRelated.length,
  orphans: issues.orphan.length,
  stale_synthesis: issues.staleSynthesis.length,
  ghost_in_index: issues.ghostInIndex.length,
};

if (asJson) {
  console.log(JSON.stringify({ summary, issues }, null, 2));
  process.exit(0);
}

console.log('');
console.log('═'.repeat(60));
console.log('  kb-doctor — health-check KB');
console.log('═'.repeat(60));
console.log('');
console.log(`  Файлов проверено:        ${summary.total_files}`);
console.log(`  Missing frontmatter:     ${summary.missing_frontmatter}`);
console.log(`  Broken related:          ${summary.broken_related}`);
console.log(`  Orphan-страницы:         ${summary.orphans}`);
console.log(`  Stale synthesis (>${STALE_DAYS}д):  ${summary.stale_synthesis}`);
console.log(`  Ghost в индексе:         ${summary.ghost_in_index}`);
console.log('');

const totalIssues = Object.values(summary).reduce((s, v) => s + v, 0) - summary.total_files;
if (totalIssues === 0) {
  console.log('  ✓ Все проверки пройдены.');
  console.log('');
  process.exit(0);
}

function section(title, items, render) {
  if (items.length === 0) return;
  console.log('─'.repeat(60));
  console.log(`  ${title}  (${items.length})`);
  console.log('─'.repeat(60));
  for (const it of items.slice(0, 20)) console.log('  • ' + render(it));
  if (items.length > 20) console.log(`  … ещё ${items.length - 20}`);
  console.log('');
}

section('Missing frontmatter', issues.missingFrontmatter, (i) =>
  `${i.file}   missing: ${i.missing.join(', ')}`);

section('Broken related (указывают в никуда)', issues.brokenRelated, (i) =>
  `${i.src}   →   ${i.dst}   (пробовали: ${i.tried.join(' | ')})`);

section('Orphan-страницы (нет related ни туда, ни оттуда)', issues.orphan, (i) =>
  `${i.file}   [${i.layer}]`);

section(`Stale synthesis (>${STALE_DAYS} дней)`, issues.staleSynthesis, (i) =>
  `${i.file}   возраст=${i.age_days}д`);

section('Ghost в индексе (БД помнит, FS — нет)', issues.ghostInIndex, (i) =>
  `${i.file}   [из ${i.source}]   → запустить: node scripts/semantic/index.mjs`);

if (fixDryrun) {
  console.log('─'.repeat(60));
  console.log('  Подсказки по фиксу');
  console.log('─'.repeat(60));
  if (issues.ghostInIndex.length > 0) {
    console.log('  • Ghost в индексе чистится переиндексацией:');
    console.log('      node scripts/semantic/index.mjs');
  }
  if (issues.brokenRelated.length > 0) {
    console.log('  • Broken related — открой каждый src и поправь путь в frontmatter related:');
  }
  if (issues.orphan.length > 0) {
    console.log('  • Orphans — либо добавь файл в related: соседнего документа,');
    console.log('    либо удали как устаревший. Для wiki часто нужно встроить в /04_synthesis/.');
  }
  console.log('');
}

process.exit(totalIssues > 0 ? 1 : 0);
