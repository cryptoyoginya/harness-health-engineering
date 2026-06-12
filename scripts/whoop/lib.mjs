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

async function refresh(refresh_token) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: requireEnv('WHOOP_CLIENT_ID'),
    client_secret: requireEnv('WHOOP_CLIENT_SECRET'),
    scope: 'offline',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) {
    console.error(`[whoop] refresh не удался: ${r.status} ${await r.text()}`);
    console.error('[whoop] возможно, токен отозван — перезапусти pnpm whoop:auth');
    process.exit(1);
  }
  return saveToken(await r.json());
}

// Возвращает валидный access_token, обновляя по необходимости.
export async function getAccessToken() {
  let tok = loadToken();
  if (!tok.expires_at || tok.expires_at < Date.now() + 60_000) {
    tok = await refresh(tok.refresh_token);
  }
  return tok.access_token;
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
