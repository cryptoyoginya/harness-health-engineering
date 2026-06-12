# Contributing

Thanks for being here. This is a body-as-codebase experiment that wants to generalize to every
self-quantifier. Contributions of all sizes are welcome.

## Good first contributions

- **Wearable adapters** — mirror `scripts/whoop/` for Oura, Garmin, Apple Health, Fitbit. Keep the
  same daily-log line contract so synthesis stays source-agnostic.
- **Live Whoop MCP server** — expose the body to the agent in real time, complementing the file sync.
- **Experiment templates & evals** — richer `05_decisions/experiments/` patterns; synthesis
  regression cases under `skills/*/evals/`.
- **Docs & translations** — the showcase is English; internal harness docs are Russian. Bridges help.

## Ground rules

1. **Local-first & private by default.** Never add code that ships personal health data anywhere but
   the user's own configured sinks. Secrets stay in `.env` / `.whoop/` (gitignored).
2. **Respect the medical boundary.** No feature may diagnose or interpret symptoms as conditions.
   Worrying signals route to a specialist.
3. **Keep the evidence pyramid honest.** Don't mix FACT / INFERENCE / DECISION without labels; cite the
   layer below. `pnpm kb:doctor` must pass (EXIT 0) before a PR.
4. **One concern per PR.** Like experiments — one variable at a time.

## Dev setup

```bash
corepack enable
pnpm run setup
pnpm kb:index
pnpm kb:doctor
```

## Workflow

Branch from `main`, keep commits scoped, run `pnpm kb:doctor`, open a PR describing *what changed and
how to verify it*. Issues for ideas and discussion are very welcome — including from anyone building
the future of human optimization. 👋
