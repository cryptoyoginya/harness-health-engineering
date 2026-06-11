#!/usr/bin/env node
// check-md-frontmatter.mjs — PreToolUse hook для Write/Edit/MultiEdit на .md.
//
// Логика мягкая (минимум false-positive):
//   • Если у файла есть frontmatter (--- … ---) — он должен содержать поля, перечисленные
//     для слоя в LAYER_RULES ниже.
//   • Если frontmatter нет вообще — НЕ блокируем (не все .md обязаны быть артефактами:
//     README, index, временные заметки).
//
// Подстройте LAYER_RULES под структуру вашего проекта.

import { readFileSync, existsSync } from 'node:fs';

// Слой → требуемые поля frontmatter. Слой определяется по подстроке `/<key>/` в пути файла.
const LAYER_RULES = {
  '02_sources':   ['type'],
  '03_wiki':      ['type'],
  '04_synthesis': ['type'],
  '05_decisions': ['type'],
  '06_outputs':   ['type', 'version'],
};

const EXEMPT_BASENAMES = new Set(['readme.md', 'index.md', 'nav.md', '_toc.md', 'log.md']);

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

const raw = readStdin();
if (!raw.trim()) process.exit(0);

let payload;
try { payload = JSON.parse(raw); } catch { process.exit(0); }

const tool = payload.tool_name || '';
const input = payload.tool_input || {};
const filePath = input.file_path || '';

if (!/^(Write|Edit|MultiEdit)$/.test(tool)) process.exit(0);
if (!filePath) process.exit(0);
const isMd = /\.md$/i.test(filePath);
const isEvalYaml = /\/skills\/[^/]+\/evals\/[^/]+\.ya?ml$/i.test(filePath);
if (!isMd && !isEvalYaml) process.exit(0);

// Eval-case (жёсткие правила) валидируется ниже после чтения candidateText.

// Подбираем слой (только для .md)
let layerKey = null;
if (isMd) {
  for (const key of Object.keys(LAYER_RULES)) {
    if (filePath.includes(`/${key}/`)) { layerKey = key; break; }
  }
  if (!layerKey) process.exit(0);
}

const basename = filePath.split('/').pop().toLowerCase();
if (EXEMPT_BASENAMES.has(basename)) process.exit(0);

// Собираем «итоговый текст» после применения правки
let candidateText = '';
if (tool === 'Write' && typeof input.content === 'string') {
  candidateText = input.content;
} else if (tool === 'Edit') {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  candidateText = (input.new_string && input.old_string)
    ? existing.replace(input.old_string, input.new_string)
    : existing;
} else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
  let existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  for (const e of input.edits) {
    if (e.old_string && e.new_string) existing = existing.replace(e.old_string, e.new_string);
  }
  candidateText = existing;
}

// Без frontmatter — пропускаем (свободный документ)
const fmMatch = candidateText.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) {
  if (isEvalYaml) {
    process.stderr.write(`[check-md-frontmatter] ${filePath}: eval-case требует frontmatter с type/version/skill/grader.\n`);
    process.exit(2);
  }
  process.exit(0);
}

const fm = fmMatch[1];

// Для eval-case — фиксированный набор требований
if (isEvalYaml) {
  const EVAL_REQUIRED = ['type', 'version', 'skill', 'grader'];
  const missing = EVAL_REQUIRED.filter((f) => !new RegExp(`^\\s*${f}\\s*:`, 'm').test(fm));
  const typeMatch = fm.match(/^\s*type\s*:\s*(\S+)/m);
  if (typeMatch && typeMatch[1] !== 'eval-case') {
    process.stderr.write(
      `[check-md-frontmatter] ${filePath}: eval-case должен иметь type: eval-case (найдено: ${typeMatch[1]}).\n`,
    );
    process.exit(2);
  }
  if (missing.length === 0) process.exit(0);
  process.stderr.write(
    `[check-md-frontmatter] ${filePath}: eval-case требует ${EVAL_REQUIRED.join(', ')}. Отсутствуют: ${missing.join(', ')}.\n`,
  );
  process.exit(2);
}

const required = LAYER_RULES[layerKey];
const missing = required.filter((f) => !new RegExp(`^\\s*${f}\\s*:`, 'm').test(fm));

if (missing.length === 0) process.exit(0);

const msg = [
  `[check-md-frontmatter] Блокировка ${filePath}.`,
  '',
  `Слой /${layerKey}/ требует в frontmatter поля: ${required.join(', ')}.`,
  `Отсутствуют: ${missing.join(', ')}.`,
  '',
  'Пример минимального frontmatter:',
  '  ---',
  '  type: spec | wiki | decision | synthesis | source-summary',
  required.includes('version') ? '  version: v0.1' : '',
  '  ---',
  '',
  `Если это свободный документ без статуса артефакта — назовите файл одним из: ${[...EXEMPT_BASENAMES].join(', ')}.`,
].filter(Boolean).join('\n');

process.stderr.write(msg + '\n');
process.exit(2);
