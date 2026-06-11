#!/usr/bin/env node
// mcp-server.mjs — read-only MCP-сервер для SkillOpt.
//
// Принципиально read-only: агент видит историю runs, traces и proposals,
// но НЕ может запускать rollout/reflect/apply. Это сознательное ограничение
// (см. план §F): мутации остаются за CLI (human-in-the-loop), MCP — для observability.
//
// Запуск (вручную для smoke):
//   node scripts/skillopt/mcp-server.mjs
//
// Подключение в Claude Code / Desktop — в корневом .mcp.json:
//   {
//     "mcpServers": {
//       "skillopt-local": {
//         "command": "node",
//         "args": ["scripts/skillopt/mcp-server.mjs"]
//       }
//     }
//   }
//
// Экспонируемые tools:
//   • skill_list_runs(limit?, kind?, skill?)  — последние runs из metrics
//   • skill_get_trace(run_id, case_id?)        — конкретный trace или summary всего run'а
//   • skill_get_proposal(run_id, skill)        — proposed skill + rationale
//   • skill_list_evals(skill?)                  — eval-кейсы по скиллам
//   • skill_get_eval(skill, case_id)            — конкретный eval с frontmatter и body

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listRuns } from "./storage/metrics.mjs";
import { discoverEvals, listSkillsWithEvals } from "./evals/loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const RUNS_DIR = join(REPO_ROOT, ".context", "skillopt");

const server = new McpServer({
  name: `skillopt-${basename(REPO_ROOT)}`,
  version: "0.1.0",
});

// ---------- skill_list_runs ----------

server.registerTool(
  "skill_list_runs",
  {
    description:
      "Последние SkillOpt-runs из .context/skillopt/runs.jsonl. " +
      "Используй чтобы посмотреть историю оптимизации, найти run-id, понять тренд pass-rate. " +
      "Read-only — не запускает новые runs.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional().describe("Сколько runs вернуть (default 20)."),
      kind: z.enum(["rollout", "reflect", "apply"]).optional().describe("Фильтр по типу run'а."),
      skill: z.string().optional().describe("Фильтр по конкретному скиллу."),
    },
  },
  async ({ limit = 20, kind = null, skill = null }) => {
    const runs = await listRuns({ limit, kind, skill });
    return {
      content: [
        { type: "text", text: `Найдено ${runs.length} runs:` },
        { type: "text", text: JSON.stringify(runs, null, 2) },
      ],
    };
  },
);

// ---------- skill_get_trace ----------

server.registerTool(
  "skill_get_trace",
  {
    description:
      "Содержимое trace'а одного eval-кейса или summary целого run'а. " +
      "Если case_id не задан — возвращает summary.json. " +
      "Если задан — возвращает полный trace (prompt size, output, grader details, latency).",
    inputSchema: {
      run_id: z.string().min(1).regex(/^[\w.-]+$/, "только буквы, цифры, _ . -").describe("Run-id формата YYYY-MM-DDTHH-MM-SS-hex."),
      case_id: z.string().regex(/^[\w.-]+$/, "только буквы, цифры, _ . -").optional().describe("Если задан — конкретный trace вместо summary."),
      skill: z.string().regex(/^[\w.-]+$/, "только буквы, цифры, _ . -").optional().describe("Нужен в паре с case_id для уникальности имени файла."),
    },
  },
  async ({ run_id, case_id, skill }) => {
    const runDir = join(RUNS_DIR, run_id);
    if (!existsSync(runDir)) {
      return { content: [{ type: "text", text: `run не найден: ${run_id}` }], isError: true };
    }
    if (!case_id) {
      const summaryPath = join(runDir, "summary.json");
      if (!existsSync(summaryPath)) {
        return { content: [{ type: "text", text: `нет summary.json в ${runDir}` }], isError: true };
      }
      return {
        content: [
          { type: "text", text: `Summary run ${run_id}:` },
          { type: "text", text: await readFile(summaryPath, "utf8") },
        ],
      };
    }
    const tracesDir = join(runDir, "traces");
    if (!existsSync(tracesDir)) {
      return { content: [{ type: "text", text: `нет traces в ${runDir}` }], isError: true };
    }
    let fileName;
    if (skill) {
      fileName = `${skill}__${case_id}.json`;
    } else {
      // ищем единственный файл, оканчивающийся на __<case_id>.json
      const files = await readdir(tracesDir);
      const matches = files.filter((f) => f.endsWith(`__${case_id}.json`));
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `case "${case_id}" не найден в ${runDir}/traces/` }], isError: true };
      }
      if (matches.length > 1) {
        return {
          content: [
            { type: "text", text: `case "${case_id}" неоднозначен (${matches.length} совпадений). Уточните --skill.` },
            { type: "text", text: JSON.stringify(matches, null, 2) },
          ],
          isError: true,
        };
      }
      fileName = matches[0];
    }
    const tracePath = join(tracesDir, fileName);
    if (!existsSync(tracePath)) {
      return { content: [{ type: "text", text: `trace не найден: ${tracePath}` }], isError: true };
    }
    return {
      content: [
        { type: "text", text: `Trace ${fileName}:` },
        { type: "text", text: await readFile(tracePath, "utf8") },
      ],
    };
  },
);

// ---------- skill_get_proposal ----------

server.registerTool(
  "skill_get_proposal",
  {
    description:
      "Предложенная версия SKILL.md из reflect-run'а + rationale с метками AGENTS.md. " +
      "Только READ — не применяет. Чтобы применить — используй CLI: pnpm skill apply <run-id>.",
    inputSchema: {
      run_id: z.string().min(1).regex(/^[\w.-]+$/, "только буквы, цифры, _ . -").describe("Run-id с уже выполненным reflect."),
      skill: z.string().min(1).regex(/^[\w.-]+$/, "только буквы, цифры, _ . -").describe("Имя скилла (например skill-ingest)."),
    },
  },
  async ({ run_id, skill }) => {
    const propPath = join(RUNS_DIR, run_id, "proposals", `${skill}.md`);
    const ratPath = join(RUNS_DIR, run_id, "proposals", `${skill}.rationale.md`);
    if (!existsSync(propPath)) {
      return {
        content: [{ type: "text", text: `proposal не найден: ${propPath}. Сначала: pnpm skill reflect ${run_id}` }],
        isError: true,
      };
    }
    const proposal = await readFile(propPath, "utf8");
    const rationale = existsSync(ratPath) ? await readFile(ratPath, "utf8") : "(rationale не найден)";
    return {
      content: [
        { type: "text", text: `=== Rationale (${skill}) ===` },
        { type: "text", text: rationale },
        { type: "text", text: `=== Proposed SKILL.md (${skill}, ${proposal.length} chars) ===` },
        { type: "text", text: proposal },
      ],
    };
  },
);

// ---------- skill_list_evals ----------

server.registerTool(
  "skill_list_evals",
  {
    description: "Список всех eval-кейсов по скиллам с покрытием. Без LLM-вызовов.",
    inputSchema: {
      skill: z.string().optional().describe("Фильтр по конкретному скиллу."),
    },
  },
  async ({ skill = null }) => {
    if (skill) {
      const cases = await discoverEvals({ skillFilter: skill });
      return {
        content: [
          { type: "text", text: `Найдено ${cases.length} кейсов для ${skill}:` },
          { type: "text", text: JSON.stringify(
              cases.map((c) => ({
                case_id: c.id,
                path: c.path,
                grader: c.frontmatter?.grader,
                tags: c.frontmatter?.tags,
                error: c.error,
              })),
              null,
              2,
            ) },
        ],
      };
    }
    const skills = await listSkillsWithEvals();
    return {
      content: [{ type: "text", text: JSON.stringify(skills, null, 2) }],
    };
  },
);

// ---------- skill_get_eval ----------

server.registerTool(
  "skill_get_eval",
  {
    description: "Полный eval-кейс: frontmatter + input + expected. Без LLM-вызовов.",
    inputSchema: {
      skill: z.string().min(1),
      case_id: z.string().min(1),
    },
  },
  async ({ skill, case_id }) => {
    const cases = await discoverEvals({ skillFilter: skill, caseFilter: case_id });
    if (cases.length === 0) {
      return { content: [{ type: "text", text: `eval не найден: ${skill}/${case_id}` }], isError: true };
    }
    const c = cases[0];
    if (c.error) {
      return { content: [{ type: "text", text: `ошибка парсинга: ${c.error}` }], isError: true };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              path: c.path,
              frontmatter: c.frontmatter,
              input: c.input,
              expected: c.expected,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------- start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[skillopt-mcp] started (read-only), tools: skill_list_runs, skill_get_trace, skill_get_proposal, skill_list_evals, skill_get_eval`);
