# Architecture

A technical description of Harness Health Engineering — how data flows, how retrieval works, and how
the control plane keeps the knowledge base honest.

## 1. Design principles

1. **Local-first, plain text.** The system of record is Markdown on disk. No proprietary store, no
   lock-in, fully `git`-versioned. The only network egress is the Whoop API pull.
2. **Evidence pyramid.** Raw signals are immutable; interpretation lives in higher layers and must
   cite the layer below. Facts, inferences, and decisions are never mixed unlabeled.
3. **Objective ∪ subjective.** Wearables see physiology; the human supplies mood/energy/social. Insight
   is generated at the seam — so both must land in the same daily record.
4. **One variable per experiment.** Changes to regimen/stack are run as time-boxed experiments with a
   success criterion, so synthesis can attribute effect.
5. **Hard medical boundary.** The agent never diagnoses; worrying signals route to a specialist.

## 2. Knowledge-base layers

```
00_context/    what this is, metrics (evals), medical boundary       [type: context]
01_raw/health/ daily logs — immutable evidence (whoop line = auto)   [no frontmatter]
02_sources/    weekly source notes with FACT/INFERENCE labels        [type: source-summary]
03_wiki/       baselines, supplement registry, activity taxonomy     [type: wiki]
04_synthesis/  weekly patterns, open questions, contradictions       [type: synthesis]
05_decisions/  decisions + experiments/ (one variable at a time)     [type: experiment]
06_outputs/    human-facing artifacts (plans, routines)              [type, version]
```

Each layer's required frontmatter is enforced at write time (see §5). Naming: daily logs
`YYYY-MM-DD.md`, weekly notes `YYYY-Www-*.md`, experiments `EXP-NNN-*.md`.

## 3. Whoop ingest pipeline

```
auth.mjs  ─ OAuth2 authorization-code flow (offline scope) → .whoop/token.json
sync.mjs  ─ getAccessToken() refreshes if expired
          ─ GET /developer/v2/recovery · /v2/cycle · /v2/activity/sleep
          ─ derives: recovery %, HRV (rmssd ms), resting HR, asleep duration, strain
          ─ rewrites ONLY the `whoop:` line in 01_raw/health/<today>.md
```

- `scripts/whoop/lib.mjs` is dependency-free (Node 22 global `fetch`, `crypto`, `fs`). A minimal
  `.env` parser avoids a `dotenv` dependency.
- Token refresh is transparent: any access token older than `expires_at − 60s` is silently renewed and
  persisted; a revoked refresh token fails loudly with a re-auth hint.
- The sync is **idempotent on the physiology line** and never touches hand-written subjective lines.

## 4. Retrieval — on-device hybrid RAG

```
index.mjs   incremental by mtime → chunks → e5-small embeddings → sqlite-vec + FTS5
search.mjs  query → (vector kNN) ∪ (BM25) → Reciprocal Rank Fusion → ranked passages
think.mjs   retrieve → compose prompt under AGENTS.md rules (labels + citations)
backlinks.mjs   reverse `related:` graph → blast radius before editing wiki/synthesis
mcp-server.mjs  exposes kb_search / kb_think / kb_backlinks over stdio MCP
```

- **Embeddings:** `multilingual-e5-small` ONNX, run locally via `transformers.js` (≈120 MB, cached
  under `scripts/semantic/.transformers-cache/`). No embedding API calls.
- **Stores:** `sqlite-vec` for dense vectors, SQLite **FTS5** for sparse BM25, both in one
  `.semantic-index.sqlite`.
- **Fusion:** Reciprocal Rank Fusion (RRF) merges dense and sparse rankings — robust without tuning
  weights.
- **MCP:** any MCP client (e.g. Claude Desktop) can query the KB live; the same server backs the agent.

## 5. Control plane

- **Hooks** (`.claude/settings.json`):
  - `SessionStart` → `session-start-context.mjs` injects current git/KB context.
  - `PreToolUse(Write|Edit)` → `check-decisions.mjs` (a decision card must carry a `DECISION:` label
    and a `[source: …]` citation) and `check-md-frontmatter.mjs` (layer-required frontmatter).
- **Permissions:** read-only scripts auto-allowed; mutating scripts, writes to immutable layers, and
  Whoop sync are `ask`; reading `.env` / `.whoop/` and force-push are `deny`.
- **Working memory:** `.remember/core.md` holds the semantic invariant (goal, hard rules) committed to
  git; session scratch files are gitignored.
- **Audits:** `kb-doctor.mjs` checks missing frontmatter, broken `related:`, orphans, stale synthesis,
  ghost index rows; `dream-cycle.mjs` produces a weekly LLM audit prompt.

## 6. Automation

A macOS `launchd` LaunchAgent (`com.health-harness.whoop-sync`) runs `sync.mjs` at 09:00 local time,
writing to `.whoop/sync.log`. Because it runs in the user session it inherits file access and the saved
OAuth token; missed runs (asleep machine) fire on wake. Linux/cron equivalent is documented in
`scripts/whoop/README.md`.

## 7. Stack summary

Node 22 · pnpm workspaces · `better-sqlite3` + `sqlite-vec` · `@huggingface/transformers` (ONNX) ·
Model Context Protocol · Claude Code hooks · Vite + React (viewer) · macOS launchd.

## 8. Extension points

- **More adapters:** mirror `scripts/whoop/` for Oura / Garmin / Apple Health → same `whoop:`-style
  line contract.
- **Live body MCP:** wrap the Whoop client as an MCP server for in-chat real-time queries.
- **Synthesis evals:** add `skills/*/evals/*.yaml` cases to regression-test the weekly synthesis.
