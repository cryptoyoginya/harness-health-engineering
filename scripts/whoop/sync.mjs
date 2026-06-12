#!/usr/bin/env node
// sync.mjs — утренний ingest: тянет физиологию из Whoop v2 и дописывает строку `whoop:`
// в сегодняшний daily-лог /01_raw/health/YYYY-MM-DD.md (создаёт файл, если его нет).
//
// Запуск: pnpm whoop:sync  (требует разового pnpm whoop:auth).
// Меняет ТОЛЬКО строку whoop: — ментальные строки, вписанные рукой, не трогает.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, whoopGet, todayISO } from './lib.mjs';
import { buildSnapshot, whoopBaseline, whoopTrend, whoopAdvice } from './advice.mjs';
import { experimentNudge } from '../experiments.mjs';

loadEnv();

const fmtDur = (ms) => {
  const min = Math.round(ms / 60000);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
};

async function first(pathname) {
  try {
    const data = await whoopGet(pathname, { limit: 1 });
    return data.records?.[0] ?? null;
  } catch (e) {
    console.warn(`[whoop] ${pathname}: ${e.message}`);
    return null;
  }
}

const [recovery, cycle, sleep] = await Promise.all([
  first('/v2/recovery'),
  first('/v2/cycle'),
  first('/v2/activity/sleep'),
]);

const parts = [];

if (recovery?.score) {
  const s = recovery.score;
  if (s.recovery_score != null) parts.push(`recovery ${Math.round(s.recovery_score)}%`);
  if (sleep?.score?.stage_summary) {
    const ss = sleep.score.stage_summary;
    const asleep =
      (ss.total_in_bed_time_milli ?? 0) -
      (ss.total_awake_time_milli ?? 0) -
      (ss.total_no_data_time_milli ?? 0);
    if (asleep > 0) parts.push(`сон ${fmtDur(asleep)}`);
  }
  if (s.hrv_rmssd_milli != null) {
    let hrv = s.hrv_rmssd_milli;
    if (hrv < 1) hrv *= 1000; // на случай, если API отдаёт секунды
    parts.push(`HRV ${Math.round(hrv)}`);
  }
  if (cycle?.score?.strain != null) parts.push(`strain вчера ${cycle.score.strain.toFixed(1)}`);
  if (s.resting_heart_rate != null) parts.push(`пульс покоя ${Math.round(s.resting_heart_rate)}`);
} else if (sleep?.score?.stage_summary) {
  const ss = sleep.score.stage_summary;
  const asleep =
    (ss.total_in_bed_time_milli ?? 0) - (ss.total_awake_time_milli ?? 0) - (ss.total_no_data_time_milli ?? 0);
  if (asleep > 0) parts.push(`сон ${fmtDur(asleep)}`);
}

if (parts.length === 0) {
  console.error('[whoop] нет данных от API (recovery/sleep/cycle пустые). Лог не изменён.');
  process.exit(1);
}

const whoopLine = `whoop: ${parts.join(' | ')}`;
const date = todayISO();
const file = join(ROOT, '01_raw', 'health', `${date}.md`);

if (existsSync(file)) {
  let text = readFileSync(file, 'utf8');
  if (/^whoop:.*$/m.test(text)) {
    text = text.replace(/^whoop:.*$/m, whoopLine);
  } else {
    text = text.replace(/^(#\s.*\n)/, `$1\n${whoopLine}\n`);
  }
  writeFileSync(file, text);
  console.log(`[whoop] обновлена строка whoop: в ${date}.md`);
} else {
  const scaffold = `# ${date}

${whoopLine}
бады: ✓ (или: пропустил <что>)
активность: <тип> __мин (или: отдых)
питание: <тайминг, кофе/алкоголь/поздняя еда>
соц: 0 / 1 / 2
ментальное: настроение _/5 | энергия _/5 | тревога _/5
заметка: <одно предложение>
`;
  writeFileSync(file, scaffold);
  console.log(`[whoop] создан ${date}.md с физиологией. Допиши ментальные строки вечером (~20 сек).`);
}

console.log(`  ${whoopLine}`);

// --- Утренний бриф в Telegram (если настроен бот) ---
async function sendBrief(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
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
// Сегодняшняя строка whoop: уже записана выше, поэтому baseline (14 дн до сегодня) и
// trend (включая сегодня) читаются из логов корректно.
const snap = buildSnapshot(recovery, cycle, sleep);
const advice = whoopAdvice(snap, whoopBaseline(), whoopTrend());
const nudge = experimentNudge(); // строка про активный эксперимент, если идёт
await sendBrief(
  `☀️ Доброе утро\n${whoopLine}` +
  (advice ? `\n\n${advice}` : '') +
  (nudge ? `\n\n${nudge}` : '') +
  '\n\nВечером черкни, как прошёл день.',
);
