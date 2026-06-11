// adapter.mjs — единый интерфейс LLM-провайдера + factory.
//
// Adapter contract:
//   {
//     name: string,
//     capabilities: { streaming, json_mode, max_context_tokens },
//     complete({ system, user, max_tokens?, temperature?, stop?, response_format? })
//        -> Promise<{ text, usage: { input_tokens, output_tokens }, raw }>
//   }
//
// Factory выбирает adapter по resolved config (см. ../config.mjs).

import { makeClaudeCliAdapter } from "./claude-cli.mjs";
import { makeOpenAiHttpAdapter } from "./openai-http.mjs";
import { makeGenericCliAdapter } from "./generic-cli.mjs";

const REGISTRY = {
  "claude-cli": makeClaudeCliAdapter,
  "openai-http": makeOpenAiHttpAdapter,
  "generic-cli": makeGenericCliAdapter,
  // alias: ollama — это openai-http с дефолтным base_url
  ollama: (cfg) => makeOpenAiHttpAdapter({
    ...cfg,
    base_url: cfg.base_url ?? "http://localhost:11434/v1",
  }),
};

/**
 * Создаёт adapter по resolved config. provider должен быть уже разрешён
 * config.mjs (включая режим "auto").
 *
 * Доп. кастомные adapter'ы пользователь регистрирует через .skillopt.js,
 * экспортирующий { adapters: { myProvider: (cfg) => Adapter } } — он
 * мерджится в REGISTRY до вызова createAdapter.
 *
 * @param {string} provider
 * @param {object} cfg  config из cosmiconfig
 * @param {Record<string, (cfg: object) => Adapter>} [extraRegistry]
 */
export function createAdapter(provider, cfg, extraRegistry = {}) {
  const factory = extraRegistry[provider] ?? REGISTRY[provider];
  if (!factory) {
    const known = [...Object.keys(REGISTRY), ...Object.keys(extraRegistry)].join(", ");
    throw new Error(
      `[skillopt] неизвестный provider="${provider}". Известны: ${known}.\n` +
        "Подсказка: задайте .skillopt.json с {\"provider\":\"openai-http\",\"model\":\"...\"} " +
        "или экспортируйте кастомный adapter через .skillopt.js#adapters.",
    );
  }
  return factory(cfg);
}

/**
 * Полезный helper для нормализации usage — провайдеры возвращают разные имена.
 */
export function normalizeUsage(raw) {
  if (!raw) return { input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: raw.input_tokens ?? raw.prompt_tokens ?? raw.promptTokenCount ?? 0,
    output_tokens: raw.output_tokens ?? raw.completion_tokens ?? raw.candidatesTokenCount ?? 0,
  };
}
