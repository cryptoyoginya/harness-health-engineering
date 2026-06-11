// graders/contains.mjs — простой substring / regex grader.
//
// Формат секции "# Expected":
//   - must contain: "слово 1"
//   - must contain: "слово 2"
//   - must not contain: "плохое слово"
//   - regex: /pattern/i
//
// Пропуски в формулировках "must contain" / "should contain" / "contains" — все валидны.
// Pass = все must-have условия выполнены И ни одно must-not условие не нарушено.

const MUST_HAVE_RE = /^[-*]\s*(?:must contain|should contain|contains?)\s*:\s*(.+)$/i;
const MUST_NOT_RE = /^[-*]\s*(?:must not contain|should not contain|missing)\s*:\s*(.+)$/i;
const REGEX_RE = /^[-*]\s*regex\s*:\s*\/(.+)\/([gimsuy]*)$/i;

const GRADER_VERSION = "contains/0.1";

export const CONTAINS_GRADER = {
  name: "contains",
  version: GRADER_VERSION,
  /**
   * @param {string} output    — текст ответа от LLM
   * @param {string} expected  — содержимое секции "# Expected"
   * @returns {{passed: boolean, score: number, details: object}}
   */
  grade(output, expected) {
    const checks = parseChecks(expected);
    if (checks.length === 0) {
      return {
        passed: false,
        score: 0,
        details: { error: "не найдено ни одного check'а в # Expected", grader_version: GRADER_VERSION },
      };
    }
    const results = checks.map((c) => evaluateOne(output, c));
    const passedCount = results.filter((r) => r.passed).length;
    const score = passedCount / results.length;
    return {
      passed: results.every((r) => r.passed),
      score,
      details: { checks: results, grader_version: GRADER_VERSION },
    };
  },
};

function parseChecks(expected) {
  const out = [];
  for (const raw of expected.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const mNot = MUST_NOT_RE.exec(line);
    if (mNot) {
      out.push({ kind: "must_not", needle: stripQuotes(mNot[1].trim()) });
      continue;
    }
    const mRe = REGEX_RE.exec(line);
    if (mRe) {
      out.push({ kind: "regex", pattern: mRe[1], flags: mRe[2] });
      continue;
    }
    const mHave = MUST_HAVE_RE.exec(line);
    if (mHave) {
      out.push({ kind: "must_have", needle: stripQuotes(mHave[1].trim()) });
      continue;
    }
  }
  return out;
}

function stripQuotes(s) {
  return s.replace(/^["'`]|["'`]$/g, "");
}

function evaluateOne(output, check) {
  if (check.kind === "must_have") {
    return { ...check, passed: output.includes(check.needle) };
  }
  if (check.kind === "must_not") {
    return { ...check, passed: !output.includes(check.needle) };
  }
  if (check.kind === "regex") {
    try {
      const re = new RegExp(check.pattern, check.flags);
      return { ...check, passed: re.test(output) };
    } catch (e) {
      return { ...check, passed: false, error: e.message };
    }
  }
  return { ...check, passed: false, error: "unknown check kind" };
}
