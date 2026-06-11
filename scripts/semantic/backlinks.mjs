#!/usr/bin/env node
// backlinks.mjs — кто ссылается на файл (через frontmatter related:).
//
// Использование:
//   node scripts/semantic/backlinks.mjs 05_decisions/stage3-free-tier-design.md
//   node scripts/semantic/backlinks.mjs 05_decisions/stage3-free-tier-design.md --json
//   node scripts/semantic/backlinks.mjs 05_decisions/stage3-free-tier-design.md --forward  # покажет, на что ссылается сам файл
//
// Зачем: перед редактированием wiki/synthesis-файла полезно знать, кто на него опирается —
// чтобы при изменении смысла не сломать связи.

import { existsSync } from 'node:fs';
import { openDb, getBacklinks, getForwardLinks, DB_PATH } from './lib.mjs';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('Использование: node scripts/semantic/backlinks.mjs <path> [--json] [--forward]');
  process.exit(1);
}

let asJson = false;
let forward = false;
const positional = [];

for (const a of argv) {
  if (a === '--json') asJson = true;
  else if (a === '--forward') forward = true;
  else positional.push(a);
}

const target = positional[0];
if (!target) {
  console.error('Не указан путь.');
  process.exit(1);
}

if (!existsSync(DB_PATH)) {
  console.error(`[backlinks] БД не найдена: ${DB_PATH}.\nЗапустите: node scripts/semantic/index.mjs`);
  process.exit(1);
}

const db = openDb();
const rows = forward ? getForwardLinks(db, target) : getBacklinks(db, target);
db.close();

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const direction = forward ? 'forward (этот файл → ...)' : 'backlinks (... → этот файл)';
console.log(`\n[backlinks] ${target}   ${direction}\n`);

if (rows.length === 0) {
  console.log('  (связей не найдено)');
  process.exit(0);
}

for (const r of rows) {
  const other = forward ? r.dst : r.src;
  console.log(`  • ${other}   [${r.type}]`);
}
console.log('');
