// habits.mjs — реестр устойчивых привычек / базового режима (baseline).
// Что у пользователя УЖЕ есть постоянно: «15к шагов в день», «омега-3 несколько лет».
// Агент читает это как данность — не предлагает экспериментировать над тем, что уже устойчиво,
// и знает базу при разборе. Живёт в /00_context/habits.md (всегда в контексте).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './whoop/lib.mjs';

const FILE = join(ROOT, '00_context', 'habits.md');

function header(date) {
  return `---
type: context
status: living
date: ${date}
related:
  - /00_context/health-metrics.md
  - /03_wiki/health-supplements.md
---

# Привычки и базовый режим (baseline)

> Что уже устойчиво в жизни пользователя — агент учитывает как данность, не «открывает» заново
> и не предлагает экспериментировать над этим. База, от которой считаем изменения.

`;
}

export function listHabits() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, 'utf8')
    .split('\n')
    .filter((l) => /^- /.test(l) && !l.startsWith('- /'))
    .map((l) => l.replace(/^- /, '').trim());
}

export function addHabit(text) {
  const value = text.trim();
  const date = new Date().toLocaleDateString('sv-SE');
  let body;
  if (existsSync(FILE)) {
    body = readFileSync(FILE, 'utf8').replace(/\n*$/, '\n') + `- ${value}\n`;
  } else {
    body = header(date) + `- ${value}\n`;
  }
  writeFileSync(FILE, body);
  return listHabits();
}
