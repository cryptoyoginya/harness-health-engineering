// northstar.mjs — north-star пользователя: долгосрочное направление, которое она задаёт сама.
// Куда должна идти жизнь (смысл, не цифра). Всё остальное — прокси, что ему служит.
// Хранится в /00_context/north-star.md между маркерами, чтобы читать/писать без потери обрамления.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './whoop/lib.mjs';

const FILE = join(ROOT, '00_context', 'north-star.md');
const START = '<!-- north-star:start -->';
const END = '<!-- north-star:end -->';

export function getNorthStar() {
  if (!existsSync(FILE)) return null;
  const t = readFileSync(FILE, 'utf8');
  const a = t.indexOf(START);
  const b = t.indexOf(END);
  if (a === -1 || b === -1 || b < a) return null;
  const v = t.slice(a + START.length, b).trim();
  return v || null;
}

export function setNorthStar(text) {
  const value = text.trim();
  const date = new Date().toLocaleDateString('sv-SE');
  const body = `---
type: context
status: living
date: ${date}
related:
  - /00_context/health-metrics.md
---

# North-star — моё направление

> Долгосрочное направление, которое пользователь задаёт сам: куда должна идти жизнь (смысл, не цифра).
> Всё остальное (recovery, сон, эксперименты) — прокси, что ему служит. Раз в квартал сверяем: туда ли движемся.

${START}
${value}
${END}
`;
  writeFileSync(FILE, body);
  return value;
}
