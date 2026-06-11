// graders/llm-judge.mjs — LLM-as-judge grader.
//
// Формат секции "# Expected":
//   Свободный текст рубрики (5-7 строк), описывающий критерии оценки.
//   Можно перечислять признаки качества, что должно/не должно быть.
//   Шкала 1-5 (5 = идеально). pass_threshold во frontmatter eval-кейса (по умолчанию 0.8 — score≥4).
//
// Реализован через external context: adapter передаётся в createLlmJudge() при инициализации.
// Это позволяет grader'у не знать про config/factory — он просто получает функцию complete.
//
// Адаптация: судья получает PROMPT, OUTPUT и RUBRIC, отвечает строго в формате
//   SCORE: <1-5>
//   REASONING: <короткое обоснование>
//
// Парсер устойчив к лишним токенам вокруг.

const GRADER_VERSION = "llm-judge/0.1";

const JUDGE_PROMPT = `Ты — строгий evaluator качества ответов AI-агентов в knowledge-base-проектах.

Тебе дан вопрос пользователя, ответ агента и рубрика. Твоя задача — поставить score от 1 до 5 (целое число), где:
  5 = отвечает на вопрос полностью, соблюдает рубрику, без галлюцинаций
  4 = хороший ответ с минорными отклонениями от рубрики
  3 = приемлемо, но есть пробелы или одно явное нарушение
  2 = серьёзные проблемы (галлюцинации, нарушения формата, неполнота)
  1 = плохо (не отвечает на вопрос или критические нарушения)

Отвечай СТРОГО в формате:
SCORE: <число от 1 до 5>
REASONING: <одно-два предложения>

Никаких других секций, никаких префиксов.`;

const SCORE_RE = /\bSCORE\s*:\s*(\d)\b/i;
const REASONING_RE = /\bREASONING\s*:\s*(.+?)(?:\n\n|$)/is;

/**
 * Фабрика: возвращает grader-объект, связанный с конкретным adapter'ом.
 * @param {Adapter} judgeAdapter   adapter для вызова модели-судьи
 * @param {object} [opts]
 * @param {number} [opts.pass_threshold=0.8]
 */
export function createLlmJudgeGrader(judgeAdapter, opts = {}) {
  const defaultThreshold = opts.pass_threshold ?? 0.8;

  return {
    name: "llm-judge",
    version: GRADER_VERSION,
    async grade(output, expected, ctx = {}) {
      const userPrompt = [
        "## Вопрос пользователя",
        ctx.input ?? "(не передан)",
        "",
        "## Ответ агента (нужно оценить)",
        output,
        "",
        "## Рубрика",
        expected,
        "",
        "Поставь SCORE от 1 до 5 и REASONING.",
      ].join("\n");

      let res;
      try {
        res = await judgeAdapter.complete({ system: JUDGE_PROMPT, user: userPrompt, max_tokens: 400 });
      } catch (e) {
        return { passed: false, score: 0, details: { error: e.message, grader_version: GRADER_VERSION } };
      }

      const scoreMatch = SCORE_RE.exec(res.text);
      const reasoningMatch = REASONING_RE.exec(res.text);
      if (!scoreMatch) {
        return {
          passed: false,
          score: 0,
          details: {
            error: "judge не вернул SCORE: <n>",
            judge_output: res.text.slice(0, 500),
            grader_version: GRADER_VERSION,
          },
        };
      }
      const score5 = Number(scoreMatch[1]);
      const score01 = (score5 - 1) / 4; // 1→0, 5→1
      const threshold = ctx.frontmatter?.pass_threshold ?? defaultThreshold;

      return {
        passed: score01 >= threshold,
        score: score01,
        details: {
          score_5: score5,
          score_01: score01,
          threshold,
          reasoning: reasoningMatch ? reasoningMatch[1].trim() : null,
          judge_usage: res.usage,
          grader_version: GRADER_VERSION,
        },
      };
    },
  };
}
