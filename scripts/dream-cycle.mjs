#!/usr/bin/env node
// dream-cycle.mjs — еженедельный LLM-аудит KB по аналогии с gbrain «dream».
//
// Использование:
//   node scripts/dream-cycle.mjs                # сгенерировать промпт + сохранить в .context/dream-report-YYYY-MM-DD.md
//   node scripts/dream-cycle.mjs --execute      # дополнительно прогнать через `claude -p` (если CLI в PATH)
//   node scripts/dream-cycle.mjs --dry-run      # только напечатать промпт в stdout, не сохранять
//   node scripts/dream-cycle.mjs --days 14      # окно (по умолчанию 7)
//
// Что собирает в промпт:
//   • Список .md-файлов, изменённых в последние N дней (git log)
//   • Полностью /04_synthesis/open-questions.md и /04_synthesis/contradictions.md
//   • Tail последнего раздела /log.md (~120 строк)
//   • Список 10 самых старых synthesis-файлов (потенциально устаревшее)
//
// Задаёт LLM три вопроса:
//   1. Что из open-questions / contradictions могло устареть с учётом последних коммитов?
//   2. Какие новые противоречия видны в diff'е?
//   3. Какие synthesis/wiki-файлы стоит обновить (с обоснованием через цитаты)?
//
// Никогда не пишет в /03_wiki, /04_synthesis, /05_decisions — только в .context/.
// Пользователь сам решает, что коммитить.

import { existsSync, statSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(here, '..');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const execute = argv.includes('--execute');
const daysIdx = argv.indexOf('--days');
const days = daysIdx >= 0 ? parseInt(argv[daysIdx + 1], 10) : 7;
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days должно быть положительным числом');
  process.exit(1);
}

const today = new Date();
const todayISO = today.toISOString().slice(0, 10);
const sinceISO = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);

// ---------- 1. Изменённые файлы за окно (git log) ----------

function gitLogFiles(sinceDate) {
  const r = spawnSync('git', [
    'log',
    `--since=${sinceDate}`,
    '--name-only',
    '--pretty=format:===%h %ad %s',
    '--date=short',
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) return { commits: [], files: [] };
  const blocks = r.stdout.split('\n===').filter(Boolean);
  const commits = [];
  const filesSet = new Set();
  for (const b of blocks) {
    const lines = b.replace(/^===/, '').split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const [head, ...rest] = lines;
    commits.push(head);
    for (const f of rest) {
      if (f.endsWith('.md')) filesSet.add(f);
    }
  }
  return { commits, files: Array.from(filesSet) };
}

const { commits, files: changedMd } = gitLogFiles(sinceISO);

// ---------- 2. Ключевые synthesis-файлы ----------

function readSafe(rel) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return null;
  try { return readFileSync(abs, 'utf8'); } catch { return null; }
}

const openQuestions = readSafe('04_synthesis/open-questions.md');
const contradictions = readSafe('04_synthesis/contradictions.md');
const logTail = (() => {
  const raw = readSafe('log.md');
  if (!raw) return null;
  const all = raw.split('\n');
  return all.slice(Math.max(0, all.length - 120)).join('\n');
})();

// ---------- 3. Самые старые synthesis-файлы ----------

function* walkMd(layer) {
  const root = join(REPO_ROOT, layer);
  if (!existsSync(root)) return;
  yield* walkDir(root);
}
function* walkDir(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkDir(full);
    else if (e.isFile() && extname(e.name) === '.md') yield full;
  }
}

const synthesisFiles = [];
for (const abs of walkMd('04_synthesis')) {
  const st = statSync(abs);
  synthesisFiles.push({ rel: relative(REPO_ROOT, abs), mtimeMs: st.mtimeMs });
}
synthesisFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
const oldestSynthesis = synthesisFiles.slice(0, 10).map((f) => ({
  file: f.rel,
  age_days: Math.floor((today.getTime() - f.mtimeMs) / 86_400_000),
}));

// ---------- 4. Собираем промпт ----------

const lines = [];
lines.push(`# Dream cycle — KB-аудит на ${todayISO}`);
lines.push('');
lines.push(`Окно: последние **${days} дней** (с ${sinceISO}). Коммитов: ${commits.length}. Изменённых .md: ${changedMd.length}.`);
lines.push('');
lines.push('---');
lines.push('');
lines.push('## Системная инструкция');
lines.push('');
lines.push('Ты помогаешь поддерживать локальную KB в актуальном состоянии. Отвечай на русском.');
lines.push('Используй метки утверждений из AGENTS.md: `FACT/INFERENCE/ASSUMPTION/UNKNOWN/RISK/DECISION/RECOMMENDATION`.');
lines.push('Каждое нетривиальное утверждение — со ссылкой `[source: /path]`.');
lines.push('');
lines.push('Твоя задача — провести аудит и выдать структурированный отчёт по трём разделам ниже.');
lines.push('Это **дроп-зона**: ничего не правится в репозитории. Выводи только аналитику.');
lines.push('');
lines.push('## Что нужно сделать');
lines.push('');
lines.push('### 1. Что могло устареть');
lines.push('Сопоставь `04_synthesis/open-questions.md` и `04_synthesis/contradictions.md` с коммитами за окно.');
lines.push('Найди пункты, которые:');
lines.push('  - могли быть закрыты новыми источниками (out of date — пометь как `UNKNOWN: проверить, не закрыто ли`);');
lines.push('  - наоборот, требуют переоценки (пометь как `RISK:`).');
lines.push('Дай 5–10 конкретных пунктов с цитатами на затронутые файлы.');
lines.push('');
lines.push('### 2. Новые противоречия');
lines.push('Прочитай свежие коммиты и выяви противоречия с уже зафиксированными в `contradictions.md` или внутри новых файлов.');
lines.push('Формат: «Источник A vs Источник B → природа конфликта → confidence для каждой стороны».');
lines.push('Если новых противоречий нет — явно скажи `FACT: новых противоречий не обнаружено за окно`.');
lines.push('');
lines.push('### 3. Synthesis к обновлению');
lines.push('Перечисли 3–5 файлов из `/04_synthesis/`, которые с учётом новых коммитов следует обновить.');
lines.push('Для каждого: какой раздел, что добавить, ссылка на свежий источник.');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## Контекст: коммиты за окно');
lines.push('');
lines.push('```');
for (const c of commits.slice(0, 80)) lines.push(c);
if (commits.length > 80) lines.push(`... ещё ${commits.length - 80}`);
lines.push('```');
lines.push('');
lines.push('## Контекст: изменённые .md за окно');
lines.push('');
if (changedMd.length === 0) {
  lines.push('_(нет)_');
} else {
  for (const f of changedMd) lines.push(`- ${f}`);
}
lines.push('');
lines.push('## Контекст: 10 самых старых synthesis-файлов');
lines.push('');
for (const f of oldestSynthesis) lines.push(`- ${f.file}   возраст=${f.age_days}д`);
lines.push('');
lines.push('---');
lines.push('');
lines.push('## /04_synthesis/open-questions.md');
lines.push('');
lines.push(openQuestions ?? '_(файл не найден)_');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## /04_synthesis/contradictions.md');
lines.push('');
lines.push(contradictions ?? '_(файл не найден)_');
lines.push('');
lines.push('---');
lines.push('');
lines.push('## tail /log.md (последние ~120 строк)');
lines.push('');
lines.push(logTail ?? '_(файл не найден)_');
lines.push('');

const promptText = lines.join('\n');

// ---------- 5. Вывод ----------

if (dryRun) {
  console.log(promptText);
  process.exit(0);
}

const outDir = join(REPO_ROOT, '.context');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `dream-report-${todayISO}.md`);

if (execute) {
  // Попробуем через claude CLI.
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (which.status !== 0) {
    writeFileSync(outPath, promptText);
    console.log(`[dream] claude CLI не найден; сохранил промпт в ${relative(REPO_ROOT, outPath)}`);
    console.log('[dream] скопируйте файл в любой LLM, ответ положите рядом как dream-answer-YYYY-MM-DD.md');
    process.exit(0);
  }
  const res = spawnSync('claude', ['-p', promptText], { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGTERM' });
  if (res.error || res.signal === 'SIGTERM') {
    writeFileSync(outPath, promptText);
    console.log(`[dream] claude не ответил за 5 мин (${res.error?.code || res.signal}); сохранил промпт в ${relative(REPO_ROOT, outPath)}`);
    process.exit(0);
  }
  const answer = res.stdout || '(пусто)';
  const combined = [
    `# Dream cycle ${todayISO} — ответ Claude`,
    '',
    '> Промпт целиком в нижней секции, ниже — синтез.',
    '',
    answer,
    '',
    '---',
    '',
    '# Использованный промпт',
    '',
    promptText,
  ].join('\n');
  writeFileSync(outPath, combined);
  console.log(`[dream] готово, сохранено в ${relative(REPO_ROOT, outPath)}`);
} else {
  writeFileSync(outPath, promptText);
  console.log(`[dream] промпт сохранён в ${relative(REPO_ROOT, outPath)}`);
  console.log('[dream] скопируйте файл в Claude/любой LLM. Для авто-прогона — флаг --execute (нужен claude CLI).');
}
