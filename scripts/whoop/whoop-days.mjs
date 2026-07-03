// whoop-days.mjs — достоверная сборка физиологии по КАЛЕНДАРНЫМ дням из Whoop v2.
//
// Почему отдельный модуль: старый sync брал `/v2/cycle?limit=1` — то есть ТЕКУЩИЙ,
// ещё не завершённый цикл, у которого утром strain ≈ 0. Отсюда «strain вчера 0.1».
// Здесь день собирается через связи cycle_id: recovery + sleep + завершённый cycle
// одного дня, а strain берётся у ЗАВЕРШЁННОГО цикла (score_state=SCORED, end!=null) —
// это настоящая дневная нагрузка. Плюс тянутся тренировки (`/v2/activity/workout`),
// которых старый скрипт не брал вовсе.
//
// Границы дня — по локальной таймзоне записи (timezone_offset у cycle/workout), а не UTC.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, whoopGet } from './lib.mjs';

const fmtDur = (ms) => {
  const min = Math.round(ms / 60000);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
};

// "+03:00" → минуты (+180). Пусто/битое → 0.
function offsetMinutes(tz) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

// Локальная дата YYYY-MM-DD для момента iso при смещении tz.
function localDate(iso, tz) {
  const t = new Date(iso).getTime() + offsetMinutes(tz) * 60000;
  return new Date(t).toISOString().slice(0, 10);
}

// GET с парой ретраев — утренний запуск ловит транзиентные fetch failed (сеть ещё не поднялась).
async function getRetry(path, params, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await whoopGet(path, params);
    } catch (e) {
      last = e;
      if (i < tries) await new Promise((s) => setTimeout(s, 800 * i));
    }
  }
  throw last;
}

// Все записи коллекции v2 за [start,end] с пагинацией по next_token.
async function collect(path, start, end) {
  const out = [];
  let nextToken;
  do {
    const params = { start, end, limit: 25 };
    if (nextToken) params.nextToken = nextToken;
    const d = await getRetry(path, params);
    out.push(...(d.records ?? []));
    nextToken = d.next_token;
  } while (nextToken);
  return out;
}

// Русские ярлыки видов спорта (что не в списке — как есть).
const SPORT_RU = {
  'functional-fitness': 'силовая', weightlifting: 'силовая', powerlifting: 'силовая',
  running: 'бег', walking: 'ходьба', hiking: 'хайк', cycling: 'вело',
  stairmaster: 'степпер', elliptical: 'эллипс', 'jump-rope': 'скакалка',
  swimming: 'плавание', dance: 'танцы', yoga: 'йога', pilates: 'пилатес',
  boxing: 'бокс', 'martial-arts': 'единоборства', tennis: 'теннис', 'strength-trainer': 'силовая',
};

/**
 * Собрать карту дней (dateISO → day) за инклюзивный диапазон локальных дат [fromDate, toDate].
 * day: { date, recovery, sleepMs, hrv, rhr, strain, cycleComplete, workouts:[{sport,strain,durMs,avgHr,maxHr,start}] }
 * strain заполняется ТОЛЬКО для завершённого цикла (иначе null — сегодняшний день доедет завтра).
 */
export async function fetchRange(fromDate, toDate) {
  // UTC-окно шире на сутки в каждую сторону — чтобы поймать циклы, начавшиеся вечером по локали.
  const s = new Date(`${fromDate}T00:00:00.000Z`); s.setUTCDate(s.getUTCDate() - 1);
  const e = new Date(`${toDate}T00:00:00.000Z`); e.setUTCDate(e.getUTCDate() + 2);
  const startISO = s.toISOString(), endISO = e.toISOString();

  const [cycles, recoveries, sleeps, workouts] = await Promise.all([
    collect('/v2/cycle', startISO, endISO),
    collect('/v2/recovery', startISO, endISO),
    collect('/v2/activity/sleep', startISO, endISO),
    collect('/v2/activity/workout', startISO, endISO),
  ]);

  const recByCycle = new Map();
  for (const r of recoveries) if (r.cycle_id != null) recByCycle.set(r.cycle_id, r);
  const sleepByCycle = new Map();
  for (const sl of sleeps) {
    if (sl.nap) continue; // ночной сон, не дневная дрёма
    if (sl.cycle_id != null && !sleepByCycle.has(sl.cycle_id)) sleepByCycle.set(sl.cycle_id, sl);
  }

  const days = new Map();
  for (const c of cycles) {
    const date = localDate(c.start, c.timezone_offset);
    if (date < fromDate || date > toDate) continue;
    const rs = recByCycle.get(c.id)?.score;
    const ss = sleepByCycle.get(c.id)?.score?.stage_summary;

    let hrv = rs?.hrv_rmssd_milli ?? null;
    if (hrv != null && hrv < 1) hrv *= 1000; // API иногда в секундах

    let sleepMs = null;
    if (ss) {
      const a = (ss.total_in_bed_time_milli ?? 0) - (ss.total_awake_time_milli ?? 0) - (ss.total_no_data_time_milli ?? 0);
      if (a > 0) sleepMs = a;
    }
    const complete = c.end != null && c.score_state === 'SCORED';
    days.set(date, {
      date,
      recovery: rs?.recovery_score != null ? Math.round(rs.recovery_score) : null,
      sleepMs,
      hrv: hrv != null ? Math.round(hrv) : null,
      rhr: rs?.resting_heart_rate != null ? Math.round(rs.resting_heart_rate) : null,
      strain: complete && c.score?.strain != null ? c.score.strain : null,
      cycleComplete: complete,
      workouts: [],
    });
  }

  for (const w of workouts) {
    if (w.score_state !== 'SCORED') continue;
    const date = localDate(w.start, w.timezone_offset);
    const day = days.get(date);
    if (!day) continue;
    day.workouts.push({
      sport: w.sport_name,
      strain: w.score?.strain ?? null,
      durMs: new Date(w.end) - new Date(w.start),
      avgHr: w.score?.average_heart_rate ?? null,
      maxHr: w.score?.max_heart_rate ?? null,
      start: w.start,
    });
  }
  for (const day of days.values()) day.workouts.sort((a, b) => (a.start < b.start ? -1 : 1));

  return days;
}

// Строка whoop: (физиология). null если нечего писать.
export function whoopLine(day) {
  const parts = [];
  if (day.recovery != null) parts.push(`recovery ${day.recovery}%`);
  if (day.sleepMs != null) parts.push(`сон ${fmtDur(day.sleepMs)}`);
  if (day.hrv != null) parts.push(`HRV ${day.hrv}`);
  if (day.strain != null) parts.push(`strain ${day.strain.toFixed(1)}`);
  if (day.rhr != null) parts.push(`пульс покоя ${day.rhr}`);
  return parts.length ? `whoop: ${parts.join(' | ')}` : null;
}

// Строка тренировки: (объективные сессии Whoop). Отдельно от ручной строки активность:. null если нет.
export function workoutLine(day) {
  if (!day.workouts?.length) return null;
  const items = day.workouts.map((w) => {
    const name = SPORT_RU[w.sport] ?? w.sport;
    const min = Math.round(w.durMs / 60000);
    const st = w.strain != null ? ` (${w.strain.toFixed(1)})` : '';
    return `${name} ${min}м${st}`;
  });
  return `тренировки: ${items.join(', ')}`;
}

/**
 * Записать/обновить daily-лог дня. Трогает ТОЛЬКО строки whoop: и тренировки:.
 * Ручные строки (бады/активность/питание/соц/ментальное/заметка/входящие) не изменяются.
 * opts.create=false → не создавать отсутствующий файл (только обновлять существующие).
 */
export function writeDayLog(day, opts = {}) {
  const { create = true } = opts;
  const wl = whoopLine(day);
  if (!wl) return { date: day.date, status: 'nodata' };
  const tl = workoutLine(day);
  const file = join(ROOT, '01_raw', 'health', `${day.date}.md`);

  if (existsSync(file)) {
    let text = readFileSync(file, 'utf8');
    if (/^whoop:.*$/m.test(text)) text = text.replace(/^whoop:.*$/m, wl);
    else text = text.replace(/^(#\s.*\n)/, `$1\n${wl}\n`);
    if (tl) {
      if (/^тренировки:.*$/m.test(text)) text = text.replace(/^тренировки:.*$/m, tl);
      else text = text.replace(/^(whoop:.*\n)/m, `$1${tl}\n`);
    }
    writeFileSync(file, text);
    return { date: day.date, status: 'updated', wl, tl };
  }
  if (!create) return { date: day.date, status: 'missing', wl, tl };

  const scaffold = `# ${day.date}\n\n${wl}\n${tl ? tl + '\n' : ''}` +
    `бады: ✓ (или: пропустил <что>)\n` +
    `активность: <тип> __мин (или: отдых)\n` +
    `питание: <тайминг, кофе/алкоголь/поздняя еда>\n` +
    `соц: 0 / 1 / 2\n` +
    `ментальное: настроение _/5 | энергия _/5 | тревога _/5\n` +
    `заметка: <одно предложение>\n`;
  writeFileSync(file, scaffold);
  return { date: day.date, status: 'created', wl, tl };
}
