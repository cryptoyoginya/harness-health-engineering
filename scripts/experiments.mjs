// experiments.mjs — общий парсер n-of-1 экспериментов из /05_decisions/experiments/.
// Эксперименты — killer-фича харнесса (причинность вместо корреляций). Этот модуль выводит
// их в ежедневный контур: /exp в боте, строка в утреннем брифе, проверка на разборе недели.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './whoop/lib.mjs';

const DIR = join(ROOT, '05_decisions', 'experiments');
const FINISHED = new Set(['merged', 'reverted', 'done', 'closed', 'abandoned', 'archived', 'template']);

function parseEndDate(body) {
  // «до 03.07.2026» или «до 03.07» (без года — берём ближайший будущий).
  let m = body.match(/до\s+(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  m = body.match(/до\s+(\d{2})\.(\d{2})(?!\.\d)/);
  if (m) {
    const now = new Date();
    let y = now.getFullYear();
    const d = new Date(y, +m[2] - 1, +m[1]);
    if (d < now) d.setFullYear(y + 1);
    return d;
  }
  return null;
}

function after(body, re) {
  const m = body.match(re);
  return m ? m[1].trim().replace(/\*\*/g, '').replace(/\s+/g, ' ') : null;
}

export function listExperiments() {
  if (!existsSync(DIR)) return [];
  const out = [];
  for (const f of readdirSync(DIR)) {
    if (!/^EXP-.*\.md$/i.test(f)) continue; // только EXP-*, без _TEMPLATE
    const body = readFileSync(join(DIR, f), 'utf8');
    const status = (body.match(/^status:\s*(\S+)/m)?.[1] || 'proposed').toLowerCase();
    const title = body.match(/^#\s+(EXP-.+)$/m)?.[1] || f.replace(/\.md$/, '');
    const hypothesis = after(body, /\*\*Гипотеза:\*\*\s*(.+)/);
    const criterion = after(body, /\*\*Критерий успеха[^:]*:\*\*\s*(.+)/);
    const endDate = parseEndDate(body);
    const daysLeft = endDate ? Math.ceil((endDate - new Date()) / 86400000) : null;
    out.push({ file: f, status, title, hypothesis, criterion, endDate, daysLeft });
  }
  return out;
}

export function activeExperiments() {
  return listExperiments().filter((e) => !FINISHED.has(e.status));
}

// Потолок параллельных экспериментов: меньше параллельных → чище атрибуция (одна переменная за раз).
export const MAX_ACTIVE = 3;

const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

// Полный список для /exp в боте.
export function formatExperiments() {
  const exps = activeExperiments();
  if (!exps.length) {
    return 'Активных экспериментов нет.\nГипотеза созрела? На разборе недели заведём — одна переменная за раз, срок, критерий успеха.';
  }
  const blocks = exps.map((e) => {
    const lines = [`🧪 ${e.title}`];
    if (e.hypothesis) lines.push(`гипотеза: ${e.hypothesis}`);
    if (e.daysLeft != null && e.endDate) {
      lines.push(e.daysLeft >= 0 ? `осталось ${e.daysLeft} дн (до ${dmy(e.endDate)})` : `срок вышел ${dmy(e.endDate)} — пора выносить вердикт merge/revert`);
    }
    if (e.criterion) lines.push(`критерий: ${e.criterion}`);
    return lines.join('\n');
  });
  return 'Активные эксперименты:\n\n' + blocks.join('\n\n') + '\n\nСверка с данными — на воскресном разборе.';
}

// --- Создание / отмена вручную (из бота и агента) ---

function nextId() {
  let max = 0;
  if (existsSync(DIR)) {
    for (const f of readdirSync(DIR)) {
      const m = f.match(/^EXP-(\d+)/i);
      if (m) max = Math.max(max, +m[1]);
    }
  }
  return String(max + 1).padStart(3, '0');
}

// Завести черновик n-of-1 из одной фразы. Агент уточнит дизайн (baseline/метрики/критерий) позже.
export function createExperiment(hypothesis, weeks = 3) {
  const id = nextId();
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + weeks * 7);
  const date = now.toLocaleDateString('sv-SE');
  const short = hypothesis.split(/\s+/).slice(0, 6).join(' ').replace(/[.!?,;:]+$/, '');
  const title = `EXP-${id}: ${short}`;
  const body = `---
type: experiment
status: proposed
date: ${date}
related:
  - /00_context/health-metrics.md
---

# ${title}

> n-of-1 trial. Создан вручную из бота — агент уточнит дизайн (baseline, метрики, критерий) на ближайшем разборе.

DECISION: ${hypothesis}.

- **Гипотеза:** ${hypothesis}
- **Что меняю:** <ровно одна переменная — уточнить с агентом>
- **Baseline (до):** <медиана за стартовую неделю — уточнить>
- **Срок:** ${weeks} недели (до ${dmy(end)})
- **Метрики:** <уточнить — Whoop и/или субъективно>
- **Критерий успеха (пред-регистрация):** <порог ДО данных — уточнить>

## Итог (заполнить по окончании)

- **Результат:** <цифры после vs baseline vs критерий>
- DECISION: merge (→ правило в \`CLAUDE.md\`) / revert / продлить.
`;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, `EXP-${id}.md`), body);
  return { id, title, endsOn: dmy(end) };
}

function findExpFile(arg) {
  if (!existsSync(DIR)) return null;
  const num = String(arg).replace(/\D/g, '');
  if (!num) return null;
  const re = new RegExp(`^EXP-0*${+num}(?:[-.]|$)`, 'i');
  return readdirSync(DIR).find((f) => re.test(f)) || null;
}

const ddmmyyyy = () => new Date().toLocaleDateString('sv-SE').split('-').reverse().join('.');

// Отменить эксперимент по номеру (1, 01, 001, EXP-001) → status reverted + пометка.
export function cancelExperiment(arg) {
  const file = findExpFile(arg);
  if (!file) return null;
  const p = join(DIR, file);
  let body = readFileSync(p, 'utf8');
  const title = body.match(/^#\s+(EXP-.+)$/m)?.[1] || file.replace(/\.md$/, '');
  body = /^status:/m.test(body)
    ? body.replace(/^status:.*/m, 'status: reverted')
    : body.replace(/^---\n/, '---\nstatus: reverted\n');
  body = body.replace(/\n*$/, '\n') + `\n- DECISION: revert — отменён вручную ${ddmmyyyy()}.\n`;
  writeFileSync(p, body);
  return { title };
}

// Продлить эксперимент на N недель (по умолчанию +2). Сдвигает «до …», возвращает в активные.
export function extendExperiment(arg, addWeeks = 2) {
  const file = findExpFile(arg);
  if (!file) return null;
  const p = join(DIR, file);
  let body = readFileSync(p, 'utf8');
  const title = body.match(/^#\s+(EXP-.+)$/m)?.[1] || file.replace(/\.md$/, '');
  let base = parseEndDate(body) || new Date();
  if (base < new Date()) base = new Date(); // если срок уже вышел — продлеваем от сегодня
  const end = new Date(base);
  end.setDate(end.getDate() + addWeeks * 7);
  body = /^- \*\*Срок:\*\*/m.test(body)
    ? body.replace(/^- \*\*Срок:\*\*.*$/m, `- **Срок:** продлён до ${dmy(end)}`)
    : body.replace(/\n*$/, '\n') + `\n- **Срок:** продлён до ${dmy(end)}\n`;
  body = body.replace(/^status:.*/m, 'status: active'); // возобновляем, если был отменён/завершён
  body = body.replace(/\n*$/, '\n') + `\n- продлён вручную ${ddmmyyyy()} на ${addWeeks} нед.\n`;
  writeFileSync(p, body);
  return { title, endsOn: dmy(end) };
}

// Зафиксировать срыв/нарушение протокола (confounder). Если активен ровно один эксперимент —
// пишем прямо в него; иначе только в дневной лог (агент разнесёт по экспериментам на разборе).
export function recordSlip(text) {
  const act = activeExperiments();
  if (act.length === 1) {
    const p = join(DIR, act[0].file);
    let body = readFileSync(p, 'utf8');
    body = body.replace(/\n*$/, '\n') + `\n- ⚠️ срыв ${ddmmyyyy()}: ${text}\n`;
    writeFileSync(p, body);
    return { count: 1, title: act[0].title };
  }
  return { count: act.length, title: null };
}

// Однострочный нудж для утреннего брифа (самый срочный эксперимент).
export function experimentNudge() {
  const exps = activeExperiments().filter((e) => e.daysLeft != null);
  if (!exps.length) return '';
  exps.sort((a, b) => a.daysLeft - b.daysLeft);
  const e = exps[0];
  const name = e.title.replace(/^EXP-\d+:\s*/i, '');
  if (e.daysLeft < 0) return `🧪 ${name}: срок вышел — сегодня вынеси вердикт (merge/revert).`;
  if (e.daysLeft === 0) return `🧪 ${name}: последний день эксперимента — вечером подведём итог.`;
  return `🧪 ${name}: идёт, осталось ${e.daysLeft} дн — держи переменную, не меняй остальное.`;
}
