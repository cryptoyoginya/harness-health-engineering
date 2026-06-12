// experiments.mjs — общий парсер n-of-1 экспериментов из /05_decisions/experiments/.
// Эксперименты — killer-фича харнесса (причинность вместо корреляций). Этот модуль выводит
// их в ежедневный контур: /exp в боте, строка в утреннем брифе, проверка на разборе недели.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
