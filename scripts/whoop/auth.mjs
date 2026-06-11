#!/usr/bin/env node
// auth.mjs — разовый OAuth2 Authorization Code flow для Whoop.
// Открывает браузер, ловит callback на localhost, обменивает code на токены,
// сохраняет refresh-токен в .whoop/token.json (gitignored).
//
// Перед запуском: .env с WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET, и redirect URL
// в Whoop Developer Dashboard = WHOOP_REDIRECT_URI (по умолчанию http://localhost:7777/callback).

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { AUTH_URL, TOKEN_URL, SCOPES, loadEnv, requireEnv, saveToken } from './lib.mjs';

loadEnv();
const clientId = requireEnv('WHOOP_CLIENT_ID');
const clientSecret = requireEnv('WHOOP_CLIENT_SECRET');
const redirectUri = process.env.WHOOP_REDIRECT_URI || 'http://localhost:7777/callback';
const port = Number(new URL(redirectUri).port || 7777);
const state = randomBytes(16).toString('hex'); // ≥8 символов, CSRF-защита

const authUrl = new URL(AUTH_URL);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('state', state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== new URL(redirectUri).pathname) {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  if (!code || gotState !== state) {
    res.writeHead(400).end('Ошибка авторизации (code/state). Можно закрыть вкладку.');
    console.error('[whoop] callback без code или несовпадение state.');
    server.close();
    process.exit(1);
  }
  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    saveToken(await r.json());
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Готово! Токен сохранён в .whoop/token.json. Можно закрыть вкладку.');
    console.log('[whoop] токен сохранён → .whoop/token.json. Теперь: pnpm whoop:sync');
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500).end('Не удалось обменять code на токен. Подробности в терминале.');
    console.error('[whoop] обмен code→token не удался:', e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(port, () => {
  console.log(`[whoop] жду авторизацию на ${redirectUri}`);
  console.log('[whoop] открываю браузер. Если не открылся — перейди вручную:\n' + authUrl.toString());
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} "${authUrl.toString()}"`);
});
