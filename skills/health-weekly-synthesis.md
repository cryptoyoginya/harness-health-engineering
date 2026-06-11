---
name: health-weekly-synthesis
triggers:
  phrases: ["разбери неделю", "недельный синтез", "что было на неделе", "weekly синтез", "подведи неделю"]
  events: ["воскресенье 18:00"]
description: воскресный разбор недели — 7 daily-логов → source-note → synthesis → решение об эксперименте
inputs:
  - /01_raw/health/<7 последних дней>
outputs:
  - /02_sources/health/YYYY-Www-<title>.md
  - обновление /04_synthesis/ + open-questions.md
  - (опц.) эксперимент в /05_decisions/experiments/
  - обновление /index.md и /log.md
---

# Workflow: недельный синтез

Воскресный ритуал. Цель — найти паттерны, которые сам не видишь, и превратить их в гипотезу/эксперимент.

## Шаг 0 — контекст

```bash
node scripts/semantic/search.mjs "<тема недели, напр. сон настроение>" --top 10
```

## Шаг 1 — собрать неделю

Прочитать 7 daily-логов `/01_raw/health/`. Свести цифры (recovery avg, доля ночей ≥7ч, настроение avg,
адхеренс бадов, дни с активностью, дни с соцконтактом) — это таблица «Цифры недели».

## Шаг 2 — source-note

Создать `/02_sources/health/YYYY-Www-<title>.md` из шаблона `_TEMPLATE.md`. Разметить FACT (события и
цифры с `[source:]`) и INFERENCE (связи объективного с субъективным). Не смешивать.

## Шаг 3 — synthesis

Скопировать `/04_synthesis/health-weekly-template.md` в `health-YYYY-Www.md`. Выписать паттерны:
- «N из M худших настроений — после сна <X»;
- «recovery ниже после поздних тренировок»;
- «лучшие дни — тренировка + соцконтакт».
Каждый — с меткой и цитатой.

## Шаг 4 — пробелы и решение

- Новые UNKNOWN → `/04_synthesis/open-questions.md`.
- Если паттерн просит изменения режима/стека → эксперимент (`/05_decisions/experiments/`, одна
  переменная, срок, метрики, критерий). Если не созрело — записать «наблюдаем дальше».

## Шаг 5 — закрыть цикл

```bash
node scripts/semantic/index.mjs   # переиндексация
node scripts/kb-doctor.mjs        # health-check (EXIT 0)
```
Обновить `/index.md` и `/log.md` (строка: дата | weekly | краткое | source).

⚠️ Любой тревожный сигнал по телу/психике в логах → RECOMMENDATION одна: к специалисту.
