// runner/diff.mjs — unified diff между proposal и текущим skill.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { REPO_ROOT, readSkillFile } from "../evals/loader.mjs";

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @returns {Promise<Array<{skill, diff, removed_pct, warn_majorRewrite}>>}
 */
export async function runDiff({ runId } = {}) {
  const runDir = join(REPO_ROOT, ".context", "skillopt", runId);
  const proposalsDir = join(runDir, "proposals");
  if (!existsSync(proposalsDir)) {
    throw new Error(`[skillopt:diff] нет proposals/ для run ${runId}. Сначала: pnpm skill reflect <run-id>`);
  }

  const files = await readdir(proposalsDir);
  const skills = files
    .filter((f) => f.endsWith(".md") && !f.endsWith(".rationale.md"))
    .map((f) => f.replace(/\.md$/, ""));

  const out = [];
  for (const skill of skills) {
    const proposal = await readFile(join(proposalsDir, `${skill}.md`), "utf8");
    let current;
    try {
      current = await readSkillFile(skill);
    } catch (e) {
      out.push({ skill, error: e.message });
      continue;
    }
    const removedChars = Math.max(0, current.text.length - proposal.length);
    const removedPct = current.text.length > 0 ? Math.round((removedChars / current.text.length) * 100) : 0;
    const diff = createTwoFilesPatch(
      current.path,
      `proposals/${skill}.md`,
      current.text,
      proposal,
      `current`,
      `run ${runId}`,
      { context: 3 },
    );
    out.push({
      skill,
      path: current.path,
      removed_pct: removedPct,
      warn_major_rewrite: removedPct > 30,
      old_size: current.text.length,
      new_size: proposal.length,
      diff,
    });
  }
  return out;
}
