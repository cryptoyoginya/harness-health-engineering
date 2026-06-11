#!/usr/bin/env node
// session-start-context.mjs — SessionStart hook.
// Инжектит в начало сессии оперативный контекст проекта:
//   • git status + последние коммиты
//   • дифф-stat относительно origin/main (если есть)
//   • последние 20 строк .remember/now.md (если есть)
//
// Хук пишет в stdout — Claude Code получит это как additionalContext.
// Никогда не блокирует.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  return (r.status === 0 ? r.stdout : '').trim();
}

function readSafe(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

const projectName = basename(root);
const lines = [`# Контекст проекта ${projectName} (auto, SessionStart)`, ''];

// ─── git ──────────────────────────────────────────────────────────────
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const status = run('git', ['status', '-s']);
const lastCommits = run('git', ['log', '-5', '--oneline']);
const diffstat = run('git', ['diff', '--stat', 'origin/main...HEAD']);

if (branch) {
  lines.push('## Git');
  lines.push(`- Ветка: \`${branch}\``);
  if (status) {
    lines.push('- Незакоммиченные изменения:');
    lines.push('```');
    lines.push(status.split('\n').slice(0, 12).join('\n'));
    lines.push('```');
  } else {
    lines.push('- Рабочая копия чистая.');
  }
  if (diffstat) {
    lines.push('- Дифф относительно origin/main:');
    lines.push('```');
    lines.push(diffstat.split('\n').slice(0, 12).join('\n'));
    lines.push('```');
  }
  if (lastCommits) {
    lines.push('- Последние коммиты:');
    lines.push('```');
    lines.push(lastCommits);
    lines.push('```');
  }
  lines.push('');
}

// ─── .remember/now.md ────────────────────────────────────────────────
const now = readSafe(resolve(root, '.remember', 'now.md'));
if (now.trim()) {
  const nowLines = now.split('\n').filter((l) => l.trim() && !l.startsWith('<!--')).slice(0, 20);
  if (nowLines.length > 0) {
    lines.push('## .remember/now.md (выдержка)');
    lines.push('```');
    lines.push(nowLines.join('\n'));
    lines.push('```');
    lines.push('');
  }
}

process.stdout.write(lines.join('\n') + '\n');
process.exit(0);
