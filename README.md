# health-harness

Личный AI-харнесс по здоровью в духе **Blueprint** Брайана Джонсона. Репозиторий = база знаний о теле
и психике; **Whoop API** автоматически приносит физиологию; агент ведёт по слоям KB без коротких путей.

> ⚠️ Не медицинский продукт. Агент не ставит диагнозы и не трактует симптомы. Тревожный сигнал → врач.

## Что отслеживаем

Сон/восстановление · бады (стек + адхеренс) · нагрузка · виды активности · питание · социализация ·
ментальное (настроение/энергия/тревога). Объективное — Whoop (авто). Субъективное — рукой. Ценность —
на стыке.

## Интерфейс (текст-первый, без отдельного приложения)

| Поверхность | Как пользуешься |
|---|---|
| Терминал + Claude Code | «залогируй…», «красный recovery, перестрой день», «разбери неделю» |
| Markdown-файлы | вечером 1 строка в `01_raw/health/<дата>.md` (~20 сек) |
| MCP-сервер | `kb_search` / `kb_think` / `kb_backlinks` из любого MCP-клиента |
| Локальный viewer | граф связей + поиск в браузере (`pnpm viewer:dev`) |

## Цикл

Signal → Ingest → Source note (нед.) → Synthesis (нед.) → Decision/эксперимент → Output → Feedback → Iterate.
Утром физиология падает в лог сама; вечером — ментальная строка; в воскресенье агент ищет паттерны и
предлагает эксперимент (одна переменная за раз).

## Запуск

```bash
corepack enable
pnpm run setup           # под-пакеты (semantic, skillopt, viewer)
cp .env.example .env     # вписать WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET
pnpm whoop:auth          # разовый OAuth (браузер → .whoop/token.json)
pnpm whoop:sync          # утро: физиология Whoop → сегодняшний daily-лог
pnpm kb:index            # семантический индекс (первый раз — ONNX ~120 MB)
pnpm kb:search "запрос"
pnpm kb:think "вопрос"
pnpm kb:doctor           # health-check KB (EXIT 0)
```

## Структура

```
00_context/   что это, метрики, медицинская граница
01_raw/health/   daily-логи (immutable; whoop-строка — авто)
02_sources/health/   недельные source-notes (FACT/INFERENCE)
03_wiki/   бейзлайны, реестр бадов, таксономия активностей
04_synthesis/   паттерны недели, open questions
05_decisions/experiments/   эксперименты
06_outputs/   артефакты для людей (планы, рутины)
skills/   плейбуки (red-recovery, sleep-debt, mood-dip, injury, getting-back, weekly-synthesis)
scripts/whoop/   OAuth + sync
scripts/semantic/   on-device RAG + MCP-сервер
```

Подробнее: [`AGENTS.md`](./AGENTS.md) (системный промпт), [`CLAUDE.md`](./CLAUDE.md) (правила),
[`index.md`](./index.md) (карта).
