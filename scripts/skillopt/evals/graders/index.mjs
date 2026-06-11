// graders/index.mjs — registry graders.
//
// Detect-only graders (contains, label-presence, json-schema) регистрируются статически.
// llm-judge требует adapter — фабрика возвращает grader, который нужно передать в rollout.

import { CONTAINS_GRADER } from "./contains.mjs";
import { LABEL_PRESENCE_GRADER } from "./label-presence.mjs";
import { JSON_SCHEMA_GRADER } from "./json-schema.mjs";
import { createLlmJudgeGrader } from "./llm-judge.mjs";

const STATIC_REGISTRY = {
  [CONTAINS_GRADER.name]: CONTAINS_GRADER,
  [LABEL_PRESENCE_GRADER.name]: LABEL_PRESENCE_GRADER,
  [JSON_SCHEMA_GRADER.name]: JSON_SCHEMA_GRADER,
};

/**
 * Возвращает grader по имени.
 * @param {string} name
 * @param {object} [opts]
 * @param {Adapter} [opts.judgeAdapter]   — нужен только для llm-judge
 */
export function getGrader(name, opts = {}) {
  if (STATIC_REGISTRY[name]) return STATIC_REGISTRY[name];
  if (name === "llm-judge") {
    if (!opts.judgeAdapter) {
      throw new Error(
        `[skillopt:graders] llm-judge требует --judge-model или judge_adapter (см. config.graders.judge_model).`,
      );
    }
    return createLlmJudgeGrader(opts.judgeAdapter, opts.judgeOpts);
  }
  throw new Error(
    `[skillopt:graders] неизвестный grader "${name}". Доступны: ${[...Object.keys(STATIC_REGISTRY), "llm-judge"].join(", ")}`,
  );
}

export function listGraders() {
  return [...Object.keys(STATIC_REGISTRY), "llm-judge"];
}
