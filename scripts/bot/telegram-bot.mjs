#!/usr/bin/env node
// telegram-bot.mjs — тупой сборщик: ловит сообщения в Telegram и дописывает их в
// сегодняшний daily-лог. Никакого LLM, никаких ключей кроме токена бота. Бесплатно.
// Long-polling (getUpdates) — публичный сервер/вебхук не нужен, работает локально за NAT.
//
// Логика: всё, что ты пишешь боту, падает строкой `- HH:MM <текст>` в секцию `## входящие`
// сегодняшнего файла /01_raw/health/<дата>.md. Структурирование и анализ — на агенте (Claude Code).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, requireEnv, todayISO } from '../whoop/lib.mjs';
import { fetchSnapshot, whoopBaseline, whoopTrend, whoopAdvice } from '../whoop/advice.mjs';

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
  'Можно текстом или голосовым — голос расшифрую прямо на устройстве, аудио никуда не уходит.',
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

// Скачать файл из Telegram по file_id → Buffer.
async function downloadFile(fileId) {
  const r = await fetch(`${API}/getFile?file_id=${fileId}`);
  const j = await r.json();
  if (!j.ok) throw new Error('getFile не сработал');
  const fr = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${j.result.file_path}`);
  return Buffer.from(await fr.arrayBuffer());
}

// Расшифровать голосовое on-device. transcribe.mjs (тяжёлый ML) грузится лениво — только тут.
let transcribeFn = null;
async function transcribeVoice(fileId) {
  const buf = await downloadFile(fileId);
  if (!transcribeFn) ({ transcribe: transcribeFn } = await import('./transcribe.mjs'));
  return transcribeFn(buf);
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

  // Голосовое / аудио / видео-кружок → расшифровка on-device → в лог как обычная запись.
  const voice = msg.voice || msg.audio || msg.video_note;
  if (voice) {
    await send(chatId, '🎧 расшифровываю…');
    try {
      const heard = await transcribeVoice(voice.file_id);
      if (!heard) {
        await send(chatId, 'Не разобрал — попробуй ещё раз, чуть ближе к микрофону.');
        return;
      }
      appendInbox(heard);
      await send(chatId, `✓ записал (голос): ${heard}\n\nНе то расслышал? /undo и надиктуй заново.`);
    } catch (e) {
      await send(chatId, `Сбой расшифровки: ${e.message}`);
    }
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
    const snap = await fetchSnapshot();
    if (!snap.parts.length) {
      await send(chatId, 'Whoop пока молчит — синк ещё не прошёл или нет свежей ночи. Загляни попозже.');
      return;
    }
    const advice = whoopAdvice(snap, whoopBaseline(), whoopTrend());
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
    await send(chatId, 'Пришли текст или голосовое — запишу. Фото пока не умею.');
    return;
  }

  appendInbox(text);
  await send(chatId, `✓ записал в ${todayISO()}`);
}

async function loop() {
  console.log('[bot] запущен (long-polling). Ctrl+C для остановки.');
  await registerCommands();
  // Прогрев Whisper в фоне — чтобы первое голосовое не ждало загрузку модели в память.
  import('./transcribe.mjs').then((m) => m.warmup()).catch(() => {});
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
