#!/usr/bin/env node
// sync.mjs — утренний ingest физиологии Whoop в daily-логи /01_raw/health/YYYY-MM-DD.md.
//
// Запуск: pnpm whoop:sync (launchd — каждый день в 9:00). Требует разового pnpm whoop:auth.
//
// Данные собираются через whoop-days.mjs:
//  • strain берётся у ЗАВЕРШЁННОГО дневного цикла (а не текущего, у которого утром strain≈0);
//    сегодняшний strain доедет завтрашним запуском, когда цикл закроется;
//  • тянутся тренировки (строка тренировки:), чего старый скрипт не делал;
//  • самолечение пропусков: обрабатываем трейлинг-окно последних дней, поэтому пропущенный
//    из-за спящего ноута/сети день дозапишется на следующем запуске (не нужен ручной backfill).
// Меняются ТОЛЬКО строки whoop: и тренировки: — ручные строки не трогаются.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, todayISO } from './lib.mjs';
import { fetchRange, writeDayLog, whoopLine } from './whoop-days.mjs';
import { whoopBaseline, whoopTrend, whoopAdvice } from './advice.mjs';
import { experimentNudge } from '../experiments.mjs';

loadEnv();

const HEAL_DAYS = 3; // сколько последних суток пере-проверяем (самолечение пропусков)

const today = todayISO();
const from = new Date(`${today}T00:00:00`);
from.setDate(from.getDate() - HEAL_DAYS);
const fromISO = from.toLocaleDateString('sv-SE');

let days;
try {
  days = await fetchRange(fromISO, today);
} catch (e) {
  console.error(`[whoop] запрос к API не удался: ${e.message}`);
  process.exit(1);
}

if (days.size === 0) {
  console.error('[whoop] API не вернул циклов за окно. Лог не изменён.');
  process.exit(1);
}

const sorted = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
for (const day of sorted) {
  const r = writeDayLog(day);
  console.log(`[whoop] ${r.status} ${day.date}: ${r.wl}${r.tl ? ' | ' + r.tl : ''}`);
}

const todayDay = days.get(today);
const whoopLineToday = todayDay ? whoopLine(todayDay) : `whoop: (нет данных за ${today})`;

// --- Утренний бриф в Telegram (если настроен бот) ---
async function sendBrief(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  if (existsSync(join(ROOT, '.bot', 'quiet'))) { console.log('[whoop] тихий режим — бриф не отправлен'); return; }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    console.log('[whoop] бриф отправлен в Telegram');
  } catch (e) {
    console.warn('[whoop] telegram бриф не отправлен:', e.message);
  }
}

// Совет — тот же, что в боте /whoop: светофор + флаги по отклонениям от нормы + тренд.
const snap = todayDay
  ? { rec: todayDay.recovery, hrv: todayDay.hrv, rhr: todayDay.rhr, sleepMs: todayDay.sleepMs, strain: todayDay.strain }
  : { rec: null, hrv: null, rhr: null, sleepMs: null, strain: null };
const advice = whoopAdvice(snap, whoopBaseline(), whoopTrend());
const nudge = experimentNudge();
await sendBrief(
  `☀️ Доброе утро\n${whoopLineToday}` +
  (advice ? `\n\n${advice}` : '') +
  (nudge ? `\n\n${nudge}` : '') +
  '\n\nВечером черкни, как прошёл день.',
);
