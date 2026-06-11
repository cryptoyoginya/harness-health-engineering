// runner/edit.mjs — применение proposal в shadow copy (без коммита).
//
// apply():
//   1. Проверяет что working tree чист для конкретного skill-файла (git diff --quiet)
//      → если грязный, отказывается работать (защита от потери ручных правок)
//   2. Backup текущего skill в .context/skillopt/<run-id>/backups/<skill>.md
//   3. Overwrite skills/<skill>.md содержимым из proposals/<skill>.md
//   4. git add staging (но НЕ commit — пользователь сам решает)
//
// revert():
//   Восстанавливает skill из backup.
//
// Не запускает rollout — это работа gate.mjs (вызывается отдельно).

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, readSkillFile } from "../evals/loader.mjs";

function gitWorkingTreeClean(filePath) {
  // git status --porcelain <path> — пустой выход = чисто
  const r = spawnSync("git", ["status", "--porcelain", filePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (r.status !== 0) return null; // git недоступен / не репо → не блокируем
  return r.stdout.trim() === "";
}

function gitAdd(filePath) {
  const r = spawnSync("git", ["add", filePath], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0;
}

/**
 * Применяет proposal'ы из run'а к реальным skill-файлам.
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string[]|null} opts.skillFilter — если задан, применить только указанные скиллы
 * @returns {Promise<{applied: object[], skipped: object[]}>}
 */
export async function runApply({ runId, skillFilter = null } = {}) {
  const runDir = join(REPO_ROOT, ".context", "skillopt", runId);
  const proposalsDir = join(runDir, "proposals");
  if (!existsSync(proposalsDir)) {
    throw new Error(`[skillopt:apply] нет proposals/ для run ${runId}. Сначала: pnpm skill reflect <run-id>`);
  }
  const backupsDir = join(runDir, "backups");
  await mkdir(backupsDir, { recursive: true });

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(proposalsDir);
  const skills = files
    .filter((f) => f.endsWith(".md") && !f.endsWith(".rationale.md"))
    .map((f) => f.replace(/\.md$/, ""))
    .filter((s) => !skillFilter || skillFilter.includes(s));

  const applied = [];
  const skipped = [];

  for (const skill of skills) {
    const proposalText = await readFile(join(proposalsDir, `${skill}.md`), "utf8");

    let current;
    try {
      current = await readSkillFile(skill);
    } catch (e) {
      skipped.push({ skill, reason: e.message });
      continue;
    }

    const absSkillPath = join(REPO_ROOT, current.path);

    const clean = gitWorkingTreeClean(current.path);
    if (clean === false) {
      skipped.push({
        skill,
        reason: `working tree грязный для ${current.path}. Закоммитьте/откатите изменения перед apply (или сделайте --force, но осторожно).`,
      });
      continue;
    }

    // Backup
    await copyFile(absSkillPath, join(backupsDir, `${skill}.md`));

    // Overwrite
    await writeFile(absSkillPath, proposalText);

    // Stage в git (если git доступен)
    const staged = gitAdd(current.path);

    applied.push({
      skill,
      path: current.path,
      backup_path: join("backups", `${skill}.md`),
      old_size: current.text.length,
      new_size: proposalText.length,
      git_staged: staged,
    });
  }

  // Сохраняем applied-summary
  const summaryPath = join(runDir, "applied.json");
  await writeFile(summaryPath, JSON.stringify({ runId, appliedAt: new Date().toISOString(), applied, skipped }, null, 2));

  return { applied, skipped, summaryPath };
}

/**
 * Откатывает применённые скиллы из backup'а.
 */
export async function runRevert({ runId, skillFilter = null } = {}) {
  const runDir = join(REPO_ROOT, ".context", "skillopt", runId);
  const appliedPath = join(runDir, "applied.json");
  if (!existsSync(appliedPath)) {
    throw new Error(`[skillopt:revert] нет applied.json для run ${runId}. Похоже, apply не запускался.`);
  }
  const applied = JSON.parse(await readFile(appliedPath, "utf8"));
  const reverted = [];
  const skipped = [];

  for (const a of applied.applied) {
    if (skillFilter && !skillFilter.includes(a.skill)) continue;
    const backup = join(runDir, a.backup_path);
    if (!existsSync(backup)) {
      skipped.push({ skill: a.skill, reason: `backup не найден: ${backup}` });
      continue;
    }
    const target = join(REPO_ROOT, a.path);
    await copyFile(backup, target);
    gitAdd(a.path);
    reverted.push({ skill: a.skill, path: a.path });
  }

  return { reverted, skipped };
}
