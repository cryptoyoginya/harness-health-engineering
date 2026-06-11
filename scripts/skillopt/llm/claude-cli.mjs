// claude-cli.mjs — adapter поверх Claude Code CLI (`claude -p ...`).
//
// Реюз паттерна из scripts/semantic/think.mjs:140-148 и scripts/dream-cycle.mjs:207-217:
// проверка которой версии в PATH + spawn. Адаптировано под async-API adapter'а.
//
// ARG_MAX-aware: для коротких промптов передаём через -p (argv), для длинных — через stdin.
// Если на Windows ARG_MAX ~32KB; на Linux/macOS ~256KB. Порог 10KB консервативный.

import { spawn, spawnSync } from "node:child_process";

const STDIN_THRESHOLD = 10_000; // bytes; выше этого размера — stdin вместо argv

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function makeClaudeCliAdapter(cfg = {}) {
  const cmd = cfg.cli?.command ?? "claude";
  const model = cfg.model ?? process.env.CLAUDE_MODEL ?? null;
  const extraArgs = Array.isArray(cfg.cli?.extra_args) ? cfg.cli.extra_args : [];
  const timeoutMs = cfg.timeout_ms ?? 300_000;

  // Lazy-check для понятной ошибки
  let validated = false;
  function ensure() {
    if (validated) return;
    if (!which(cmd)) {
      throw new Error(
        `[skillopt:claude-cli] CLI "${cmd}" не найден в PATH. ` +
          'Установите Claude Code (https://docs.claude.com/en/docs/claude-code) или выберите другой provider в .skillopt.json.',
      );
    }
    validated = true;
  }

  return {
    name: "claude-cli",
    capabilities: { streaming: true, json_mode: false, max_context_tokens: 200_000 },

    async complete({ system, user }) {
      ensure();

      // Системный промпт склеиваем в начало user-блока с явным разделителем —
      // claude CLI не имеет универсального --system флага во всех версиях.
      const fullPrompt = system
        ? `${system}\n\n---\n\n${user}`
        : user;

      const useStdin = Buffer.byteLength(fullPrompt, "utf8") > STDIN_THRESHOLD;
      const args = ["-p"];
      if (model) args.push("--model", model);
      args.push(...extraArgs);
      if (!useStdin) args.push(fullPrompt);

      return await new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, {
          stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let killed = false;

        const killTimer = setTimeout(() => {
          killed = true;
          proc.kill("SIGTERM");
        }, timeoutMs);

        proc.stdout.on("data", (b) => (stdout += b.toString()));
        proc.stderr.on("data", (b) => (stderr += b.toString()));

        proc.on("error", (e) => {
          clearTimeout(killTimer);
          reject(e);
        });
        proc.on("close", (code) => {
          clearTimeout(killTimer);
          if (killed) return reject(new Error(`[skillopt:claude-cli] timeout ${timeoutMs}ms`));
          if (code !== 0) {
            return reject(
              new Error(`[skillopt:claude-cli] exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`),
            );
          }
          resolve({
            text: stdout.trim(),
            usage: { input_tokens: 0, output_tokens: 0 }, // claude CLI не отдаёт usage
            raw: { stdout, stderr },
          });
        });

        if (useStdin) {
          proc.stdin.write(fullPrompt);
          proc.stdin.end();
        }
      });
    },
  };
}
