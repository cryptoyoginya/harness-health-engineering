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

loadEnv();
const TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const ALLOWED = process.env.TELEGRAM_CHAT_ID || ''; // если пусто — бот подскажет твой chat_id
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(ROOT, '.bot', 'offset');

const nowHM = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

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

  if (text === '/start') {
    await send(chatId, 'Привет. Пиши, как прошёл день — одной фразой (настроение, энергия, бады, тренировка, еда, соц, заметки). Я складываю в лог. /today — показать сегодняшний лог.');
    return;
  }
  if (text === '/today') {
    await send(chatId, showToday());
    return;
  }
  if (!text) {
    await send(chatId, 'Пришли текст — запишу.');
    return;
  }

  appendInbox(text);
  await send(chatId, `✓ записал в ${todayISO()}`);
}

async function loop() {
  console.log('[bot] запущен (long-polling). Ctrl+C для остановки.');
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
