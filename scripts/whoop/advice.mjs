// advice.mjs — общий слой «физиология → совет». Используется и ботом (/whoop по запросу),
// и утренним синком (бриф в 9:00), чтобы совет был один и тот же.
//
// Принцип: советуем относительно ТВОЕЙ нормы (личный базовый уровень из логов), а не таблиц.
// Это тренировочно-бытовая навигация, НЕ диагностика. Стойкие сигналы — к специалисту.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, whoopGet } from './lib.mjs';

export const fmtDur = (ms) => {
  const min = Math.round(ms / 60000);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
};

// --- Снимок физиологии из набора записей Whoop (recovery/cycle/sleep) ---
export function buildSnapshot(recovery, cycle, sleep) {
  const s = recovery?.score;

  let hrv = s?.hrv_rmssd_milli ?? null;
  if (hrv != null && hrv < 1) hrv *= 1000; // API иногда отдаёт секунды
  hrv = hrv != null ? Math.round(hrv) : null;

  const ss = sleep?.score?.stage_summary;
  let sleepMs = null;
  if (ss) {
    const a = (ss.total_in_bed_time_milli ?? 0) - (ss.total_awake_time_milli ?? 0) - (ss.total_no_data_time_milli ?? 0);
    if (a > 0) sleepMs = a;
  }
  const rhr = s?.resting_heart_rate != null ? Math.round(s.resting_heart_rate) : null;
  const strain = cycle?.score?.strain ?? null;
  const rec = s?.recovery_score != null ? Math.round(s.recovery_score) : null;

  const parts = [];
  if (rec != null) parts.push(`recovery ${rec}%`);
  if (sleepMs != null) parts.push(`сон ${fmtDur(sleepMs)}`);
  if (hrv != null) parts.push(`HRV ${hrv}`);
  if (strain != null) parts.push(`strain ${strain.toFixed(1)}`);
  if (rhr != null) parts.push(`пульс покоя ${rhr}`);

  return { parts, rec, hrv, rhr, sleepMs, strain };
}

// --- Живой снимок: тянет последние записи из API и собирает snapshot ---
export async function fetchSnapshot() {
  const one = async (p) => {
    try { const d = await whoopGet(p, { limit: 1 }); return d.records?.[0] ?? null; }
    catch { return null; }
  };
  const [recovery, cycle, sleep] = await Promise.all([
    one('/v2/recovery'), one('/v2/cycle'), one('/v2/activity/sleep'),
  ]);
  return buildSnapshot(recovery, cycle, sleep);
}

// --- Чтение ряда метрики из daily-логов ---
const METRIC_RE = {
  hrv: /HRV (\d+)/,
  rhr: /пульс покоя (\d+)/,
  rec: /recovery (\d+)%/,
};

// Ряд значений по дням (oldest→newest). offsetFrom=1 пропускает сегодня (для baseline),
// offsetFrom=0 включает сегодня (для тренда).
function series(metric, days, offsetFrom) {
  const re = METRIC_RE[metric];
  const out = [];
  for (let i = days; i >= offsetFrom; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toLocaleDateString('sv-SE');
    const f = join(ROOT, '01_raw', 'health', `${iso}.md`);
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(re);
    if (m) out.push(+m[1]);
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Личная норма за `days` дней до сегодня.
export function whoopBaseline(days = 14) {
  const hrv = series('hrv', days, 1);
  const rhr = series('rhr', days, 1);
  const rec = series('rec', days, 1);
  return { hrv: avg(hrv), rhr: avg(rhr), rec: avg(rec), n: Math.max(hrv.length, rhr.length) };
}

// Тренд за последние дни (включая сегодня): монотонный сдвиг 3 дня подряд.
export function whoopTrend(days = 5) {
  const flags = [];
  const last3 = (a) => a.slice(-3);
  const decr = (a) => a.length === 3 && a[0] > a[1] && a[1] > a[2];
  const incr = (a) => a.length === 3 && a[0] < a[1] && a[1] < a[2];

  const h3 = last3(series('hrv', days, 0));
  const p3 = last3(series('rhr', days, 0));
  const r3 = last3(series('rec', days, 0));

  if (decr(h3)) flags.push(`HRV снижается 3 дня подряд (${h3.join('→')}) — копится усталость или стресс, заложи восстановление.`);
  if (incr(p3)) flags.push(`Пульс покоя растёт 3 дня подряд (${p3.join('→')}) — следи за нагрузкой и сном, не подступает ли недомогание.`);
  if (decr(r3)) flags.push(`Recovery падает 3 дня подряд (${r3.join('→%')}%) — тело не догоняет нагрузку, нужен разгрузочный день.`);

  return flags;
}

// --- Сборка совета: светофор по recovery + флаги по отклонениям от нормы + тренд ---
export function whoopAdvice(s, base, trend = []) {
  const lines = [];
  if (s.rec != null) {
    if (s.rec > 66) lines.push('🟢 Зелёный день — есть запас под серьёзную нагрузку: силовая, интервалы, длинная.');
    else if (s.rec >= 40) lines.push('🟡 Жёлтый день — техника и зона 2, без рекордов и интервалов.');
    else lines.push('🔴 Красный день — восстановление: прогулка, растяжка, ранний отбой.');
  }

  const ctx = [];
  if (base.n >= 3) {
    if (s.hrv != null && base.hrv != null) {
      if (s.hrv >= base.hrv * 1.08) ctx.push(`HRV ${s.hrv} — выше твоего среднего (${Math.round(base.hrv)}): нервная система свежая, тело готово.`);
      else if (s.hrv <= base.hrv * 0.92) ctx.push(`HRV ${s.hrv} — ниже среднего (${Math.round(base.hrv)}): знак недовосстановления или стресса, не геройствуй даже при зелёном.`);
    }
    if (s.rhr != null && base.rhr != null) {
      if (s.rhr >= base.rhr + 4) ctx.push(`Пульс покоя ${s.rhr} — выше обычного (${Math.round(base.rhr)}): часто это нагрузка, недосып или подступающее недомогание. Понаблюдай за собой.`);
      else if (s.rhr <= base.rhr - 3) ctx.push(`Пульс покоя ${s.rhr} — ниже обычного (${Math.round(base.rhr)}): хороший знак восстановления.`);
    }
  }
  if (s.sleepMs != null && s.sleepMs / 3600000 < 7) {
    ctx.push(`Сон ${fmtDur(s.sleepMs)} — меньше 7 ч: добери сегодня, недосып бьёт по завтрашнему recovery.`);
  }
  if (s.strain != null && s.rec != null && s.rec < 40 && s.strain >= 14) {
    ctx.push(`Вчерашний strain ${s.strain.toFixed(1)} высокий на фоне низкого recovery — тело в долгу, сегодня правда полегче.`);
  }

  // Тренд — отдельным акцентом: это про траекторию, а не про сегодняшний уровень.
  for (const t of trend) ctx.push('📉 ' + t);

  if (ctx.length) { lines.push(''); lines.push(...ctx.map((c) => (c.startsWith('📉') ? c : '• ' + c))); }
  else if (s.rec != null && base.n >= 3) { lines.push(''); lines.push('• HRV, пульс и сон — в твоей норме, флагов нет.'); }
  return lines.join('\n');
}
