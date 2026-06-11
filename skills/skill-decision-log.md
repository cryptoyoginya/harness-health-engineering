---
name: skill-decision-log
triggers:
  phrases: ["принято решение", "decision", "зафиксируй выбор"]
  files: ["05_decisions/**/*.md"]
description: создание decision-карточки с rationale и evidence
inputs:
  - контекст: existing /04_synthesis/* для evidence
  - решение пользователя
outputs:
  - /05_decisions/<descriptive-name>.md
  - обновление /05_decisions/decision-log.md
  - запись в /log.md
---

# Skill: decision log

Создание новой decision-карточки.

## Pre-check

Перед написанием — проверить hook `scripts/check-decisions.mjs` гарантирует:
- метку `DECISION:`
- хотя бы одну ссылку `[source: /02_sources/...]` или `[source: /04_synthesis/...]`

Если этих двух элементов нет — hook заблокирует запись.

## Шаг 1 — Найти evidence

```bash
node scripts/semantic/think.mjs "контекст решения <X>" --top 10
```

Это вернёт промпт с цитатами, которые можно использовать как rationale.

## Шаг 2 — Создать файл

```
/05_decisions/<descriptive-name>.md
```

Имя — описательное, без дат и версий (даты внутри файла).

Frontmatter:

```yaml
---
type: decision
status: approved | proposed | rejected
date: YYYY-MM-DD
owner: <BL / стейкхолдер>
confidence: high | medium | low
related:
  - 04_synthesis/<...>.md
  - 02_sources/<...>.md
---
```

## Шаг 3 — Структура содержимого

```markdown
# <Краткое название решения>

`DECISION:` <одно предложение, что решено>.

## Контекст

`FACT:` <фактура из источников> [source: /02_sources/...]
`INFERENCE:` <выводы> [source: /04_synthesis/...]

## Rationale

<почему именно так>

## Альтернативы (rejected)

- Вариант A — отвергнут потому что ... [source: ...]
- Вариант B — отвергнут потому что ... [source: ...]

## Риски

- `RISK:` <ожидаемый риск>
- `ASSUMPTION:` <принятая гипотеза>

## Success criteria

- Метрика 1
- Метрика 2

## Реверс-план

<что делать, если решение не сработает>
```

## Шаг 4 — Обновить decision-log

В `/05_decisions/decision-log.md` (опционально, если ведётся):

```
YYYY-MM-DD | <название решения> | [link](./<file>.md)
```

## Шаг 5 — Log

В `/log.md`:

```
YYYY-MM-DD | decision | <название> | /05_decisions/<file>.md
```

## Шаг 6 — Backlinks

После добавления `related:` — переиндексировать, чтобы backlinks подхватились:

```bash
node scripts/semantic/index.mjs
```

Затем можно проверить:

```bash
node scripts/semantic/backlinks.mjs 05_decisions/<file>.md
```
