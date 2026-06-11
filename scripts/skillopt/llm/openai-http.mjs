// openai-http.mjs — основной adapter. fetch /v1/chat/completions.
//
// Совместим с любым OpenAI-compatible endpoint:
//   - OpenAI                    base_url=https://api.openai.com/v1
//   - Ollama                    base_url=http://localhost:11434/v1  (api_key опционален)
//   - LiteLLM proxy             base_url=http://localhost:4000/v1
//   - vLLM                      base_url=http://localhost:8000/v1
//   - OpenRouter                base_url=https://openrouter.ai/api/v1
//   - Anthropic-via-OpenAI shim base_url=https://api.anthropic.com/v1/openai
//
// Никаких внешних HTTP-клиентов — встроенный fetch (Node ≥18).
// Retry с exponential backoff на 429/5xx. Без streaming в Phase 1 (буфер).

import { normalizeUsage } from "./adapter.mjs";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;

export function makeOpenAiHttpAdapter(cfg = {}) {
  const baseUrl = (cfg.base_url ?? process.env.SKILLOPT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey =
    cfg.api_key ?? process.env.SKILLOPT_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
  const model = cfg.model ?? process.env.SKILLOPT_MODEL ?? "gpt-4o-mini";
  const timeoutMs = cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const extraHeaders = cfg.headers && typeof cfg.headers === "object" ? cfg.headers : {};

  return {
    name: "openai-http",
    capabilities: { streaming: false, json_mode: true, max_context_tokens: cfg.max_context ?? 128_000 },

    async complete({ system, user, max_tokens, temperature, stop, response_format }) {
      const url = `${baseUrl}/chat/completions`;
      const body = {
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: user },
        ],
        ...(max_tokens != null ? { max_tokens } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(stop ? { stop } : {}),
        ...(response_format ? { response_format } : {}),
      };

      let lastErr = null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
              ...extraHeaders,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          clearTimeout(tid);

          if (res.status === 429 || res.status >= 500) {
            const txt = await res.text().catch(() => "");
            lastErr = new Error(`[skillopt:openai-http] ${res.status}: ${txt.slice(0, 300)}`);
            await sleep(backoff(attempt));
            continue;
          }
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            throw new Error(`[skillopt:openai-http] ${res.status}: ${txt.slice(0, 500)}`);
          }

          const data = await res.json();
          const text = data?.choices?.[0]?.message?.content ?? "";
          return {
            text,
            usage: normalizeUsage(data?.usage),
            raw: data,
          };
        } catch (e) {
          clearTimeout(tid);
          if (e?.name === "AbortError") {
            throw new Error(`[skillopt:openai-http] timeout ${timeoutMs}ms`);
          }
          // network errors — retry
          lastErr = e;
          if (attempt < MAX_RETRIES - 1) {
            await sleep(backoff(attempt));
            continue;
          }
          throw e;
        }
      }
      throw lastErr ?? new Error("[skillopt:openai-http] unknown failure");
    },
  };
}

function backoff(attempt) {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
