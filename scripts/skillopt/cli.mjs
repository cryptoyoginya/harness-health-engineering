#!/usr/bin/env node
// cli.mjs — entrypoint SkillOpt.
//
// Verbs:
//   list                      — обзор скиллов + покрытие eval'ами
//   rollout <skill> [--case]  — прогон evals через LLM, traces в .context/skillopt/<run>/
//   score <run-id>            — пересчёт graders без LLM (offline)
//   reflect <run-id>          — 2-й LLM-pass: предлагает правки skill
//   diff [<run-id>]           — unified diff proposal vs current skill
//   apply <run-id> [--skill]  — overwrite skills/, git add, backup, без commit
//   revert <run-id>           — восстановить из backup'а
//   runs                      — последние runs из .context/skillopt/runs.jsonl

import { loadConfig } from "./config.mjs";
import { createAdapter } from "./llm/adapter.mjs";
import { runRollout, runScore } from "./runner/rollout.mjs";
import { runReflect } from "./runner/reflect.mjs";
import { runDiff } from "./runner/diff.mjs";
import { runApply, runRevert } from "./runner/edit.mjs";
import { listSkillsWithEvals } from "./evals/loader.mjs";
import { listRuns, estimateCost } from "./storage/metrics.mjs";

const argv = process.argv.slice(2);
const verb = argv[0];

if (!verb || verb === "-h" || verb === "--help" || verb === "help") {
  printHelp();
  process.exit(verb ? 0 : 1);
}

try {
  switch (verb) {
    case "list":    await cmdList();                  break;
    case "rollout": await cmdRollout(argv.slice(1));  break;
    case "score":   await cmdScore(argv.slice(1));    break;
    case "reflect": await cmdReflect(argv.slice(1));  break;
    case "diff":    await cmdDiff(argv.slice(1));     break;
    case "apply":   await cmdApply(argv.slice(1));    break;
    case "revert":  await cmdRevert(argv.slice(1));   break;
    case "runs":    await cmdRuns(argv.slice(1));     break;
    default:
      console.error(`[skillopt] неизвестная подкоманда "${verb}". Запустите без аргументов для справки.`);
      process.exit(1);
  }
} catch (e) {
  console.error(e.message || String(e));
  process.exit(1);
}

// ---------- commands ----------

async function cmdList() {
  const skills = await listSkillsWithEvals();
  if (skills.length === 0) {
    console.log("[skillopt:list] не найдено скиллов в skills/.");
    return;
  }
  console.log("");
  console.log("  Skills и покрытие eval'ами");
  console.log("  ─────────────────────────────────────────────");
  for (const s of skills) {
    const file = s.skillFileExists ? "✓" : "—";
    console.log(`  ${file} ${s.skill.padEnd(36)} evals=${s.caseCount}`);
  }
  console.log("");
  console.log("  Запуск:  pnpm skill rollout <skill> [--case <id>]");
  console.log("");
}

async function cmdRollout(args) {
  const opts = parseArgs(args, { flags: ["ci", "yes", "json"] });
  const skillFilter = opts.positional[0] ?? null;
  const caseFilter = opts.flags.case ?? null;
  if (!skillFilter) throw new Error("Использование: pnpm skill rollout <skill> [--case <id>] [--ci] [--yes]");

  const { config, sourcePath, extraAdapters } = await loadConfig({ overrides: pickConfigOverrides(opts.flags) });
  const adapter = createAdapter(config.provider, config, extraAdapters);
  const judgeAdapter = await maybeJudgeAdapter(config, extraAdapters);

  console.error(
    `[skillopt:rollout] provider=${adapter.name} model=${config.model ?? "(default)"} skill=${skillFilter}${caseFilter ? ` case=${caseFilter}` : ""}`,
  );
  if (sourcePath) console.error(`[skillopt:rollout] config: ${sourcePath}`);

  const { runId, summary, traces, runDir } = await runRollout({
    adapter, config, judgeAdapter, skillFilter, caseFilter, ci: opts.flags.ci,
  });
  if (!runId) {
    console.error("[skillopt:rollout] не найдено ни одного eval-кейса.");
    process.exit(opts.flags.ci ? 1 : 0);
  }

  if (opts.flags.json) {
    process.stdout.write(JSON.stringify({ runId, summary, traces }, null, 2) + "\n");
  } else {
    printRolloutHuman({ runId, summary, traces, runDir });
  }
  if (opts.flags.ci && summary.pass_rate < 1) process.exit(1);
}

async function cmdScore(args) {
  const opts = parseArgs(args, { flags: [] });
  const runId = opts.positional[0];
  if (!runId) throw new Error("Использование: pnpm skill score <run-id>");
  const summary = await runScore(runId);
  console.error(`[skillopt:score] run=${runId} pass=${summary.passed}/${summary.total} (${(summary.pass_rate * 100).toFixed(1)}%)`);
}

async function cmdReflect(args) {
  const opts = parseArgs(args, { flags: ["force", "json"] });
  const runId = opts.positional[0];
  if (!runId) throw new Error("Использование: pnpm skill reflect <run-id> [--force]");

  const { config, sourcePath, extraAdapters } = await loadConfig({ overrides: pickConfigOverrides(opts.flags) });
  const adapter = createAdapter(config.provider, config, extraAdapters);
  console.error(`[skillopt:reflect] provider=${adapter.name} model=${config.model ?? "(default)"} run=${runId}${opts.flags.force ? " --force" : ""}`);
  if (sourcePath) console.error(`[skillopt:reflect] config: ${sourcePath}`);

  const { results, cost_usd, runDir } = await runReflect({ runId, adapter, config, force: opts.flags.force });

  if (opts.flags.json) {
    process.stdout.write(JSON.stringify({ results, cost_usd }, null, 2) + "\n");
    return;
  }
  console.error("");
  for (const r of results) {
    if (r.skipped) console.error(`  ⏭  ${r.skill}: ${r.reason}`);
    else if (r.error) console.error(`  ✗  ${r.skill}: ${r.error}`);
    else console.error(`  ✓  ${r.skill}: ${r.old_size}→${r.new_size} chars (${r.delta_pct >= 0 ? "+" : ""}${r.delta_pct}%), ${r.proposed_path.split("/").pop()}`);
  }
  console.error("");
  console.error(`  Proposals: ${runDir}/proposals/`);
  console.error(`  Прибл. цена: $${cost_usd.toFixed(4)}`);
  console.error(`  Дальше:    pnpm skill diff ${runId}`);
  console.error(`  Применить: pnpm skill apply ${runId}`);
  console.error("");
}

async function cmdDiff(args) {
  const opts = parseArgs(args, { flags: ["json"] });
  const runId = opts.positional[0] ?? (await latestRunIdWithProposals());
  if (!runId) throw new Error("Использование: pnpm skill diff <run-id> (или сделайте reflect, чтобы был proposal)");

  const diffs = await runDiff({ runId });
  if (opts.flags.json) {
    process.stdout.write(JSON.stringify(diffs, null, 2) + "\n");
    return;
  }
  for (const d of diffs) {
    console.log("");
    console.log("═".repeat(70));
    console.log(`  ${d.skill}   ${d.old_size}→${d.new_size} chars (removed ${d.removed_pct}%)`);
    if (d.warn_major_rewrite) console.log("  ⚠  major rewrite (>30% удалено) — внимательно review");
    if (d.error) { console.log(`  ✗ ${d.error}`); continue; }
    console.log("═".repeat(70));
    console.log(d.diff);
  }
  console.log("");
  console.log(`  Применить: pnpm skill apply ${runId}`);
  console.log("");
}

async function cmdApply(args) {
  const opts = parseArgs(args, { flags: [] });
  const runId = opts.positional[0];
  if (!runId) throw new Error("Использование: pnpm skill apply <run-id> [--skill <name>[,...]]");
  const skillFilter = opts.flags.skill ? String(opts.flags.skill).split(",") : null;

  const { applied, skipped, summaryPath } = await runApply({ runId, skillFilter });
  for (const a of applied) {
    console.error(`  ✓  ${a.skill}  ${a.old_size}→${a.new_size} chars  ${a.git_staged ? "(git staged)" : ""}`);
  }
  for (const s of skipped) console.error(`  ⏭  ${s.skill}: ${s.reason}`);
  console.error("");
  console.error(`  Summary: ${summaryPath}`);
  console.error(`  Просмотр изменений:  git diff --staged skills/`);
  console.error(`  Откат:               pnpm skill revert ${runId}`);
  console.error("");
}

async function cmdRevert(args) {
  const opts = parseArgs(args, { flags: [] });
  const runId = opts.positional[0];
  if (!runId) throw new Error("Использование: pnpm skill revert <run-id> [--skill <name>[,...]]");
  const skillFilter = opts.flags.skill ? String(opts.flags.skill).split(",") : null;

  const { reverted, skipped } = await runRevert({ runId, skillFilter });
  for (const r of reverted) console.error(`  ↩  ${r.skill}  ←  ${r.path}`);
  for (const s of skipped) console.error(`  ⏭  ${s.skill}: ${s.reason}`);
  console.error("");
}

async function cmdRuns(args) {
  const opts = parseArgs(args, { flags: ["json"] });
  const limit = Number(opts.flags.limit ?? 20);
  const runs = await listRuns({ limit });
  if (opts.flags.json) {
    process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
    return;
  }
  if (runs.length === 0) {
    console.log("[skillopt:runs] пока нет записей в .context/skillopt/runs.jsonl");
    return;
  }
  console.log("");
  console.log("  Последние runs (свежие сверху)");
  console.log("  ─────────────────────────────────────────────────────────────");
  for (const r of runs) {
    const kind = (r.kind ?? "?").padEnd(7);
    const id = (r.run_id ?? "?").padEnd(28);
    const model = (r.model ?? "?").padEnd(20);
    const pass = r.summary?.pass_rate != null ? `pass=${(r.summary.pass_rate * 100).toFixed(0)}%` : "";
    const cost = r.cost_usd ? `$${Number(r.cost_usd).toFixed(4)}` : "";
    console.log(`  ${kind}  ${id}  ${model}  ${pass}  ${cost}`);
  }
  console.log("");
}

// ---------- helpers ----------

async function latestRunIdWithProposals() {
  const { existsSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { REPO_ROOT } = await import("./evals/loader.mjs");
  const root = join(REPO_ROOT, ".context", "skillopt");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    if (existsSync(join(root, d, "proposals"))) return d;
  }
  return null;
}

async function maybeJudgeAdapter(config, extraAdapters) {
  // Если хотя бы один eval использует llm-judge — нужен отдельный adapter.
  // Если в config задан graders.judge_model — создаём отдельный adapter с этой моделью.
  // Иначе reuse основной adapter.
  const judgeModel = config.graders?.judge_model;
  if (!judgeModel) return null; // rollout создаст основной adapter и его же использует
  const judgeConfig = { ...config, model: judgeModel };
  return createAdapter(config.provider, judgeConfig, extraAdapters);
}

function parseArgs(args, { flags = [] } = {}) {
  const out = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (flags.includes(key)) {
        out.flags[key] = true;
      } else {
        out.flags[key] = args[++i];
      }
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function pickConfigOverrides(flagsObj) {
  const out = {};
  if (flagsObj.provider) out.provider = flagsObj.provider;
  if (flagsObj.model) out.model = flagsObj.model;
  if (flagsObj["base-url"]) out.base_url = flagsObj["base-url"];
  if (flagsObj["api-key"]) out.api_key = flagsObj["api-key"];
  return out;
}

function printRolloutHuman({ runId, summary, traces, runDir }) {
  console.error("");
  console.error(`  Run: ${runId}`);
  console.error(`  Pass: ${summary.passed}/${summary.total} (${(summary.pass_rate * 100).toFixed(1)}%)`);
  console.error(`  Failed: ${summary.failed}   Errored: ${summary.errored}`);
  const cost = estimateCost({ model: summary.model, input_tokens: summary.tokens_in, output_tokens: summary.tokens_out });
  console.error(`  Tokens: in=${summary.tokens_in} out=${summary.tokens_out}  est=$${cost.toFixed(4)}`);
  console.error("");
  for (const t of traces) {
    const status = t.passed ? "✓" : t.error ? "ERR" : "✗";
    const tail = t.error ? ` — ${t.error.slice(0, 80)}` : ` score=${(t.score ?? 0).toFixed(2)} ${t.latency_ms}ms`;
    console.error(`  ${status} ${t.skill}__${t.case_id}${tail}`);
  }
  console.error("");
  console.error(`  Traces: ${runDir}/traces/`);
  console.error("");
}

function printHelp() {
  console.log(`
SkillOpt — оптимизация и регрессионное тестирование SKILL.md документов.

Использование:
  pnpm skill list                                Список скиллов + покрытие eval'ами
  pnpm skill rollout <skill> [--case <id>]       Прогон evals через LLM
  pnpm skill score <run-id>                      Пересчёт graders без LLM (offline)
  pnpm skill reflect <run-id> [--force]          2-й LLM-pass предлагает правки skill
  pnpm skill diff [<run-id>]                     Unified diff proposal vs current skill
  pnpm skill apply <run-id> [--skill foo,bar]    Overwrite skills/, git add, backup
  pnpm skill revert <run-id> [--skill ...]       Откат из backup
  pnpm skill runs [--limit 20]                   Последние runs из metrics

Опции (для rollout/reflect):
  --provider <name>      claude-cli | openai-http | ollama | generic-cli
  --model <name>         например claude-3-5-sonnet / gpt-4o-mini / llama3
  --base-url <url>       для openai-http (Ollama: http://localhost:11434/v1)
  --api-key <key>        иначе из env (SKILLOPT_API_KEY / OPENAI_API_KEY)
  --ci                   exit code 1 если pass-rate < 100% (только rollout)
  --json                 машинный вывод

Конфиг (cosmiconfig): .skillopt.json / .skilloptrc.json / package.json#skillopt,
env vars SKILLOPT_* / OPENAI_API_KEY / ANTHROPIC_API_KEY.

Полный pipeline:
  pnpm skill rollout skill-foo
  pnpm skill reflect <run-id>
  pnpm skill diff <run-id>
  pnpm skill apply <run-id>     →  git diff --staged skills/  →  git commit
  pnpm skill revert <run-id>    (если плохо)
`);
}
