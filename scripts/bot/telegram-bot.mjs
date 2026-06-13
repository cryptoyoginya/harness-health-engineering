#!/usr/bin/env node
// telegram-bot.mjs — тупой сборщик: ловит сообщения в Telegram и дописывает их в
// сегодняшний daily-лог. Никакого LLM, никаких ключей кроме токена бота. Бесплатно.
// Long-polling (getUpdates) — публичный сервер/вебхук не нужен, работает локально за NAT.
//
// Логика: всё, что ты пишешь боту, падает строкой `- HH:MM <текст>` в секцию `## входящие`
// сегодняшнего файла /01_raw/health/<дата>.md. Структурирование и анализ — на агенте (Claude Code).

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, requireEnv, todayISO } from '../whoop/lib.mjs';
import { fetchSnapshot, whoopBaseline, whoopTrend, whoopAdvice } from '../whoop/advice.mjs';
import { formatExperiments, createExperiment, cancelExperiment, extendExperiment, activeExperiments, recordSlip, MAX_ACTIVE } from '../experiments.mjs';
import { getNorthStar, setNorthStar } from '../northstar.mjs';
import { listHabits, addHabit } from '../habits.mjs';

loadEnv();
const TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
const ALLOWED = process.env.TELEGRAM_CHAT_ID || ''; // если пусто — бот подскажет твой chat_id
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(ROOT, '.bot', 'offset');

const nowHM = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Онбординг и /help. Задача — объяснить контракт: что писать, как это работает, что в воскресенье.
const INTRO = [
  'Хеллоу!',
  '',
  'Это вход в твой health-harness — локальную AI-лабораторию качества жизни, которая помогает отличить настоящие рычаги улучшения жизни от метрик, которые просто красиво растут.',
  '',
  'Коротко: harness — это всё, что окружает модель и превращает её из чата в работающую систему. Сразу спойлер: Whoop Journal хорош как сенсорный слой. Он видит физиологию и привычки. Harness-health — это decision layer поверх всей жизни, не только тела.',
  '',
  'Я — слой захвата: всё, что ты шлёшь, ложится во временной лог дня и копится для анализа. Обработка приватная, на твоём устройстве — наружу ничего не уходит 🤪',
  '',
  '❤️‍🔥 Главное правило: пиши, говори, фоткай всё, что посчитаешь нужным.',
  '',
  'Шли как удобно, можно вперемешку, я умный и пойму тебя (и моя создательница тоже):',
  '• текстом',
  '• голосовым — расшифрую прямо на устройстве (аудио никуда не уходит)',
  '• селфи — коплю в локальный визуальный дневник; динамику кожи/лица/отёков потом смотрит агент по запросу',
  '😁 по желанию — фото еды или стула: сам пойму, что на фото. Разложу в отдельный дневник: еду агент разберёт по составу/таймингу, стул — по Бристольской шкале.',
  '',
  'Несколько записей и несколько селфи за день — это норма и даже лучше: каждое сообщение падает строкой «- 14:30 твой текст» в файл сегодняшнего дня, и по таймстемпам виден ход дня, а не один усреднённый итог.',
  '',
  'Фиксируй всё, что считаешь важным, своими словами. Особенно ценно, если иногда заденешь что-то из этого:',
  '• сколько часов работала',
  '• с кем общалась — какие люди, в какой обстановке',
  '• какие эмоции и общее настроение',
  '• как оценишь уровень энергии',
  '• что впечатлило',
  '• что беспокоило',
  '• насколько была сфокусирована',
  '• пила ли алкоголь',
  '• употребляла ли вещества',
  '• как самочувствие',
  '• что ела',
  '• бады',
  '• новые мысли и инсайты',
  '• что хочется повторить',
  '• что хочется убрать',
  '• главное — ощущаешь ли, что день прожит так, как хотелось',
  '',
  'Чем живее и честнее детали, тем сильнее выводы. Recovery, HRV и сон Whoop тянет сам по утрам — дублировать не надо; утром пришлю короткий бриф по телу.',
  '',
  'По воскресеньям — разбор недели: агент читает 7 логов, находит паттерны, которые сам не замечаешь, выносит вердикт «лучше ли живётся» и, если гипотеза созрела, заводит n-of-1 эксперимент.',
  '',
  'Два слова про главное:',
  '• North-star — твоё долгосрочное направление: куда ты хочешь, чтобы шла жизнь (смысл, не цифра). Обязательно задай его командой /north — от него зависит, к чему я тебя приведу. Без него я оптимизирую вслепую.',
  '• n-of-1 эксперимент — личная проверка одной гипотезы: меняешь ровно одну переменную на пару недель, я смотрю эффект на твоих данных, и в конце вердикт — оставить или откатить. Так находим, что работает именно у тебя, а не «вообще». Заводить, отменять и продлевать — командой /exp.',
  '',
  'А если будешь со мной долго, мы сможем понять, как меняется твое качество жизни в перспективе 😎',
  '',
  'Ритм: утром — бриф по телу, пару раз за день мягко напомню о себе вопросом по разным сферам, вечером — короткая сводка дня. Не до этого — /quiet, и я притихну.',
  '',
  'Команды:',
  '/whoop — показатели сейчас (recovery, сон, HRV, светофор дня)',
  '/week — сводка за 7 дней · /month · /year',
  '/exp — n-of-1 эксперименты (завести · отменить · продлить · /exp slip — срыв)',
  '/north — north-star: твоё долгосрочное направление',
  '/habit — что у тебя уже устойчиво (15к шагов, омега…), чтобы я знала базу',
  '/today — сегодняшний лог · /undo — убрать последнюю запись',
  '/quiet — тихий режим · /help — это сообщение',
  '',
  'Просто начни писать или говорить. Это твой склад всего, что хочется знать о себе. Если нет желания поделиться со мной новостями, то ничего страшного. Это не должно быть твоей ежедневной работой. Всё уже супер :)',
  '',
  'Body data in. Life decisions out 🤍',
].join('\n');

// Ответы бота на фото по типу. Бот только хранит локально; разбор — у агента, недиагностично.
const PHOTO_REPLY = {
  selfie: (rel) => `✓ селфи сохранила локально (${rel}) — фото не уходит с устройства.\nДинамику разберёт агент: скажи ему «посмотри селфи за неделю».`,
  stool: (rel) => `✓ сохранила (стул) локально (${rel}) — приватно, с устройства не уходит.\nАгент разберёт по Бристольской шкале: «разбери стул за неделю». Не диагностика; кровь/чёрный/стойкие изменения — к врачу.`,
  food: (rel) => `✓ сохранила (еда) локально (${rel}).\nАгент разберёт состав и тайминг: «разбери еду за неделю». Точнее, если подпишешь — что это и во сколько.`,
};

// Краткая справка по /exp — показывается при нажатии /exp и при ошибке ввода.
const EXP_HELP = [
  'Как пользоваться:',
  '• завести: /exp new <гипотеза> — напр. «/exp new убрать сахар после 18:00 — проверить сон»',
  '   срок по умолчанию 3 недели; свой задаётся фразой в конце: «… на 2 недели»',
  '• отменить: /exp stop <номер>',
  '• продлить: /exp extend <номер> [недель] — по умолчанию +2',
  '• срыв: /exp slip <что нарушила> — фиксируем честно, это уточняет вывод',
  `Максимум ${MAX_ACTIVE} активных за раз — меньше параллельных, чище атрибуция.`,
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

// Тип фото по подписи, если она явно указывает категорию. Иначе null → решит зрение.
function captionKind(caption = '') {
  const c = caption.toLowerCase();
  const has = (...w) => w.some((x) => c.includes(x));
  if (has('стул', 'кал', 'туалет', 'какашк', 'poop', 'stool')) return 'stool';
  if (has('еда', 'еду', 'ела', 'поел', 'food', 'meal', 'завтрак', 'обед', 'ужин', 'перекус', 'блюдо', 'breakfast', 'lunch', 'dinner', 'snack')) return 'food';
  if (has('селфи', 'selfie', 'лицо', 'face', 'портрет')) return 'selfie';
  return null;
}

const PHOTO_SUBDIR = { selfie: '', stool: 'stool', food: 'food' };

// Сохранить буфер фото в локальный дневник (gitignored — приватные данные не уходят в репо).
function savePhoto(buf, kind = 'selfie') {
  const sub = PHOTO_SUBDIR[kind] ?? '';
  const dir = join(ROOT, '01_raw', 'health', 'photos', sub);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/:/g, '');
  const name = `${todayISO()}-${stamp}.jpg`;
  writeFileSync(join(dir, name), buf);
  return sub ? `photos/${sub}/${name}` : `photos/${name}`;
}

// Тип фото без подписи — on-device CLIP (vision.mjs грузится лениво). При сбое → null (фолбэк селфи).
let classifyImageFn = null;
async function detectPhotoKind(buf) {
  try {
    if (!classifyImageFn) ({ classifyImage: classifyImageFn } = await import('./vision.mjs'));
    return (await classifyImageFn(buf)).kind;
  } catch { return null; }
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

// --- Сводка за период из daily-логов. Использует /week (7), /month (30), /year (365). ---
function summarizeRange(days) {
  const recs = [], sleeps = [], moods = [], energies = [];
  let logged = 0, nights7 = 0;
  for (let i = 0; i < days; i++) {
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
const weekSummary = () => summarizeRange(7);

// Строки-метрики для сводки (общие для /week /month /year).
// Цифрами — ТОЛЬКО объективные данные Whoop. Субъективное (настроение/энергия/смысл)
// намеренно не усредняем в балл: «средняя температура по больнице» врёт. Это — у агента качественно.
function summaryLines(w) {
  const lines = [];
  if (w.recAvg != null)   lines.push(`• recovery: ср. ${Math.round(w.recAvg)}%`);
  if (w.sleepAvg != null) lines.push(`• сон: ср. ${w.sleepAvg.toFixed(1)} ч · ночей ≥7ч: ${w.nights7}/${w.sleepDays}`);
  if (!lines.length) lines.push('• данных Whoop за период пока нет');
  lines.push('', 'Настроение, энергия, смысл в цифру не свожу — это не усредняется честно. Качественный разбор и вердикт «лучше ли живётся» — у агента.');
  return lines;
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
    { command: 'month', description: 'разбор за месяц' },
    { command: 'year',  description: 'разбор за год' },
    { command: 'exp',   description: 'n-of-1 эксперименты' },
    { command: 'north', description: 'north-star — моё направление' },
    { command: 'habit', description: 'мои базовые привычки' },
    { command: 'today', description: 'сегодняшний лог целиком' },
    { command: 'undo',  description: 'убрать последнюю запись' },
    { command: 'quiet', description: 'тихий режим: вкл/выкл напоминания' },
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

  // Фото → локальный дневник. Тип по подписи: селфи (умолч.) / стул / еда. Хранит бот, «смотрит» агент.
  const photo = (msg.photo && msg.photo[msg.photo.length - 1]) ||
    (msg.document && /^image\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (photo) {
    const cap = (msg.caption || '').trim();
    try {
      const buf = await downloadFile(photo.file_id);
      // Подпись важнее (явный выбор пользователя); нет подписи — определяет зрение; фолбэк — селфи.
      const kind = captionKind(cap) || (await detectPhotoKind(buf)) || 'selfie';
      const rel = savePhoto(buf, kind);
      const mark = kind === 'stool' ? '💩 стул' : kind === 'food' ? '🍽 еда' : '📸 селфи';
      appendInbox(`${mark} → ${rel}${cap ? ' — ' + cap : ''}`);
      await send(chatId, PHOTO_REPLY[kind](rel));
    } catch (e) {
      await send(chatId, `Не смогла сохранить фото: ${e.message}`);
    }
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
    const lines = [`🗓 Неделя (${w.logged}/7 дней с логом):`, ...summaryLines(w)];
    lines.push('', 'Глубокий разбор — в воскресенье скажи агенту «разбери неделю».');
    await send(chatId, lines.join('\n'));
    return;
  }
  if (text === '/month') {
    const w = summarizeRange(30);
    if (w.logged < 14) {
      await send(chatId, `🗓 Месячный разбор: данных пока мало (${w.logged} дн с логом за 30 дней).\nОн оживёт после ~3–4 недель регулярных записей — там видны паттерны, которых не поймать за неделю.\nОстаёмся на связи! 🤍`);
      return;
    }
    const lines = [`🗓 Месяц (${w.logged}/30 дней с логом):`, ...summaryLines(w)];
    lines.push('', 'Глубокий месячный разбор — у агента: скажи «разбери месяц» (что отличало хорошие недели, рычаги, метрики-пустышки).');
    await send(chatId, lines.join('\n'));
    return;
  }
  if (text === '/year') {
    const w = summarizeRange(365);
    if (w.logged < 90) {
      await send(chatId, `📅 Годовой разбор: пока рано — ${w.logged} дн с логом.\nЭто марафон: годовой обзор показывает, как меняется качество жизни в больших циклах (сезоны, фазы). Накопится за несколько месяцев — я никуда не денусь.\nОстаёмся на связи! 🤍`);
      return;
    }
    const lines = [`📅 Год (${w.logged} дней с логом):`, ...summaryLines(w)];
    lines.push('', 'Глубокий годовой обзор — у агента: скажи «разбери год» (сезонность, рост, сверка с north-star).');
    await send(chatId, lines.join('\n'));
    return;
  }
  if (text === '/exp' || text.startsWith('/exp ')) {
    const arg = text.slice(4).trim();
    if (!arg) {
      await send(chatId, `${formatExperiments()}\n\n${EXP_HELP}`);
      return;
    }
    const sub = arg.split(/\s+/)[0].toLowerCase();
    const payload = arg.slice(sub.length).trim();
    if (['new', 'новый', 'add', '+'].includes(sub)) {
      if (!payload) {
        await send(chatId, `Опиши гипотезу: /exp new <что меняешь и что проверяешь>\n\n${EXP_HELP}`);
        return;
      }
      if (activeExperiments().length >= MAX_ACTIVE) {
        await send(chatId, `Уже ${MAX_ACTIVE} активных эксперимента — это потолок. Чем меньше идёт параллельно, тем чище видно, что сработало (одна переменная за раз). Заверши или отмени один: /exp stop <номер>.`);
        return;
      }
      // срок: «на N недель» в конце фразы → задаёт длительность, иначе 3 недели
      let weeks = 3, hyp = payload;
      const m = hyp.match(/\bна\s+(\d{1,2})\s*(?:недел[яьи]|нед)\.?\b/i);
      if (m) { weeks = Math.min(12, Math.max(1, +m[1])); hyp = hyp.replace(m[0], '').replace(/\s{2,}/g, ' ').trim(); }
      const e = createExperiment(hyp, weeks);
      appendInbox(`🧪 завела эксперимент ${e.title}`);
      await send(chatId, `🧪 Завела ${e.title}\nЧерновик, срок ${weeks} нед (до ${e.endsOn}). Дизайн (baseline, критерий) агент уточнит на ближайшем разборе — так точнее.`);
      return;
    }
    if (['stop', 'cancel', 'отмена', 'стоп', '-'].includes(sub)) {
      if (!payload) { await send(chatId, 'Укажи номер: /exp stop 1 (номер виден в /exp)'); return; }
      const r = cancelExperiment(payload);
      await send(chatId, r ? `↩️ Отменила ${r.title} (revert).` : `Не нашла эксперимент «${payload}». Список — /exp`);
      return;
    }
    if (['extend', 'продлить', 'продли', 'prolong'].includes(sub)) {
      const [num, wkRaw] = payload.split(/\s+/);
      if (!num) { await send(chatId, 'Укажи номер: /exp extend 1 (по умолчанию +2 недели; можно «/exp extend 1 3»)'); return; }
      const wk = wkRaw ? Math.min(12, Math.max(1, parseInt(wkRaw, 10) || 2)) : 2;
      const r = extendExperiment(num, wk);
      await send(chatId, r ? `⏳ Продлила ${r.title} на ${wk} нед — теперь до ${r.endsOn}.` : `Не нашла эксперимент «${num}». Список — /exp`);
      return;
    }
    if (['slip', 'срыв', 'сорвалась', 'нарушила'].includes(sub)) {
      if (!payload) { await send(chatId, 'Опиши срыв: /exp slip <что нарушила>\nНапр.: /exp slip выпила кофе в 17:00, хотя отсекаю в 14'); return; }
      appendInbox(`⚠️ срыв эксперимента: ${payload}`);
      const r = recordSlip(payload);
      if (r.count === 1) await send(chatId, `✓ Записала срыв в ${r.title}. Это не провал — честный confounder делает вывод точнее. Эксперимент продолжается.`);
      else if (r.count === 0) await send(chatId, '✓ Записала в лог. Активных экспериментов нет — учту как обычную заметку дня.');
      else await send(chatId, `✓ Записала в лог. Активных экспериментов несколько (${r.count}) — агент разнесёт срыв по нужному на разборе.`);
      return;
    }
    await send(chatId, `Не поняла команду.\n\n${EXP_HELP}`);
    return;
  }
  if (text === '/north' || text.startsWith('/north ')) {
    const arg = text.slice(6).trim();
    if (!arg) {
      const ns = getNorthStar();
      await send(chatId, ns
        ? `🧭 Твой north-star:\n\n${ns}\n\nИзменить: /north <новое направление>`
        : 'North-star ещё не задан.\nЭто твоё долгосрочное направление — куда ты хочешь, чтобы шла жизнь (смысл, не цифра). Агент будет сверять с ним недельные и квартальные выводы.\nЗадай: /north <текст>\nНапр.: /north больше энергии и тёплых связей, меньше тревоги и спешки');
      return;
    }
    const prev = getNorthStar();
    setNorthStar(arg);
    const head = prev ? `🧭 Обновила north-star (было: «${prev}»):` : '🧭 Записала north-star:';
    await send(chatId, `${head}\n\n${arg}\n\nТеперь это твой ориентир — агент сверяет с ним, туда ли движется жизнь.`);
    return;
  }
  if (text === '/habit' || text.startsWith('/habit ')) {
    const arg = text.slice(6).trim();
    if (!arg) {
      const h = listHabits();
      await send(chatId, h.length
        ? `🌱 Твои привычки/база (агент учитывает как данность):\n${h.map((x) => '• ' + x).join('\n')}\n\nДобавить: /habit <что уже делаешь>`
        : 'Пока пусто. Сюда вносим то, что у тебя УЖЕ устойчиво — агент не будет это «открывать» заново и учтёт как базу.\nНапр.: /habit 15 000 шагов каждый день · /habit омега-3 ежедневно несколько лет');
      return;
    }
    const list = addHabit(arg);
    await send(chatId, `🌱 Запомнила как базовую привычку: «${arg}».\nВсего в базе: ${list.length}. Агент учтёт это в разборах.`);
    return;
  }
  if (text === '/quiet') {
    if (existsSync(QUIET_FILE)) {
      unlinkSync(QUIET_FILE);
      await send(chatId, '🔔 Напоминания и сводки снова включены.');
    } else {
      mkdirSync(join(ROOT, '.bot'), { recursive: true });
      writeFileSync(QUIET_FILE, '1');
      await send(chatId, '🤫 Тихий режим включён — напоминания и утренняя/вечерняя сводка приходить не будут. /quiet ещё раз — вернуть.');
    }
    return;
  }
  if (text === '/undo') {
    const removed = undoLast();
    await send(chatId, removed ? `↩️ убрал: ${removed}` : 'Сегодня нечего убирать.');
    return;
  }
  if (!text) {
    await send(chatId, 'Пришли текст, голосовое или селфи — запишу. Другие типы (стикеры, гео) пока не умею.');
    return;
  }

  appendInbox(text);
  await send(chatId, `✓ записал в ${todayISO()}`);
}

// Воскресный пинг «пора разобрать неделю» — раз в воскресенье после 18:00, один раз за день.
const PING_FILE = join(ROOT, '.bot', 'weekly-ping');
async function maybeWeeklyPing() {
  if (!ALLOWED) return;
  const now = new Date();
  if (now.getDay() !== 0 || now.getHours() < 18) return; // 0 = воскресенье
  let last = '';
  try { last = readFileSync(PING_FILE, 'utf8').trim(); } catch { /* первого раза ещё не было */ }
  const today = todayISO();
  if (last === today) return;
  mkdirSync(join(ROOT, '.bot'), { recursive: true });
  writeFileSync(PING_FILE, today);
  await send(ALLOWED, '🗓 Воскресенье — пора разобрать неделю.\nОткрой агента в health-harness и скажи «разбери неделю»: он сведёт 7 дней → найдёт паттерны → вердикт «лучше ли живётся» и сверит активные эксперименты с данными.');
}

// --- Дневные пуши: напоминание (день) + вечерняя сводка. Утренняя — у whoop:sync в 9:00. ---
const QUIET_FILE = join(ROOT, '.bot', 'quiet');

// Рандомные вопросы по всем сферам жизни; модальность (гс/селфи/фото) подсказана эмодзи.
const REMINDERS = [
  '🎙 Как настроение и энергия прямо сейчас? Можно голосовым, в двух словах.',
  '🤳 Скинь селфи для визуального дневника — как ты сегодня.',
  'С кем сегодня общалась и как тебе после этого?',
  'Сколько успела поработать и как с фокусом?',
  'Как тело — где-то зажато, болит, или наоборот лёгкость?',
  '🍽 Что ела последним? Можешь просто сфоткать.',
  'Какая мысль или инсайт сегодня зацепил?',
  'Было сегодня что-то осмысленное — ради чего?',
  'Что больше всего впечатлило или, наоборот, беспокоило?',
  'День шёл как ты хотела — или несло?',
  'Кофе, алкоголь или что-то ещё сегодня было?',
  '🎙 Двигалась сегодня — прогулка, тренировка? Черкни голосом.',
  'Бады приняла по плану?',
  'Что из сегодняшнего хочется повторить, а что — убрать?',
];
const LAST_REM_FILE = join(ROOT, '.bot', 'push-last');

function pickReminder() {
  let last = -1;
  try { last = Number(readFileSync(LAST_REM_FILE, 'utf8').trim()); } catch { /* первый раз */ }
  let i = Math.floor(Math.random() * REMINDERS.length);
  if (i === last) i = (i + 1) % REMINDERS.length; // не повторять подряд
  mkdirSync(join(ROOT, '.bot'), { recursive: true });
  writeFileSync(LAST_REM_FILE, String(i));
  return `${REMINDERS[i]}\n\n(если не до этого — просто пропусти, это не обязаловка 🤍)`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function buildEveningSummary() {
  const file = join(ROOT, '01_raw', 'health', `${todayISO()}.md`);
  let n = 0, whoop = '';
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8');
    n = (t.match(/^- \d{2}:\d{2}/gm) || []).length;
    whoop = (t.match(/^whoop:\s*(.+)$/m) || [])[1] || '';
  }
  if (n === 0 && !whoop) {
    return '🌙 Вечер. Сегодня тут пока пусто — если есть пара слов о дне и самочувствии, я здесь. А нет — тоже хорошо 🤍';
  }
  const lines = [`🌙 Вечер. За сегодня — ${n} ${plural(n, 'запись', 'записи', 'записей')}.`];
  if (whoop) lines.push(`Тело: ${whoop}`);
  lines.push('', 'Главное за день: ощущаешь, что прожила его так, как хотелось? Черкни словом или голосом — и если хочется, что повторить, а что убрать.');
  return lines.join('\n');
}

const PUSH_SLOTS = [
  { key: 'mid', h: 14, build: pickReminder },
  { key: 'eve', h: 21, build: buildEveningSummary },
];

async function maybeDailyPushes() {
  if (!ALLOWED || existsSync(QUIET_FILE)) return;
  const now = new Date(), today = todayISO();
  for (const s of PUSH_SLOTS) {
    if (now.getHours() < s.h) continue;
    const f = join(ROOT, '.bot', `push-${s.key}`);
    let last = '';
    try { last = readFileSync(f, 'utf8').trim(); } catch { /* первого раза не было */ }
    if (last === today) continue;
    mkdirSync(join(ROOT, '.bot'), { recursive: true });
    writeFileSync(f, today);
    await send(ALLOWED, s.build());
  }
}

async function loop() {
  console.log('[bot] запущен (long-polling). Ctrl+C для остановки.');
  await registerCommands();
  // Прогрев моделей в фоне — чтобы первое голосовое/фото не ждали загрузку в память.
  import('./transcribe.mjs').then((m) => m.warmup()).catch(() => {});
  import('./vision.mjs').then((m) => m.warmup()).catch(() => {});
  let offset = readOffset();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await maybeWeeklyPing();
      await maybeDailyPushes();
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
