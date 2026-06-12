// lib.mjs — общие хелперы для Whoop-интеграции (OAuth2 + v2 API).
// Без внешних зависимостей: Node 22 (global fetch, fs, crypto).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..'); // repo root

export const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const API_BASE = 'https://api.prod.whoop.com/developer';
export const SCOPES = 'read:recovery read:sleep read:cycles read:workout read:profile offline';

const TOKEN_PATH = join(ROOT, '.whoop', 'token.json');

// --- .env (минимальный парсер, без dotenv) ---
export function loadEnv() {
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[whoop] нет ${name}. Скопируй .env.example → .env и заполни (см. scripts/whoop/README.md).`);
    process.exit(1);
  }
  return v;
}

// --- токены ---
export function saveToken(tok) {
  mkdirSync(join(ROOT, '.whoop'), { recursive: true });
  const expires_at = Date.now() + (tok.expires_in ?? 3600) * 1000;
  const data = { ...tok, expires_at };
  writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2));
  return data;
}

export function loadToken() {
  if (!existsSync(TOKEN_PATH)) {
    console.error('[whoop] нет .whoop/token.json. Запусти разово: pnpm whoop:auth');
    process.exit(1);
  }
  return JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
}

// Алерт в Telegram (если бот настроен), чтобы фоновый sync не падал молча.
async function alertTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch { /* алерт необязателен */ }
}

async function postToken(refresh_token) {
  // Формат, который Whoop принимает на refresh: client creds в теле, БЕЗ параметра scope
  // (со scope капризничает). Ответ содержит новый ротированный refresh_token.
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: requireEnv('WHOOP_CLIENT_ID'),
    client_secret: requireEnv('WHOOP_CLIENT_SECRET'),
  });
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function refresh(refresh_token) {
  // Эндпоинт токенов Whoop периодически отдаёт транзиентные 400/500 (с обманчивым
  // сообщением про redirect_uri). 400 НЕ расходует refresh_token, поэтому повтор тем же
  // токеном безопасен. Ретраим с нарастающей паузой; успех ротирует токен и выходит из цикла.
  let r, lastBody;
  for (let attempt = 1; attempt <= 5; attempt++) {
    r = await postToken(refresh_token);
    if (r.ok) break;
    lastBody = await r.text();
    console.warn(`[whoop] refresh попытка ${attempt}/5: ${r.status}`);
    if (attempt < 5) await new Promise((s) => setTimeout(s, 1500 * attempt));
  }
  if (!r.ok) {
    console.error(`[whoop] refresh не удался после ретраев: ${lastBody}`);
    console.error('[whoop] если повторяется — переподключи: pnpm whoop:auth');
    await alertTelegram('⚠️ Whoop: не удалось обновить токен (после ретраев). Если повторится — переподключи: pnpm whoop:auth');
    process.exit(1);
  }
  const json = await r.json();
  // На всякий случай сохраняем прежний refresh_token, если ответ его не вернул.
  if (!json.refresh_token) json.refresh_token = refresh_token;
  return saveToken(json);
}

// Singleton-замок: при параллельных вызовах (sync дёргает recovery/cycle/sleep через Promise.all)
// refresh выполняется РОВНО ОДИН раз. Иначе несколько refresh гонятся за один refresh_token,
// первый его ротирует, остальные держат мёртвый токен → 400. Это и была главная причина сбоев.
let refreshing = null;

// Возвращает валидный access_token, обновляя по необходимости.
export async function getAccessToken() {
  const tok = loadToken();
  if (tok.expires_at && tok.expires_at >= Date.now() + 60_000) {
    return tok.access_token;
  }
  if (!refreshing) {
    refreshing = refresh(tok.refresh_token).finally(() => { refreshing = null; });
  }
  const fresh = await refreshing;
  return fresh.access_token;
}

// GET к v2 API. pathname вида '/v2/recovery'.
export async function whoopGet(pathname, params = {}) {
  const token = await getAccessToken();
  const url = new URL(API_BASE + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    throw new Error(`GET ${pathname} → ${r.status} ${await r.text()}`);
  }
  return r.json();
}

// Локальная дата YYYY-MM-DD (часовой пояс системы).
export function todayISO() {
  return new Date().toLocaleDateString('sv-SE');
}
