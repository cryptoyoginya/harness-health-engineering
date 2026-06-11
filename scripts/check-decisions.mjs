#!/usr/bin/env node
// check-decisions.mjs — PreToolUse hook для Write/Edit в /05_decisions/.
// Гарантирует, что новая или обновлённая decision-карточка содержит:
//   1. метку `DECISION:`
//   2. хотя бы одну ссылку на источник: `[source: /02_sources/...]`,
//      `[source: /04_synthesis/...]`, либо упоминание пути `/04_synthesis/` или `/02_sources/`.
//
// Hook читает JSON со stdin:
//   { tool_name, tool_input: { file_path, content?, new_string?, old_string? } }
// Возвращает exit code 0 (allow) или 2 (block; stderr → агенту).
//
// Изъятия (не проверяем): decision-log.md, rejected-options.md, assumptions.md,
// файлы в /99_templates/ и сам /05_decisions/ без .md.

import { readFileSync, existsSync } from 'node:fs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const raw = readStdin();
if (!raw.trim()) {
  // Без payload — пропускаем (например, ручной вызов).
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  // Не JSON → не наша зона ответственности.
  process.exit(0);
}

const tool = payload.tool_name || '';
const input = payload.tool_input || {};
const filePath = input.file_path || '';

// Триггер только на Edit/Write
if (!/^(Edit|Write|MultiEdit)$/.test(tool)) process.exit(0);
if (!filePath) process.exit(0);

// Триггер только на /05_decisions/*.md
const isDecisionPath = /\/05_decisions\/[^/]+\.md$/.test(filePath);
if (!isDecisionPath) process.exit(0);

// Исключения
const basename = filePath.split('/').pop();
const exemptions = new Set([
  'decision-log.md',
  'rejected-options.md',
  'assumptions.md',
  'README.md',
]);
if (exemptions.has(basename)) process.exit(0);
if (filePath.includes('/99_templates/')) process.exit(0);

// Собираем «итоговый текст» для проверки.
// Для Write — content; для Edit — текущий файл + new_string; для MultiEdit — текущий + все new_strings.
let candidateText = '';

if (tool === 'Write' && typeof input.content === 'string') {
  candidateText = input.content;
} else if (tool === 'Edit') {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  candidateText = existing + '\n' + (input.new_string || '');
} else if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  candidateText = existing + '\n' + input.edits.map((e) => e.new_string || '').join('\n');
}

const hasDecisionLabel = /\bDECISION:/i.test(candidateText);
const hasSourceLink =
  /\[source:\s*\/(02_sources|04_synthesis|01_raw|03_wiki|05_decisions)\//i.test(candidateText) ||
  /\/04_synthesis\//.test(candidateText) ||
  /\/02_sources\//.test(candidateText);

const errors = [];
if (!hasDecisionLabel) {
  errors.push('Не найдена метка `DECISION:` (требование AGENTS.md «Required labels»).');
}
if (!hasSourceLink) {
  errors.push(
    'Не найдена ссылка на источник: ожидается `[source: /02_sources/...]`, `[source: /04_synthesis/...]` ' +
      'или упоминание `/04_synthesis/` / `/02_sources/` (требование AGENTS.md «Required citation style»).',
  );
}

if (errors.length === 0) process.exit(0);

const msg = [
  `[check-decisions] Блокировка записи в ${filePath}.`,
  'Чтобы избежать создания decision-карточки без evidence:',
  ...errors.map((e) => `  • ${e}`),
  '',
  'Рекомендация: следовать `skills/skill-decision-log.md` и шаблону `99_templates/decision-template.md`.',
  'Если это не decision-карточка (например, индекс/обновление другого формата) — переименуйте файл',
  'или добавьте в список исключений в `scripts/check-decisions.mjs`.',
].join('\n');

process.stderr.write(msg + '\n');
process.exit(2);
