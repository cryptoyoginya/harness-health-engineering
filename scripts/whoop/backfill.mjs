#!/usr/bin/env node
// backfill.mjs — дотягивает достоверную физиологию Whoop за диапазон дат задним числом.
// Исправляет strain (берёт завершённый цикл дня), добавляет строку тренировки:, создаёт
// пропущенные дни. Ручные строки логов не трогает.
//
// Запуск:
//   node scripts/whoop/backfill.mjs 2026-06-10 2026-07-03        # записать
//   node scripts/whoop/backfill.mjs 2026-06-10 2026-07-03 --dry  # только показать, без записи

import { loadEnv } from './lib.mjs';
import { fetchRange, writeDayLog, whoopLine, workoutLine } from './whoop-days.mjs';

loadEnv();

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const [from, to] = args.filter((a) => !a.startsWith('--'));
if (!from || !to) {
  console.error('usage: backfill.mjs FROM_YYYY-MM-DD TO_YYYY-MM-DD [--dry]');
  process.exit(1);
}

const days = await fetchRange(from, to);
const sorted = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

let created = 0, updated = 0;
for (const day of sorted) {
  if (dry) {
    console.log(`${day.date}  ${whoopLine(day)}`);
    const tl = workoutLine(day);
    if (tl) console.log(`            ${tl}`);
    continue;
  }
  const r = writeDayLog(day);
  if (r.status === 'created') created++;
  else if (r.status === 'updated') updated++;
  console.log(`${r.status.padEnd(7)} ${day.date}  ${r.wl}`);
  if (r.tl) console.log(`            ${r.tl}`);
}

console.log(`\n[backfill] дней с данными: ${sorted.length}` + (dry ? ' (dry-run, ничего не записано)' : `, создано ${created}, обновлено ${updated}`));
