// SkillOpt.tsx — observability страница для SkillOpt-runs.
// Read-only: список runs + drill-down в трейсы и предложенные правки.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Activity, FileCheck2, AlertTriangle } from "lucide-react";

type RunEntry = {
  kind: string;
  run_id: string;
  started_at: string;
  adapter?: string;
  model?: string;
  cost_usd?: number;
  summary?: {
    total?: number;
    passed?: number;
    pass_rate?: number;
    by_skill?: Record<string, { total: number; passed: number }>;
  };
  results?: Array<{ skill: string; skipped?: boolean; error?: string; delta_pct?: number }>;
};

type TraceEntry = {
  case_id: string;
  skill: string;
  passed: boolean;
  score: number;
  latency_ms: number;
  error: string | null;
  output_preview: string | null;
};

type RunDetail = {
  runId: string;
  summary: { total: number; passed: number; pass_rate: number; tokens_in: number; tokens_out: number; cost_usd?: number };
  traces: TraceEntry[];
  proposals: string[];
};

export function SkillOpt() {
  const [runs, setRuns] = useState<RunEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);

  useEffect(() => {
    fetch("/api/skillopt/runs?limit=50")
      .then((r) => r.json())
      .then((d) => setRuns(d.runs ?? []))
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    fetch(`/api/skillopt/run/${encodeURIComponent(selected)}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch((e) => setErr(String(e)));
  }, [selected]);

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
        <Activity className="h-5 w-5" />
        SkillOpt — runs
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        История прогонов eval-кейсов и предложенных правок скиллов. Read-only — мутации через CLI:{" "}
        <code>pnpm skill rollout|reflect|apply</code>.
      </p>

      {err ? (
        <div className="mt-6 rounded-md border border-[var(--color-saldo-neg,#c43)] p-3 text-sm">
          {err}
        </div>
      ) : null}

      {runs && runs.length === 0 ? (
        <div className="mt-10 rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          Записей пока нет. Запустите: <code>pnpm skill rollout &lt;skill&gt;</code>.<br />
          Все runs пишутся в <code>.context/skillopt/runs.jsonl</code> + директорию <code>.context/skillopt/&lt;run-id&gt;/</code>.
        </div>
      ) : null}

      {runs && runs.length > 0 ? (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-6">
          {/* Список runs */}
          <ul className="divide-y divide-border rounded-md border border-border bg-card">
            {runs.map((r) => {
              const isActive = selected === r.run_id;
              const passPct = r.summary?.pass_rate != null ? Math.round(r.summary.pass_rate * 100) : null;
              return (
                <li key={r.run_id + r.started_at}>
                  <button
                    type="button"
                    onClick={() => setSelected(r.run_id)}
                    className={
                      "w-full px-4 py-3 text-left transition " +
                      (isActive ? "bg-muted" : "hover:bg-muted/50")
                    }
                  >
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="font-mono">{r.kind}</span>
                      <span>{r.started_at?.slice(0, 19)}</span>
                    </div>
                    <div className="mt-1 truncate text-xs font-mono">{r.run_id}</div>
                    <div className="mt-1 flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">{r.model ?? "—"}</span>
                      {passPct != null ? (
                        <span className={passPct === 100 ? "text-[var(--color-income,#10b981)]" : passPct >= 50 ? "" : "text-[var(--color-saldo-neg,#dc2626)]"}>
                          {passPct}%
                        </span>
                      ) : null}
                      {r.cost_usd ? <span className="text-muted-foreground">${Number(r.cost_usd).toFixed(4)}</span> : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Детали выбранного run'а */}
          <div className="min-h-[300px] rounded-md border border-border bg-card p-5">
            {!selected ? (
              <div className="text-sm text-muted-foreground">Выберите run слева для деталей.</div>
            ) : !detail ? (
              <div className="text-sm text-muted-foreground">загрузка…</div>
            ) : (
              <RunDetailView detail={detail} />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RunDetailView({ detail }: { detail: RunDetail }) {
  const { summary, traces, proposals, runId } = detail;
  const passPct = summary?.pass_rate != null ? Math.round(summary.pass_rate * 100) : 0;
  return (
    <div>
      <div className="text-xs font-mono text-muted-foreground">{runId}</div>
      <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
        <Stat label="Pass" value={`${summary.passed}/${summary.total}`} sub={`${passPct}%`} />
        <Stat label="Tokens" value={`${summary.tokens_in}+${summary.tokens_out}`} sub={summary.cost_usd ? `$${Number(summary.cost_usd).toFixed(4)}` : null} />
        <Stat label="Proposals" value={String(proposals.length)} sub={proposals.length ? proposals.join(", ") : null} />
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Traces ({traces.length})
      </h3>
      <ul className="divide-y divide-border">
        {traces.map((t) => (
          <li key={`${t.skill}__${t.case_id}`} className="py-2">
            <div className="flex items-center gap-3 text-sm">
              {t.passed ? (
                <FileCheck2 className="h-4 w-4 text-[var(--color-income,#10b981)] shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-[var(--color-saldo-neg,#dc2626)] shrink-0" />
              )}
              <span className="font-mono text-xs">{t.skill}</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{t.case_id}</span>
              <span className="ml-auto text-xs text-muted-foreground">
                {t.error ? "ERROR" : `score=${t.score?.toFixed?.(2) ?? "?"} · ${t.latency_ms}ms`}
              </span>
            </div>
            {t.error ? (
              <div className="mt-1 ml-7 text-xs text-[var(--color-saldo-neg,#dc2626)]">{t.error}</div>
            ) : t.output_preview ? (
              <div className="mt-1 ml-7 text-xs text-foreground/70 line-clamp-2">{t.output_preview}</div>
            ) : null}
          </li>
        ))}
      </ul>

      {proposals.length > 0 ? (
        <div className="mt-6 rounded-md border border-border bg-muted/30 p-3 text-xs">
          <div className="font-semibold mb-1">Применить proposals:</div>
          <code className="block">pnpm skill diff {runId}</code>
          <code className="block">pnpm skill apply {runId}</code>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground truncate">{sub}</div> : null}
    </div>
  );
}
