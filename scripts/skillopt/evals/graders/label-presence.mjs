// graders/label-presence.mjs — проверка наличия AGENTS.md меток в ответе.
//
// Формат секции "# Expected":
//   - required labels: FACT, RECOMMENDATION
//   - forbidden labels: RECOMMENDATION    (если хочется наоборот)
//   - at least: 2 distinct           (минимум различных меток)
//
// Метки распознаются как `LABEL:` в начале строки или после bullet'а.

const REQUIRED_RE = /^[-*]\s*required labels?\s*:\s*(.+)$/i;
const FORBIDDEN_RE = /^[-*]\s*forbidden labels?\s*:\s*(.+)$/i;
const AT_LEAST_RE = /^[-*]\s*at least\s*:\s*(\d+)\s*distinct/i;

const KNOWN_LABELS = [
  "FACT",
  "INFERENCE",
  "ASSUMPTION",
  "UNKNOWN",
  "RISK",
  "DECISION",
  "RECOMMENDATION",
];

const GRADER_VERSION = "label-presence/0.1";

export const LABEL_PRESENCE_GRADER = {
  name: "label-presence",
  version: GRADER_VERSION,
  grade(output, expected) {
    const rules = parseRules(expected);
    const found = detectLabels(output);

    const checks = [];
    let allPass = true;

    for (const lbl of rules.required) {
      const passed = found.counts[lbl] > 0;
      checks.push({ kind: "required", label: lbl, passed });
      if (!passed) allPass = false;
    }
    for (const lbl of rules.forbidden) {
      const passed = !found.counts[lbl];
      checks.push({ kind: "forbidden", label: lbl, passed });
      if (!passed) allPass = false;
    }
    if (rules.atLeastDistinct != null) {
      const passed = found.distinct.length >= rules.atLeastDistinct;
      checks.push({
        kind: "at_least_distinct",
        threshold: rules.atLeastDistinct,
        actual: found.distinct.length,
        passed,
      });
      if (!passed) allPass = false;
    }

    if (checks.length === 0) {
      return {
        passed: false,
        score: 0,
        details: { error: "не найдено ни одного rule в # Expected", grader_version: GRADER_VERSION },
      };
    }

    const passedCount = checks.filter((c) => c.passed).length;
    return {
      passed: allPass,
      score: passedCount / checks.length,
      details: { checks, found, grader_version: GRADER_VERSION },
    };
  },
};

function parseRules(expected) {
  const out = { required: [], forbidden: [], atLeastDistinct: null };
  for (const raw of expected.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    let m;
    if ((m = REQUIRED_RE.exec(line))) {
      out.required.push(...parseLabelList(m[1]));
    } else if ((m = FORBIDDEN_RE.exec(line))) {
      out.forbidden.push(...parseLabelList(m[1]));
    } else if ((m = AT_LEAST_RE.exec(line))) {
      out.atLeastDistinct = Number(m[1]);
    }
  }
  return out;
}

function parseLabelList(s) {
  return s
    .split(/[,\s]+/)
    .map((x) => x.replace(/[^A-Z]/gi, "").toUpperCase())
    .filter((x) => KNOWN_LABELS.includes(x));
}

function detectLabels(text) {
  const counts = {};
  const re = new RegExp(`\\b(${KNOWN_LABELS.join("|")}):`, "g");
  for (const m of text.matchAll(re)) {
    const lbl = m[1];
    counts[lbl] = (counts[lbl] ?? 0) + 1;
  }
  return { counts, distinct: Object.keys(counts) };
}
