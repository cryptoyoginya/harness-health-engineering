// storage/metrics.mjs — лёгкое хранилище истории runs.
//
// Формат: append-only JSONL в .context/skillopt/runs.jsonl.
// Каждая строка — JSON summary одного run'а (rollout либо reflect).
// Никакого нативного binding'а — просто Node fs. Достаточно для observability,
// drift detection и cost-tracking. Если когда-нибудь понадобится OLAP — мигрируется в sqlite за час.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const METRICS_DIR = join(REPO_ROOT, ".context", "skillopt");
const METRICS_FILE = join(METRICS_DIR, "runs.jsonl");

/**
 * Append одну запись о run'е.
 * @param {object} entry
 *   { kind: "rollout"|"reflect"|"apply", run_id, started_at, ended_at?, adapter, model,
 *     skill?, summary?, cost_usd?, ... }
 */
export async function appendRun(entry) {
  if (!entry || typeof entry !== "object") return;
  await mkdir(METRICS_DIR, { recursive: true });
  const line = JSON.stringify({
    written_at: new Date().toISOString(),
    ...entry,
  });
  await appendFile(METRICS_FILE, line + "\n", "utf8");
}

/**
 * Прочитать все runs (последние N).
 * @param {object} opts
 * @param {number} [opts.limit=100]
 * @param {string} [opts.skill]   фильтр по skill
 * @param {string} [opts.kind]    фильтр по kind
 */
export async function listRuns({ limit = 100, skill = null, kind = null } = {}) {
  if (!existsSync(METRICS_FILE)) return [];
  const raw = await readFile(METRICS_FILE, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (skill && obj.skill !== skill && obj.summary?.by_skill && !obj.summary.by_skill[skill]) continue;
      if (kind && obj.kind !== kind) continue;
      out.push(obj);
    } catch { /* skip битые строки */ }
  }
  return out;
}

/**
 * Грубая оценка цены одного вызова. Цены в USD на 1M токенов. Если модель неизвестна — 0.
 * Таблица намеренно консервативная (берёт верхние ценники). Может быть переопределена
 * через .skillopt.json#pricing.
 */
const DEFAULT_PRICING = {
  // OpenAI
  "gpt-4o": { in: 2.50, out: 10.00 },
  "gpt-4o-mini": { in: 0.15, out: 0.60 },
  "gpt-4-turbo": { in: 10.00, out: 30.00 },
  // Anthropic
  "claude-3-5-sonnet": { in: 3.00, out: 15.00 },
  "claude-3-5-haiku": { in: 0.80, out: 4.00 },
  "claude-3-opus": { in: 15.00, out: 75.00 },
  "claude-opus-4": { in: 15.00, out: 75.00 },
  // Open-source / self-hosted — 0
  "llama3": { in: 0, out: 0 },
  "qwen": { in: 0, out: 0 },
  "mistral": { in: 0, out: 0 },
};

export function estimateCost({ model, input_tokens = 0, output_tokens = 0, pricing = null }) {
  if (!model) return 0;
  const merged = { ...DEFAULT_PRICING, ...(pricing || {}) };
  // Поиск с substring fallback ("claude-3-5-sonnet-20241022" → "claude-3-5-sonnet")
  let entry = merged[model];
  if (!entry) {
    for (const [key, val] of Object.entries(merged)) {
      if (model.includes(key)) { entry = val; break; }
    }
  }
  if (!entry) return 0;
  return (input_tokens / 1e6) * entry.in + (output_tokens / 1e6) * entry.out;
}

/**
 * Месячный отчёт: сумма usd, кол-во runs, kinds.
 */
export async function monthlyCost({ year, month } = {}) {
  const runs = await listRuns({ limit: 10_000 });
  const target = year && month ? `${year}-${String(month).padStart(2, "0")}` : new Date().toISOString().slice(0, 7);
  let total = 0;
  let count = 0;
  for (const r of runs) {
    if (!r.started_at?.startsWith(target)) continue;
    total += Number(r.cost_usd ?? 0);
    count++;
  }
  return { month: target, total_usd: total, runs: count };
}
