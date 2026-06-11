// evals/loader.mjs — discover и parse eval-кейсов.
//
// Структура:
//   skills/<skill-name>/evals/<case-id>.yaml
//
// Формат файла:
//   ---
//   type: eval-case
//   version: v0.1
//   skill: skill-ingest
//   grader: contains
//   tags: [regression, happy-path]
//   budget: { max_tokens: 8000, timeout_ms: 60000 }
//   pass_threshold: 0.8                # для llm-judge
//   ---
//   # Input
//   <текст промпта, поддержка {{file:relative/path.md}}>
//
//   # Expected
//   <блок ожиданий — зависит от grader'а>

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..", "..");
export const SKILLS_DIR = join(REPO_ROOT, "skills");

const EvalCaseFrontmatterSchema = z.object({
  type: z.literal("eval-case"),
  version: z.string(),
  skill: z.string(),
  grader: z.enum(["contains", "label-presence", "json-schema", "llm-judge"]),
  tags: z.array(z.string()).optional().default([]),
  budget: z
    .object({
      max_tokens: z.number().int().positive().optional(),
      timeout_ms: z.number().int().positive().optional(),
    })
    .optional()
    .default({}),
  pass_threshold: z.number().min(0).max(1).optional(),
  owner: z.string().optional(),
});

const EvalCaseSchema = z.object({
  id: z.string(),
  path: z.string(),
  skill: z.string(),
  frontmatter: EvalCaseFrontmatterSchema,
  input: z.string(),
  expected: z.string(),
});

/**
 * Парсит один YAML-файл eval-кейса.
 */
export async function parseEvalCase(absPath) {
  const raw = await readFile(absPath, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`[skillopt:loader] ${relative(REPO_ROOT, absPath)}: нет frontmatter (---...---)`);
  }
  let fm;
  try {
    fm = yaml.load(fmMatch[1]);
  } catch (e) {
    throw new Error(`[skillopt:loader] ${relative(REPO_ROOT, absPath)}: невалидный YAML — ${e.message}`);
  }
  const fmParsed = EvalCaseFrontmatterSchema.safeParse(fm);
  if (!fmParsed.success) {
    throw new Error(
      `[skillopt:loader] ${relative(REPO_ROOT, absPath)}: невалидный frontmatter — ${fmParsed.error.message}`,
    );
  }
  const body = fmMatch[2] ?? "";
  const sections = splitSections(body);
  if (!sections.Input) {
    throw new Error(`[skillopt:loader] ${relative(REPO_ROOT, absPath)}: нет секции "# Input"`);
  }
  if (!sections.Expected) {
    throw new Error(`[skillopt:loader] ${relative(REPO_ROOT, absPath)}: нет секции "# Expected"`);
  }

  // Раскрываем {{file:...}} интерполяцию в input
  const inputResolved = await interpolateFiles(sections.Input.trim(), dirname(absPath));

  const caseId = basename(absPath, ".yaml");
  return EvalCaseSchema.parse({
    id: caseId,
    path: relative(REPO_ROOT, absPath),
    skill: fmParsed.data.skill,
    frontmatter: fmParsed.data,
    input: inputResolved,
    expected: sections.Expected.trim(),
  });
}

function splitSections(body) {
  const out = {};
  const lines = body.split("\n");
  let current = null;
  let buf = [];
  for (const line of lines) {
    const m = line.match(/^#\s+(\S.*)$/);
    if (m) {
      if (current) out[current] = buf.join("\n");
      current = m[1].trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (current) out[current] = buf.join("\n");
  return out;
}

async function interpolateFiles(text, baseDir) {
  const re = /\{\{file:([^}]+)\}\}/g;
  let out = "";
  let lastIdx = 0;
  for (const m of text.matchAll(re)) {
    out += text.slice(lastIdx, m.index);
    const rel = m[1].trim();
    // ищем относительно baseDir (директория самого eval-файла) с fallback _fixtures/
    const candidates = [
      join(baseDir, rel),
      join(baseDir, "_fixtures", rel),
      join(REPO_ROOT, rel),
    ];
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) {
      throw new Error(`[skillopt:loader] не найден файл фикстуры: ${rel} (пробовали ${candidates.join(" | ")})`);
    }
    out += await readFile(hit, "utf8");
    lastIdx = m.index + m[0].length;
  }
  out += text.slice(lastIdx);
  return out;
}

/**
 * Discover eval-кейсы под skills/<skill-name>/evals/*.yaml.
 * @param {string} [skillFilter] — если задан, вернёт только этот скилл
 * @param {string} [caseFilter]  — если задан, вернёт только этот case-id
 */
export async function discoverEvals({ skillFilter = null, caseFilter = null } = {}) {
  if (!existsSync(SKILLS_DIR)) return [];
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name === "_shared") continue;
    if (skillFilter && e.name !== skillFilter) continue;
    const evalsDir = join(SKILLS_DIR, e.name, "evals");
    if (!existsSync(evalsDir)) continue;
    const files = await readdir(evalsDir);
    for (const f of files) {
      if (!f.endsWith(".yaml") && !f.endsWith(".yml")) continue;
      if (f.startsWith("_")) continue;
      const caseId = basename(f, ".yaml").replace(/\.yml$/, "");
      if (caseFilter && caseId !== caseFilter) continue;
      try {
        const parsed = await parseEvalCase(join(evalsDir, f));
        out.push(parsed);
      } catch (err) {
        // не падаем на одном битом файле — продолжаем, ошибку отдаём наверх
        out.push({ id: caseId, skill: e.name, path: relative(REPO_ROOT, join(evalsDir, f)), error: err.message });
      }
    }
  }
  return out;
}

/**
 * Поверхностный обзор: какие скиллы есть и сколько у них кейсов.
 */
export async function listSkillsWithEvals() {
  if (!existsSync(SKILLS_DIR)) return [];
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name === "_shared") continue;
    const skillFile = join(SKILLS_DIR, `${e.name}.md`);
    const evalsDir = join(SKILLS_DIR, e.name, "evals");
    let caseCount = 0;
    if (existsSync(evalsDir)) {
      const files = await readdir(evalsDir);
      caseCount = files.filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.startsWith("_")).length;
    }
    out.push({
      skill: e.name,
      skillFileExists: existsSync(skillFile),
      caseCount,
    });
  }
  // Также скиллы-файлы без поддиректории (legacy формат)
  const filesAtRoot = entries.filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_"));
  for (const f of filesAtRoot) {
    const name = basename(f.name, ".md");
    if (name === "README") continue;
    if (out.some((o) => o.skill === name)) continue;
    out.push({ skill: name, skillFileExists: true, caseCount: 0 });
  }
  return out.sort((a, b) => a.skill.localeCompare(b.skill));
}

/**
 * Читает содержимое skill-файла (как text). Поддерживает оба формата:
 *   skills/skill-foo.md
 *   skills/skill-foo/skill-foo.md  (если когда-нибудь введём)
 */
export async function readSkillFile(skillName) {
  const candidates = [
    join(SKILLS_DIR, `${skillName}.md`),
    join(SKILLS_DIR, skillName, `${skillName}.md`),
    join(SKILLS_DIR, skillName, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: relative(REPO_ROOT, p), text: await readFile(p, "utf8") };
  }
  throw new Error(`[skillopt:loader] skill-файл не найден для "${skillName}". Пробовали: ${candidates.join(" | ")}`);
}
