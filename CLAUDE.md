# Правила проекта — health-harness

> Этот файл загружается Claude Code как **operational rules**: язык, дисциплина, привычки, домен-правила.
> AGENTS.md описывает как работать с KB о здоровье. CLAUDE.md — как работать в этом конкретном репо.

## Язык

Все артефакты (логи, документы, коммиты) — на **русском**.
На латинице в любом случае: ID/ключи/имена файлов/переменных; имена собственные (Whoop, Blueprint,
HRV, REM, SpO2); аббревиатуры; цифры и единицы (₽, %, мс, ч, мин.).

## Дисциплина веток

- Работаем в feature-ветке, мерджим в `main` через ff-merge. Без force-push.
- После пуша в `main` — короткое резюме: что сделано + как проверить.
- Перед мержем значимых правок — `pnpm kb:doctor` (EXIT 0).

## Артефакты — сразу в git

`.context/` — gitignored зона для черновиков. Любой значимый артефакт (документ с frontmatter
`type:`/`version:`) — сразу в коммитимую зону: synthesis → `/04_synthesis/`, решения и эксперименты →
`/05_decisions/`, финальное для людей → `/06_outputs/`.

## Слои оснастки (AI harness)

| Слой | Где живёт | Роль |
|---|---|---|
| **System prompt** | [`AGENTS.md`](./AGENTS.md) | reading order, метки, медицинская граница, ingest |
| **Operational rules** | [`CLAUDE.md`](./CLAUDE.md) (этот файл) | язык, ветки, домен-правила здоровья |
| **Permissions + Hooks** | [`.claude/settings.json`](./.claude/settings.json) | что разрешено авто, какие хуки проверяют записи |
| **Working memory** | [`.remember/core.md`](./.remember/core.md) | semantic invariant (коммитится) |
| **Skills** | [`skills/`](./skills/) | плейбуки: red-recovery, sleep-debt, mood-dip, injury, getting-back, weekly-synthesis, coach |
| **Whoop ingest** | [`scripts/whoop/`](./scripts/whoop/) | `auth.mjs` (OAuth разово), `sync.mjs` (утро: физиология → daily-лог) |
| **Semantic search** | [`scripts/semantic/`](./scripts/semantic/) | on-device hybrid RAG: `search.mjs`, `think.mjs`, `backlinks.mjs` |
| **MCP-сервер KB** | [`scripts/semantic/mcp-server.mjs`](./scripts/semantic/mcp-server.mjs) | `kb_search`, `kb_think`, `kb_backlinks`. Конфиг: [`.mcp.json`](./.mcp.json) |
| **KB-doctor** | [`scripts/kb-doctor.mjs`](./scripts/kb-doctor.mjs) | health-check KB: frontmatter, broken `related:`, orphans |
| **Dream cycle** | [`scripts/dream-cycle.mjs`](./scripts/dream-cycle.mjs) | еженедельный LLM-аудит KB |

## Здоровье (домен-правила)

Правила приняты заранее, спокойной головой — чтобы в момент не нужна была воля:

- **Красный recovery (Whoop) → день автоматически лёгкий.** Тяжёлая тренировка и сложные переговоры
  режутся, добавляется прогулка и ранний отбой. Без переговоров с собой в моменте. Плейбук:
  [`skills/health-red-recovery.md`](./skills/health-red-recovery.md).
- **Два сна <6ч подряд = жёлтый флаг**, обязательный разбор причины. Плейбук:
  [`skills/health-sleep-debt.md`](./skills/health-sleep-debt.md).
- **Gate тяжёлой тренировки: recovery <50% → нет.** Сначала проверь recovery, потом планируй нагрузку.
- **Метрики — прокси.** Не оптимизируем HRV ради HRV; north-star — субъективное «стало ли мне лучше жить»
  (см. [`00_context/health-metrics.md`](./00_context/health-metrics.md)).
- **Одна переменная за раз** в экспериментах — иначе синтез не атрибутирует эффект.
- **Никаких диагнозов.** Агент не трактует симптомы как болезни; тревожный сигнал → врач (см. AGENTS.md).
- **Настроение ≤2/5 три дня подряд** → сначала чеклист базы (сон/движение/солнце/соцконтакт/еда),
  только потом выводы о жизни. Плейбук: [`skills/health-mood-dip.md`](./skills/health-mood-dip.md).

### Ритуалы (hooks-слой)

Это расписание, а не tool-hooks. Можно обернуть в cron / `/schedule`:

- **Утро:** `pnpm whoop:sync` → recovery определяет цвет дня (зелёный/жёлтый/красный плейбук).
- **Вечер:** дополнить daily-лог ментальной строкой (~20 сек).
- **Воскресенье 18:00:** weekly-синтез ([`skills/health-weekly-synthesis.md`](./skills/health-weekly-synthesis.md)).
- **Конец месяца:** разбор по 5 сферам жизни (достижения/провалы/корректируем) + 6 граней
  ([`skills/health-life-review.md`](./skills/health-life-review.md)); ведёт приватный `.context/coaching/spheres.md`.
- **Триггер:** HRV ниже личного бейзлайна 3+ дня → внеплановый разбор.

## Запуск проекта

Требования: Node 22 (`.nvmrc`), pnpm через `corepack enable`.

```bash
pnpm run setup           # установка под-пакетов (semantic, skillopt, viewer)
cp .env.example .env     # вписать WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET
pnpm whoop:auth          # разовый OAuth (откроет браузер, сохранит refresh-токен в .whoop/)
pnpm whoop:sync          # утренний sync: физиология Whoop → сегодняшний daily-лог
pnpm kb:index            # построить семантический индекс
pnpm kb:search "запрос"   # гибридный поиск (vector + BM25 + RRF)
pnpm kb:think "вопрос"    # синтез с цитатами по правилам AGENTS.md
pnpm kb:doctor           # health-check KB
pnpm viewer:dev          # локальный viewer (граф/поиск)
```

Перед коммитом значимых правок KB — `pnpm kb:doctor` (должен быть EXIT 0).
