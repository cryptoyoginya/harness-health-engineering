---
name: skill-ingest
triggers:
  phrases: ["новый артефакт", "обработай источник", "добавь в KB"]
  files: ["01_raw/**/*"]
  events: ["новый файл в /01_raw/"]
description: обработка нового артефакта по канонической ingest-цепочке из AGENTS.md
inputs:
  - /01_raw/<domain>/<новый-файл>
outputs:
  - /02_sources/<YYYY-MM-DD>-<title>.md (source summary)
  - обновления в /03_wiki/, /04_synthesis/
  - запись в /04_synthesis/open-questions.md если найдены пробелы
  - запись в /04_synthesis/contradictions.md если есть конфликт
  - обновление /index.md
  - запись в /log.md
---

# Ingest workflow

Канонический поток обработки нового артефакта (расширенный вариант AGENTS.md § Ingest workflow).

## Шаг 0 — Контекст

Перед началом — запустить hybrid search по теме нового артефакта:

```bash
node scripts/semantic/search.mjs "<тема артефакта>" --top 10
```

Это покажет, какие существующие wiki/synthesis-страницы могут быть затронуты.

## Шаг 1 — Поместить raw файл

```
/01_raw/<domain>/YYYY-MM-DD-short-title.ext
```

`<domain>` — категория (customer-research, sales-feedback, competitor-pricing, analytics, finance, win-loss, и т.п.).

## Шаг 2 — Создать source summary

```
/02_sources/YYYY-MM-DD-short-title.md
```

Frontmatter:

```yaml
---
type: source-summary
status: processed
date: YYYY-MM-DD
source: /01_raw/<domain>/<filename>
confidence: high | medium | low
tags: [tag1, tag2]
---
```

Содержание: 5-15 bullet-points с ключевыми фактами из артефакта + цитаты дословно с указанием места.

## Шаг 3 — Извлечь сущности

Прогуляться по саммари и выписать:
- сегменты клиентов
- фичи / модули
- конкуренты
- объекции
- price metrics
- риски

## Шаг 4 — Обновить wiki

Каждая сущность → соответствующая страница в `/03_wiki/`. Если страницы нет — создать с frontmatter `type: wiki`.

В тело wiki-страницы добавить раздел «Свидетельства» с цитатами `[source: /02_sources/<...>.md]`.

## Шаг 5 — Обновить synthesis

Если новый артефакт меняет интерпретацию — обновить релевантный `/04_synthesis/<topic>.md`.

## Шаг 6 — Open questions

Если артефакт открыл новый пробел — добавить пункт в `/04_synthesis/open-questions.md` с пометкой `UNKNOWN:`.

## Шаг 7 — Contradictions

Если артефакт противоречит уже зафиксированному — добавить в `/04_synthesis/contradictions.md` обе версии **дословно** с confidence.

## Шаг 8 — Index

Добавить ссылку на source summary в `/index.md`.

## Шаг 9 — Log

В `/log.md` одна строка:

```
YYYY-MM-DD | ingest | <краткое описание> | source: /02_sources/<...>.md
```

## Шаг 10 — Reindex

```bash
node scripts/semantic/index.mjs
```

(Инкрементально — пройдёт только по изменённым файлам, ~1 сек.)

## Шаг 11 — Doctor

Опционально:

```bash
node scripts/kb-doctor.mjs
```

Проверит, что новые файлы прошли frontmatter-валидацию и не оставили broken-related.
