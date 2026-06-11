// config.mjs — резолв конфига SkillOpt.
//
// Порядок приоритета (высокий → низкий):
//   1. CLI флаги (--provider, --model, --base-url, --api-key)  — переданы вызывающим
//   2. Env vars (SKILLOPT_*, и fallback OPENAI_API_KEY / ANTHROPIC_API_KEY)
//   3. cosmiconfig: .skillopt.{json,js,yaml,yml}, package.json#skillopt
//   4. Hard defaults
//
// Если provider="auto" — пробуем claude CLI, иначе openai-http (если есть key),
// иначе actionable error.

import { cosmiconfig } from "cosmiconfig";
import { spawnSync } from "node:child_process";

const MODULE = "skillopt";

export async function loadConfig({ cwd = process.cwd(), overrides = {} } = {}) {
  const explorer = cosmiconfig(MODULE, {
    searchPlaces: [
      `.${MODULE}.json`,
      `.${MODULE}rc.json`,
      `.${MODULE}.js`,
      `.${MODULE}.yaml`,
      `.${MODULE}.yml`,
      `package.json`,
    ],
  });

  const found = await explorer.search(cwd);
  const fileCfg = found?.config ?? {};

  const merged = mergeDeep(
    defaults(),
    fileCfg,
    fromEnv(),
    overrides,
  );

  merged.provider = await resolveAutoProvider(merged);

  return {
    config: merged,
    sourcePath: found?.filepath ?? null,
    extraAdapters: extractCustomAdapters(fileCfg),
  };
}

function defaults() {
  return {
    provider: "auto",
    model: null,
    base_url: null,
    api_key: null,
    timeout_ms: 300_000,
    concurrency: 2,
    graders: { default: "contains" },
    budget: { per_run_usd: 1.0, monthly_usd: 5.0 },
  };
}

function fromEnv() {
  const out = {};
  if (process.env.SKILLOPT_PROVIDER) out.provider = process.env.SKILLOPT_PROVIDER;
  if (process.env.SKILLOPT_MODEL) out.model = process.env.SKILLOPT_MODEL;
  if (process.env.SKILLOPT_BASE_URL) out.base_url = process.env.SKILLOPT_BASE_URL;
  if (process.env.SKILLOPT_API_KEY) out.api_key = process.env.SKILLOPT_API_KEY;
  if (process.env.SKILLOPT_TIMEOUT_MS) out.timeout_ms = Number(process.env.SKILLOPT_TIMEOUT_MS);
  if (process.env.SKILLOPT_CONCURRENCY) out.concurrency = Number(process.env.SKILLOPT_CONCURRENCY);
  return out;
}

async function resolveAutoProvider(cfg) {
  if (cfg.provider && cfg.provider !== "auto") return cfg.provider;
  // 1. Пробуем claude CLI
  const hasClaude = which("claude");
  if (hasClaude) return "claude-cli";
  // 2. Пробуем openai-http (нужен ключ)
  const key = cfg.api_key ?? process.env.OPENAI_API_KEY ?? process.env.SKILLOPT_API_KEY;
  if (key) return "openai-http";
  // 3. Ollama по дефолтному адресу без ключа — последний шанс
  if (cfg.base_url && /11434|ollama/i.test(cfg.base_url)) return "openai-http";
  throw new Error(
    "[skillopt] LLM provider не настроен. Варианты:\n" +
      "  • Установите Claude Code (`claude` в PATH) — будет auto-detected\n" +
      "  • Задайте OPENAI_API_KEY для openai-http\n" +
      "  • Запустите Ollama (ollama serve) и в .skillopt.json пропишите base_url=http://localhost:11434/v1\n" +
      "  • Создайте .skillopt.json с явным provider и model\n" +
      "Без LLM можно использовать `pnpm skill list` и `pnpm skill score` для офлайн-операций.",
  );
}

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function extractCustomAdapters(fileCfg) {
  if (!fileCfg || typeof fileCfg !== "object") return {};
  if (fileCfg.adapters && typeof fileCfg.adapters === "object") return fileCfg.adapters;
  return {};
}

function mergeDeep(...sources) {
  const out = {};
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      if (v == null) continue;
      if (typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && !Array.isArray(out[k])) {
        out[k] = mergeDeep(out[k], v);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}
