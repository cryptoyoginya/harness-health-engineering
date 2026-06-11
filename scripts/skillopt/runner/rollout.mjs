// runner/rollout.mjs — выполняет eval-кейсы через resolved adapter.
//
// Что делает:
//   1. Получает список eval-кейсов (после filter по skill / case)
//   2. Под каждый кейс: загружает skill-файл → собирает промпт → adapter.complete → grader
//   3. Пишет traces/<skill>__<case>.json + summary.json в .context/skillopt/<run-id>/
//   4. Параллелизм через p-queue (config.concurrency)
//
// Промпт-конструктор: system = AGENTS.md (если есть) + skill-файл; user = input из eval-кейса.
// Это даёт «холодный» прогон: модель видит контракт + скилл, и больше ничего.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import PQueue from "p-queue";
import { discoverEvals, readSkillFile, REPO_ROOT } from "../evals/loader.mjs";
import { getGrader } from "../evals/graders/index.mjs";
import { appendRun, estimateCost } from "../storage/metrics.mjs";

function makeRunId() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `${iso}-${hex}`;
}

async function readAgentsMd() {
  const p = join(REPO_ROOT, "AGENTS.md");
  if (!existsSync(p)) return "";
  return await readFile(p, "utf8");
}

function buildSystem(agentsMd, skillText) {
  const parts = [];
  if (agentsMd.trim()) {
    parts.push("# Контракт агента (AGENTS.md)\n\n" + agentsMd.trim());
  }
  parts.push("# Активный скилл\n\n" + skillText.trim());
  return parts.join("\n\n---\n\n");
}

/**
 * @param {object} opts
 * @param {object} opts.adapter            LLM adapter
 * @param {object} opts.config             resolved config
 * @param {string|null} opts.skillFilter
 * @param {string|null} opts.caseFilter
 * @param {boolean} opts.ci                exit code 1 при regression (для CI)
 * @param {object|null} opts.judgeAdapter  отдельный adapter для llm-judge (если grader=llm-judge)
 */
export async function runRollout({ adapter, config, skillFilter = null, caseFilter = null, ci = false, judgeAdapter = null } = {}) {
  const cases = await discoverEvals({ skillFilter, caseFilter });
  if (cases.length === 0) {
    return { runId: null, summary: { error: "no eval cases found" }, traces: [] };
  }

  const runId = makeRunId();
  const runDir = join(REPO_ROOT, ".context", "skillopt", runId);
  const tracesDir = join(runDir, "traces");
  await mkdir(tracesDir, { recursive: true });

  const agentsMd = await readAgentsMd();
  const queue = new PQueue({ concurrency: Math.max(1, Number(config.concurrency) || 1) });
  const traces = [];

  // Кэш skill-файлов между кейсами одного скилла
  const skillCache = new Map();

  await Promise.all(
    cases.map((c) =>
      queue.add(async () => {
        const trace = await runOneCase({ c, adapter, judgeAdapter, agentsMd, skillCache, tracesDir });
        traces.push(trace);
      }),
    ),
  );

  const summary = summarize(traces);
  summary.run_id = runId;
  summary.adapter = adapter.name;
  summary.model = config.model ?? null;
  summary.started_at = new Date(Date.now()).toISOString();
  summary.cost_usd = estimateCost({
    model: config.model,
    input_tokens: summary.tokens_in,
    output_tokens: summary.tokens_out,
    pricing: config.pricing,
  });

  await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));

  await appendRun({
    kind: "rollout",
    run_id: runId,
    started_at: summary.started_at,
    adapter: adapter.name,
    model: config.model ?? null,
    summary,
    cost_usd: summary.cost_usd,
  });

  return { runId, summary, traces, runDir };
}

async function runOneCase({ c, adapter, judgeAdapter, agentsMd, skillCache, tracesDir }) {
  const startedAt = Date.now();

  // Кейс мог быть с ошибкой парсинга
  if (c.error) {
    const trace = {
      case_id: c.id,
      skill: c.skill,
      path: c.path,
      passed: false,
      score: 0,
      error: c.error,
      grader: null,
      latency_ms: 0,
    };
    await writeFile(join(tracesDir, `${c.skill}__${c.id}.json`), JSON.stringify(trace, null, 2));
    return trace;
  }

  let skillBlock;
  if (skillCache.has(c.skill)) {
    skillBlock = skillCache.get(c.skill);
  } else {
    try {
      skillBlock = await readSkillFile(c.skill);
      skillCache.set(c.skill, skillBlock);
    } catch (e) {
      const trace = {
        case_id: c.id,
        skill: c.skill,
        path: c.path,
        passed: false,
        score: 0,
        error: e.message,
        grader: null,
        latency_ms: Date.now() - startedAt,
      };
      await writeFile(join(tracesDir, `${c.skill}__${c.id}.json`), JSON.stringify(trace, null, 2));
      return trace;
    }
  }

  const system = buildSystem(agentsMd, skillBlock.text);
  const user = c.input;

  let llmResult, llmError;
  try {
    llmResult = await adapter.complete({
      system,
      user,
      max_tokens: c.frontmatter.budget?.max_tokens,
    });
  } catch (e) {
    llmError = e.message;
  }

  let graderResult = null;
  if (llmResult) {
    try {
      const grader = getGrader(c.frontmatter.grader, { judgeAdapter });
      const ctx = { input: c.input, frontmatter: c.frontmatter };
      // grader.grade может быть sync или async (llm-judge всегда async)
      graderResult = await grader.grade(llmResult.text, c.expected, ctx);
    } catch (e) {
      graderResult = { passed: false, score: 0, details: { error: e.message } };
    }
  }

  const trace = {
    case_id: c.id,
    skill: c.skill,
    path: c.path,
    grader: c.frontmatter.grader,
    tags: c.frontmatter.tags ?? [],
    passed: graderResult?.passed ?? false,
    score: graderResult?.score ?? 0,
    error: llmError ?? null,
    latency_ms: Date.now() - startedAt,
    usage: llmResult?.usage ?? { input_tokens: 0, output_tokens: 0 },
    prompt: { system_chars: system.length, user_chars: user.length },
    output: llmResult?.text ?? null,
    grader_details: graderResult?.details ?? null,
  };

  await writeFile(join(tracesDir, `${c.skill}__${c.id}.json`), JSON.stringify(trace, null, 2));
  return trace;
}

function summarize(traces) {
  const total = traces.length;
  const passed = traces.filter((t) => t.passed).length;
  const failed = traces.filter((t) => !t.passed && !t.error).length;
  const errored = traces.filter((t) => t.error).length;
  const tokensIn = traces.reduce((s, t) => s + (t.usage?.input_tokens ?? 0), 0);
  const tokensOut = traces.reduce((s, t) => s + (t.usage?.output_tokens ?? 0), 0);
  const bySkill = {};
  for (const t of traces) {
    if (!bySkill[t.skill]) bySkill[t.skill] = { total: 0, passed: 0 };
    bySkill[t.skill].total++;
    if (t.passed) bySkill[t.skill].passed++;
  }
  return {
    total,
    passed,
    failed,
    errored,
    pass_rate: total > 0 ? passed / total : 0,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    by_skill: bySkill,
  };
}

/**
 * Перепрогон graders по уже записанным traces (offline, без LLM).
 */
export async function runScore(runId) {
  const runDir = join(REPO_ROOT, ".context", "skillopt", runId);
  const summaryPath = join(runDir, "summary.json");
  if (!existsSync(summaryPath)) {
    throw new Error(`[skillopt:score] run не найден: ${runId} (нет ${summaryPath})`);
  }
  // Сравниваем существующие traces, перепрогоняя graders.
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(join(runDir, "traces"));
  const traces = [];
  const { discoverEvals } = await import("../evals/loader.mjs");
  const allCases = await discoverEvals();
  const byId = new Map(allCases.map((c) => [`${c.skill}__${c.id}`, c]));
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const t = JSON.parse(await readFile(join(runDir, "traces", f), "utf8"));
    if (!t.output) {
      traces.push(t);
      continue;
    }
    const c = byId.get(`${t.skill}__${t.case_id}`);
    if (!c || c.error) {
      traces.push(t);
      continue;
    }
    try {
      if (c.frontmatter.grader === "llm-judge") {
        // offline rescoring невозможен — judge требует LLM
        t.grader_details = { skipped: "llm-judge нельзя пересчитать офлайн" };
      } else {
        const g = getGrader(c.frontmatter.grader);
        const r = await g.grade(t.output, c.expected, { input: c.input, frontmatter: c.frontmatter });
        t.passed = r.passed;
        t.score = r.score;
        t.grader_details = r.details;
        await writeFile(join(runDir, "traces", f), JSON.stringify(t, null, 2));
      }
    } catch (e) {
      t.grader_details = { error: e.message };
    }
    traces.push(t);
  }
  const summary = summarize(traces);
  const prev = JSON.parse(await readFile(summaryPath, "utf8"));
  summary.run_id = prev.run_id;
  summary.adapter = prev.adapter;
  summary.model = prev.model;
  summary.started_at = prev.started_at;
  summary.rescored_at = new Date().toISOString();
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}
