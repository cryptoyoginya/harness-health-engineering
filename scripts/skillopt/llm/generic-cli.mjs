// generic-cli.mjs — universal CLI-adapter. Покрывает sgpt, llm (Simon Willison),
// gemini, codex, ollama-через-CLI, любой кастомный binary с stdin/argv interface.
//
// Конфиг (раздел "cli" в .skillopt.json):
//   {
//     "provider": "generic-cli",
//     "model": "gpt-4o-mini",          // опционально, попадает в {{model}}
//     "cli": {
//       "command": "sgpt",
//       "args": ["--no-interaction", "--model", "{{model}}"],
//       "stdin_template": "{{system}}\n\n---\n\n{{user}}",
//       "output_parser": "raw",         // raw | json-path
//       "output_path": "$.choices[0].text"  // только для json-path
//     }
//   }
//
// Подстановки в args/stdin_template: {{model}}, {{system}}, {{user}}.

import { spawn, spawnSync } from "node:child_process";

const STDIN_THRESHOLD = 10_000;

function which(cmd) {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.status === 0;
}

function interpolate(s, vars) {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function jsonPath(obj, path) {
  // мини-JSONPath: $.a.b[0].c
  if (!path.startsWith("$")) throw new Error(`json-path: must start with $: ${path}`);
  const parts = path.slice(1).split(/[.\[\]]+/).filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = /^\d+$/.test(p) ? cur[Number(p)] : cur[p];
  }
  return cur;
}

export function makeGenericCliAdapter(cfg = {}) {
  const cli = cfg.cli || {};
  const command = cli.command;
  if (!command) throw new Error("[skillopt:generic-cli] cli.command не задан в .skillopt.json");

  const argsTemplate = Array.isArray(cli.args) ? cli.args : [];
  const stdinTemplate = cli.stdin_template ?? "{{user}}";
  const outputParser = cli.output_parser ?? "raw";
  const outputPath = cli.output_path ?? null;
  const useStdinAlways = cli.use_stdin_always === true;
  const timeoutMs = cfg.timeout_ms ?? 300_000;
  const model = cfg.model ?? "";

  let validated = false;
  function ensure() {
    if (validated) return;
    if (!which(command)) {
      throw new Error(
        `[skillopt:generic-cli] CLI "${command}" не найден в PATH. ` +
          'Установите его, или измените cli.command в .skillopt.json.',
      );
    }
    validated = true;
  }

  return {
    name: "generic-cli",
    capabilities: { streaming: false, json_mode: outputParser === "json-path", max_context_tokens: cfg.max_context ?? 32_000 },

    async complete({ system, user }) {
      ensure();
      const vars = { model, system: system ?? "", user: user ?? "" };
      const stdinBlob = interpolate(stdinTemplate, vars);
      const args = argsTemplate.map((a) => interpolate(a, vars));

      const useStdin = useStdinAlways || Buffer.byteLength(stdinBlob, "utf8") > STDIN_THRESHOLD;

      return await new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
          stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let killed = false;
        const t = setTimeout(() => { killed = true; proc.kill("SIGTERM"); }, timeoutMs);

        proc.stdout.on("data", (b) => (stdout += b.toString()));
        proc.stderr.on("data", (b) => (stderr += b.toString()));
        proc.on("error", (e) => { clearTimeout(t); reject(e); });
        proc.on("close", (code) => {
          clearTimeout(t);
          if (killed) return reject(new Error(`[skillopt:generic-cli] timeout ${timeoutMs}ms`));
          if (code !== 0) {
            return reject(new Error(`[skillopt:generic-cli] exit ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`));
          }
          let text = stdout.trim();
          if (outputParser === "json-path" && outputPath) {
            try {
              const parsed = JSON.parse(text);
              const extracted = jsonPath(parsed, outputPath);
              text = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
            } catch (e) {
              return reject(new Error(`[skillopt:generic-cli] json-path parse failed: ${e.message}`));
            }
          }
          resolve({
            text,
            usage: { input_tokens: 0, output_tokens: 0 },
            raw: { stdout, stderr, command, args },
          });
        });

        if (useStdin) {
          proc.stdin.write(stdinBlob);
          proc.stdin.end();
        }
      });
    },
  };
}
