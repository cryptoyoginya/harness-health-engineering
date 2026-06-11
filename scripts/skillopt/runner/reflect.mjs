// runner/reflect.mjs — 2-й LLM-pass: trace + skill → proposed edits.
//
// Что делает:
//   1. Берёт run-id, читает summary.json + traces/<skill>__*.json
//   2. Группирует traces по skill
//   3. Для каждого skill: проверка количества кейсов (>=5 иначе skip — overfit prevention)
//   4. Формирует prompt из ./prompts/reflect.md + текущий skill + traces
//   5. adapter.complete(...)
//   6. Парсит ответ → proposals/<skill>.md (новая версия) + rationale.md
//
// Никогда не пишет в skills/. Только в .context/skillopt/<run-id>/proposals/.

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillFile, REPO_ROOT } from "../evals/loader.mjs";
import { appendRun, estimateCost } from "../storage/metrics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFLECT_PROMPT_PATH = resolve(__dirname, "..", "prompts", "reflect.md");

const PROPOSED_START = "===PROPOSED-SKILL-START===";
const PROPOSED_END = "===PROPOSED-SKILL-END===";

const MIN_CASES_FOR_REFLECT = 5;

export async function runReflect({ runId, adapter, config, force = false } = {}) {
  const runDir = join(REPO_ROOT, ".context", "skillopt", runId);
  const summaryPath = join(runDir, "summary.json");
  if (!existsSync(summaryPath)) {
    throw new Error(`[skillopt:reflect] run не найден: ${runId} (нет ${summaryPath})`);
  }

  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const tracesDir = join(runDir, "traces");
  const traceFiles = await readdir(tracesDir);
  const traces = [];
  for (const f of traceFiles) {
    if (!f.endsWith(".json")) continue;
    traces.push(JSON.parse(await readFile(join(tracesDir, f), "utf8")));
  }

  // Группируем по skill
  const bySkill = new Map();
  for (const t of traces) {
    if (!bySkill.has(t.skill)) bySkill.set(t.skill, []);
    bySkill.get(t.skill).push(t);
  }

  const proposalsDir = join(runDir, "proposals");
  await mkdir(proposalsDir, { recursive: true });

  const systemPrompt = await readFile(REFLECT_PROMPT_PATH, "utf8");
  const results = [];

  for (const [skill, skillTraces] of bySkill) {
    const passed = skillTraces.filter((t) => t.passed).length;
    const total = skillTraces.length;

    if (!force && total < MIN_CASES_FOR_REFLECT) {
      results.push({
        skill,
        skipped: true,
        reason: `только ${total} кейсов — нужно минимум ${MIN_CASES_FOR_REFLECT} (overfit prevention). Используйте --force для bypass.`,
      });
      continue;
    }

    if (!force && passed === total) {
      results.push({
        skill,
        skipped: true,
        reason: `все ${total} кейсов pass — нет повода reflect'ить. Используйте --force для bypass.`,
      });
      continue;
    }

    const skillFile = await readSkillFile(skill);
    const userPrompt = buildUserPrompt({ skill, skillFile, skillTraces, summary });

    let llmResult;
    try {
      llmResult = await adapter.complete({
        system: systemPrompt,
        user: userPrompt,
        max_tokens: 8000,
      });
    } catch (e) {
      results.push({ skill, error: e.message });
      continue;
    }

    const parsed = parseReflection(llmResult.text);
    if (parsed.error) {
      results.push({ skill, error: parsed.error, raw_output_preview: llmResult.text.slice(0, 500) });
      continue;
    }

    // Проверка минимальной дисциплины меток
    if (!/\bFACT:/.test(parsed.rationale) || !/\bRECOMMENDATION:/.test(parsed.rationale)) {
      results.push({
        skill,
        error: "rationale без обязательных меток FACT: и RECOMMENDATION: — отвергнут",
        rationale_preview: parsed.rationale.slice(0, 400),
      });
      continue;
    }

    // Жёсткий guard: не выкинуть frontmatter
    const oldFm = (skillFile.text.match(/^---\n[\s\S]*?\n---/) ?? [""])[0];
    const newFm = (parsed.proposedSkill.match(/^---\n[\s\S]*?\n---/) ?? [""])[0];
    if (oldFm && !newFm) {
      results.push({ skill, error: "новая версия скилла потеряла frontmatter — отвергнута" });
      continue;
    }

    const propPath = join(proposalsDir, `${skill}.md`);
    const ratPath = join(proposalsDir, `${skill}.rationale.md`);
    await writeFile(propPath, parsed.proposedSkill);
    await writeFile(ratPath, parsed.rationale);

    const sizeDelta = parsed.proposedSkill.length - skillFile.text.length;
    results.push({
      skill,
      proposed_path: propPath,
      rationale_path: ratPath,
      old_size: skillFile.text.length,
      new_size: parsed.proposedSkill.length,
      delta_pct: skillFile.text.length > 0 ? Math.round((sizeDelta / skillFile.text.length) * 100) : 0,
      usage: llmResult.usage,
    });
  }

  const cost = results.reduce(
    (s, r) => s + estimateCost({ model: config.model, ...(r.usage ?? {}) }),
    0,
  );

  await appendRun({
    kind: "reflect",
    run_id: runId,
    started_at: new Date().toISOString(),
    adapter: adapter.name,
    model: config.model ?? null,
    results,
    cost_usd: cost,
  });

  return { results, cost_usd: cost, runDir };
}

function buildUserPrompt({ skill, skillFile, skillTraces, summary }) {
  const lines = [];
  lines.push(`# Skill под оптимизацию: ${skill}`);
  lines.push("");
  lines.push(`## Текущая версия (${skillFile.path}, ${skillFile.text.length} символов)`);
  lines.push("");
  lines.push("```markdown");
  lines.push(skillFile.text);
  lines.push("```");
  lines.push("");
  lines.push("## Summary прогона");
  lines.push("");
  lines.push(`- Всего кейсов: ${skillTraces.length}`);
  lines.push(`- Pass: ${skillTraces.filter((t) => t.passed).length}`);
  lines.push(`- Fail: ${skillTraces.filter((t) => !t.passed && !t.error).length}`);
  lines.push(`- Errored: ${skillTraces.filter((t) => t.error).length}`);
  lines.push("");
  lines.push("## Traces (по одному блоку на кейс)");
  lines.push("");
  for (const t of skillTraces) {
    lines.push(`### case_id: ${t.case_id}   status: ${t.passed ? "PASS" : t.error ? "ERR" : "FAIL"}`);
    lines.push("");
    if (t.tags?.length) lines.push(`tags: ${t.tags.join(", ")}`);
    lines.push(`grader: ${t.grader}`);
    if (t.error) {
      lines.push(`error: ${t.error}`);
    } else {
      lines.push("**Вопрос (input):**");
      lines.push("```");
      // обрезаем большие inputs
      lines.push(truncate(t_input(t), 1500));
      lines.push("```");
      lines.push("**Ответ модели (output):**");
      lines.push("```");
      lines.push(truncate(t.output ?? "", 2500));
      lines.push("```");
      lines.push("**Grader details:**");
      lines.push("```json");
      lines.push(JSON.stringify(t.grader_details ?? {}, null, 2));
      lines.push("```");
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("Выдай RATIONALE (с метками) + новую версию SKILL.md по контракту в системной инструкции.");
  return lines.join("\n");
}

function t_input(trace) {
  // input в trace не хранится — лежит в самом eval-файле; но reflect ужe смотрит на trace
  // и нам важнее output + grader_details. Если нужен исходный input, используем prompt.user_chars
  // как индикатор размера. Для целей промпта возвращаем плейсхолдер с информацией.
  return `(input не сохраняется в trace — длина ${trace.prompt?.user_chars ?? 0} символов)`;
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + `… [обрезано, всего ${s.length}]` : s;
}

function parseReflection(text) {
  const startIdx = text.indexOf(PROPOSED_START);
  if (startIdx < 0) {
    return { error: `не найдена секция ${PROPOSED_START}` };
  }
  const endIdx = text.indexOf(PROPOSED_END, startIdx);
  if (endIdx < 0) {
    return { error: `не найдена секция ${PROPOSED_END}` };
  }
  const rationale = text.slice(0, startIdx).trim();
  const proposedSkill = text.slice(startIdx + PROPOSED_START.length, endIdx).trim();
  if (proposedSkill.length < 50) {
    return { error: `proposed skill слишком короткий (${proposedSkill.length} chars) — отвергнут` };
  }
  return { rationale, proposedSkill };
}
