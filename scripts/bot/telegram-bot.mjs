#!/usr/bin/env node
// telegram-bot.mjs — тупой сборщик: ловит сообщения в Telegram и дописывает их в
// сегодняшний daily-лог. Никакого LLM, никаких ключей кроме токена бота. Бесплатно.
// Long-polling (getUpdates) — публичный сервер/вебхук не нужен, работает локально за NAT.
//
// Логика: всё, что ты пишешь боту, падает строкой `- HH:MM <текст>` в секцию `## входящие`
// сегодняшнего файла /01_raw/health/<дата>.md. Структурирование и анализ — на агенте (Claude Code).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, requireEnv, todayISO, whoopGet } from '../whoop/lib.mjs';

loadEnv();
const TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const ALLOWED = process.env.TELEGRAM_CHAT_ID || ''; // если пусто — бот подскажет твой chat_id
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(ROOT, '.bot', 'offset');

const nowHM = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Онбординг и /help. Задача — объяснить контракт: что писать, как это работает, что в воскресенье.
const INTRO = [
  'Это твой health-харнесс — система, которая копит сырьё о твоих днях и раз в неделю достаёт из него выводы: что реально двигает твою жизнь, а что метрика-пустышка (растёт, а жить не помогает).',
  '',
  'Я тут — сборщик. Тупой и честный: всё, что ты пишешь, кладу строкой в сегодняшний лог. ИИ внутри меня нет — думает потом агент над этими логами.',
  '',
  'Что писать — вечером, одной-двумя фразами, как импрессия дня (не отчёт):',
  '• настроение и энергия — словами или 1–5',
  '• сон, тренировка, движение',
  '• бады и режим — что приняла',
  '• еда, кофе, алкоголь',
  '• люди и работа — был ли контакт, как нагрузка',
  '• главное: стало ли сегодня лучше жить — и почему',
  '',
  'Recovery, HRV и сон Whoop подтягивает сам по утрам — их писать не надо. Утром я пришлю короткий бриф по телу.',
  '',
  'По воскресеньям — разбор недели: агент читает 7 логов, находит паттерны, которые сам не замечаешь, выносит вердикт «лучше ли живётся» и, если гипотеза созрела, заводит n-of-1 эксперимент — меняем одну переменную, через 2–3 недели вердикт merge или revert.',
  '',
  'Команды:',
  '/whoop — твои показатели прямо сейчас (recovery, сон, HRV, светофор дня)',
  '/week — сводка за 7 дней',
  '/today — сегодняшний лог целиком',
  '/undo — убрать последнюю запись (если опечатка)',
  '/help — это сообщение',
  '',
  'Просто начни писать.',
].join('\n');

function readOffset() {
  try { return Number(readFileSync(OFFSET_FILE, 'utf8').trim()) || 0; } catch { return 0; }
}
function writeOffset(v) {
  mkdirSync(join(ROOT, '.bot'), { recursive: true });
  writeFileSync(OFFSET_FILE, String(v));
}

async function send(chatId, text) {
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function todayFile() {
  return join(ROOT, '01_raw', 'health', `${todayISO()}.md`);
}

function appendInbox(text) {
  const file = todayFile();
  const line = `- ${nowHM()} ${text}`;
  if (!existsSync(file)) {
    writeFileSync(file, `# ${todayISO()}\n\n## входящие\n${line}\n`);
    return;
  }
  let body = readFileSync(file, 'utf8');
  if (!/^##\s+входящие\s*$/m.test(body)) {
    body = body.replace(/\n*$/, '\n');
    body += `\n## входящие\n${line}\n`;
  } else {
    body = body.replace(/\n*$/, '\n') + `${line}\n`;
  }
  writeFileSync(file, body);
}

function showToday() {
  const file = todayFile();
  return existsSync(file) ? readFileSync(file, 'utf8') : `Лог за ${todayISO()} ещё пуст.`;
}

// --- /whoop: живой снимок физиологии из Whoop v2 (то же, что в утреннем брифе, по запросу) ---
const fmtDur = (ms) => {
  const min = Math.round(ms / 60000);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
};

async function whoopSnapshot() {
  const one = async (p) => {
    try { const d = await whoopGet(p, { limit: 1 }); return d.records?.[0] ?? null; }
    catch { return null; }
  };
  const [recovery, cycle, sleep] = await Promise.all([
    one('/v2/recovery'), one('/v2/cycle'), one('/v2/activity/sleep'),
  ]);
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

// Личный базовый уровень из логов (14 дней до сегодня) — чтобы советовать относительно ТЕБЯ, а не таблиц.
function whoopBaseline(days = 14) {
  const hrv = [], rhr = [], rec = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toLocaleDateString('sv-SE');
    const f = join(ROOT, '01_raw', 'health', `${iso}.md`);
    if (!existsSync(f)) continue;
    const t = readFileSync(f, 'utf8');
    const h = t.match(/HRV (\d+)/);          if (h) hrv.push(+h[1]);
    const p = t.match(/пульс покоя (\d+)/);  if (p) rhr.push(+p[1]);
    const r = t.match(/recovery (\d+)%/);    if (r) rec.push(+r[1]);
  }
  const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  return { hrv: avg(hrv), rhr: avg(rhr), rec: avg(rec), n: Math.max(hrv.length, rhr.length) };
}

// Точечный совет: светофор по recovery + флаги по отклонениям HRV/пульса/сна от твоей нормы.
// Это тренировочно-бытовая навигация, НЕ диагностика. Стойкие сигналы — к специалисту.
function whoopAdvice(s, base) {
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

  if (ctx.length) { lines.push(''); lines.push(...ctx.map((c) => '• ' + c)); }
  else if (s.rec != null && base.n >= 3) { lines.push(''); lines.push('• HRV, пульс и сон — в твоей норме, флагов нет.'); }
  return lines.join('\n');
}

// --- /week: быстрая сводка за 7 дней из daily-логов (глубокий разбор — у агента в воскресенье) ---
function weekSummary() {
  const recs = [], sleeps = [], moods = [], energies = [];
  let logged = 0, nights7 = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toLocaleDateString('sv-SE');
    const f = join(ROOT, '01_raw', 'health', `${iso}.md`);
    if (!existsSync(f)) continue;
    logged++;
    const t = readFileSync(f, 'utf8');
    const rec = t.match(/recovery (\d+)%/);          if (rec) recs.push(+rec[1]);
    const sl = t.match(/сон (\d+):(\d+)/);            if (sl) { const h = +sl[1] + +sl[2] / 60; sleeps.push(h); if (h >= 7) nights7++; }
    const mo = t.match(/настроение (\d+)/);           if (mo) moods.push(+mo[1]);
    const en = t.match(/энергия (\d+)/);              if (en) energies.push(+en[1]);
  }
  const avg = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length) : null;
  return { logged, nights7, sleepDays: sleeps.length,
    recAvg: avg(recs), sleepAvg: avg(sleeps), moodAvg: avg(moods), energyAvg: avg(energies) };
}

// --- /undo: убрать последнюю записанную строку из сегодняшнего лога ---
function undoLast() {
  const file = todayFile();
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^- \d{2}:\d{2}\s/.test(lines[i])) { idx = i; break; }
  }
  if (idx === -1) return null;
  const [removed] = lines.splice(idx, 1);
  writeFileSync(file, lines.join('\n'));
  return removed.replace(/^- \d{2}:\d{2}\s/, '');
}

// Меню команд в Telegram (показывается по кнопке «/» в клиенте).
async function registerCommands() {
  const commands = [
    { command: 'whoop', description: 'мои показатели сейчас — recovery, сон, HRV' },
    { command: 'week',  description: 'сводка за 7 дней' },
    { command: 'today', description: 'сегодняшний лог целиком' },
    { command: 'undo',  description: 'убрать последнюю запись' },
    { command: 'help',  description: 'как всё устроено' },
  ];
  try {
    await fetch(`${API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
  } catch { /* меню необязательно */ }
}

async function handle(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId) return;

  // Онбординг: если chat_id не задан — подсказать и не писать в лог.
  if (!ALLOWED) {
    console.log(`[bot] CHAT_ID=${chatId}`);
    await send(chatId, `Твой chat_id: ${chatId}\nВпиши его в .env как TELEGRAM_CHAT_ID и перезапусти бота — тогда начну собирать.`);
    return;
  }
  // Безопасность: пишем в лог только из разрешённого чата.
  if (String(chatId) !== String(ALLOWED)) {
    await send(chatId, 'Не авторизовано.');
    return;
  }

  if (text === '/start' || text === '/help') {
    await send(chatId, INTRO);
    return;
  }
  if (text === '/today') {
    await send(chatId, showToday());
    return;
  }
  if (text === '/whoop' || text === '/body') {
    await send(chatId, '📡 тяну Whoop…');
    const snap = await whoopSnapshot();
    if (!snap.parts.length) {
      await send(chatId, 'Whoop пока молчит — синк ещё не прошёл или нет свежей ночи. Загляни попозже.');
      return;
    }
    const advice = whoopAdvice(snap, whoopBaseline());
    await send(chatId, `📊 Сейчас:\n${snap.parts.join('\n')}${advice ? '\n\n' + advice : ''}`);
    return;
  }
  if (text === '/week') {
    const w = weekSummary();
    if (!w.logged) {
      await send(chatId, 'За последние 7 дней логов нет. Начни писать — через неделю будет что свести.');
      return;
    }
    const lines = [`🗓 Неделя (${w.logged}/7 дней с логом):`];
    if (w.recAvg != null)    lines.push(`• recovery: ср. ${Math.round(w.recAvg)}%`);
    if (w.sleepAvg != null)  lines.push(`• сон: ср. ${w.sleepAvg.toFixed(1)} ч, ночей ≥7ч: ${w.nights7}/${w.sleepDays}`);
    if (w.moodAvg != null)   lines.push(`• настроение: ср. ${w.moodAvg.toFixed(1)}/5`);
    if (w.energyAvg != null) lines.push(`• энергия: ср. ${w.energyAvg.toFixed(1)}/5`);
    lines.push('', 'Глубокий разбор — в воскресенье скажи агенту «разбери неделю».');
    await send(chatId, lines.join('\n'));
    return;
  }
  if (text === '/undo') {
    const removed = undoLast();
    await send(chatId, removed ? `↩️ убрал: ${removed}` : 'Сегодня нечего убирать.');
    return;
  }
  if (!text) {
    await send(chatId, 'Пришли текст — запишу. Фото и голосовые пока не умею.');
    return;
  }

  appendInbox(text);
  await send(chatId, `✓ записал в ${todayISO()}`);
}

async function loop() {
  console.log('[bot] запущен (long-polling). Ctrl+C для остановки.');
  await registerCommands();
  let offset = readOffset();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset + 1}`);
      const data = await r.json();
      if (!data.ok) {
        console.error('[bot] getUpdates error:', JSON.stringify(data));
        await new Promise((s) => setTimeout(s, 5000));
        continue;
      }
      for (const upd of data.result) {
        offset = upd.update_id;
        writeOffset(offset);
        if (upd.message) await handle(upd.message);
      }
    } catch (e) {
      console.error('[bot]', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
}

loop();
