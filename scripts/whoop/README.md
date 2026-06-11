# Whoop ingest

Автоматический ingest физиологии из Whoop в daily-логи. Объективные сигналы (recovery, HRV, сон,
strain, пульс покоя) втекают сами; субъективные (настроение/энергия/соц) дописываются рукой.

## Разовая настройка

1. Заведи app в [Whoop Developer Dashboard](https://developer.whoop.com).
   - Redirect URL: `http://localhost:7777/callback`
   - Scopes: recovery, sleep, cycles, workout, profile, offline.
2. `cp .env.example .env` и впиши `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET`.
3. `pnpm whoop:auth` — откроет браузер, попросит подтвердить доступ, сохранит refresh-токен в
   `.whoop/token.json` (gitignored).

## Ежедневно

```bash
pnpm whoop:sync
```

Тянет последние recovery/cycle/sleep из Whoop v2 API и дописывает строку `whoop:` в
`01_raw/health/YYYY-MM-DD.md` (создаёт файл, если его нет). Меняет только строку `whoop:` — твои
ментальные строки не трогает. Access-токен обновляется автоматически по refresh-токену.

## Автоматизация (опционально)

Утренний запуск — через cron или `/schedule` (Claude Code). Пример cron в 8:00:

```
0 8 * * * cd /путь/к/health-harness && /usr/bin/env pnpm whoop:sync >> .whoop/sync.log 2>&1
```

## Замечания

- Эндпоинты v2: `/developer/v2/recovery`, `/developer/v2/cycle`, `/developer/v2/activity/sleep`.
  Если Whoop поменяет схему/пути — ошибка GET выводится в терминал, поправить в `lib.mjs` / `sync.mjs`.
- `hrv_rmssd_milli` трактуется как мс; если API отдаёт секунды (значение <1) — домножается на 1000.
- Секреты и токены (`.env`, `.whoop/`) под `deny`-read хука и в `.gitignore`. Никогда не коммить.
