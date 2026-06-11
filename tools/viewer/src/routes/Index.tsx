// Index.tsx — главная: обзор KB по слоям, счётчики, последние изменения.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { api, type TreeResponse, type DocMeta } from "@/api";

const LAYER_LABEL: Record<string, string> = {
  "00_context": "Контекст",
  "02_sources": "Source summaries",
  "03_wiki": "Wiki",
  "04_synthesis": "Synthesis",
  "05_decisions": "Decisions",
  "06_outputs": "Outputs",
};

const LAYER_HINT: Record<string, string> = {
  "00_context": "Immutable контекст: что за проект, кто стейкхолдеры",
  "02_sources": "Короткие summary артефактов из 01_raw",
  "03_wiki": "Концепты, агрегированные из нескольких источников",
  "04_synthesis": "Интерпретация, гипотезы, open questions",
  "05_decisions": "Принятые решения с rationale",
  "06_outputs": "Финальные артефакты для людей",
};

export function Index() {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.tree().then(setTree).catch((e) => setErr(String(e)));
  }, []);

  const recent = useMemo(() => {
    if (!tree) return [] as DocMeta[];
    const all: DocMeta[] = [];
    for (const docs of Object.values(tree.tree)) all.push(...docs);
    return all.sort((a, b) => b.mtime - a.mtime).slice(0, 8);
  }, [tree]);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">База знаний проекта</h1>
      <p className="mt-2 max-w-[70ch] text-muted-foreground">
        Markdown-репозиторий с дисциплиной утверждений (см. AGENTS.md). Слева — структура по
        слоям, сверху — поиск и граф связей.
      </p>

      {err ? (
        <div className="mt-6 rounded-md border border-[var(--color-saldo-neg,#c43)] p-3 text-sm">
          {err}
          <div className="mt-2 text-xs text-muted-foreground">
            Сервер не отвечает. Запустите: <code>pnpm dev</code> в <code>tools/viewer/</code>.
          </div>
        </div>
      ) : null}

      {tree ? (
        <>
          <section className="mt-10">
            <h2 className="mb-4 text-base font-semibold uppercase tracking-wider text-muted-foreground">
              Слои
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tree.layers.map((layer) => {
                const docs = tree.tree[layer] || [];
                return (
                  <Link
                    key={layer}
                    to={`/layer/${layer}`}
                    className="group rounded-lg border border-border bg-card p-4 transition hover:border-foreground/40"
                  >
                    <div className="flex items-baseline justify-between">
                      <div className="text-sm font-semibold">{LAYER_LABEL[layer] ?? layer}</div>
                      <div className="text-xs text-muted-foreground">{docs.length}</div>
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      /{layer}/
                    </div>
                    <div className="mt-2 text-[13px] leading-snug text-foreground/80">
                      {LAYER_HINT[layer] ?? "—"}
                    </div>
                    <div className="mt-3 flex items-center text-xs text-foreground/70 group-hover:text-foreground">
                      Перейти <ArrowRight className="ml-1 h-3 w-3" />
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="mb-4 text-base font-semibold uppercase tracking-wider text-muted-foreground">
              Последние изменения
            </h2>
            <ul className="space-y-2">
              {recent.map((d) => {
                const ageDays = Math.max(0, Math.floor((Date.now() - d.mtime) / 86_400_000));
                return (
                  <li key={d.path} className="flex items-center gap-3 text-sm">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {d.layer}
                    </span>
                    <Link to={`/doc/${d.path}`} className="flex-1 truncate hover:text-foreground/80">
                      {d.title || d.name}
                    </Link>
                    <span className="text-xs text-muted-foreground">{ageDays}д назад</span>
                  </li>
                );
              })}
              {recent.length === 0 ? (
                <li className="text-sm text-muted-foreground">_(пока пусто)_</li>
              ) : null}
            </ul>
          </section>
        </>
      ) : !err ? (
        <div className="mt-6 text-sm text-muted-foreground">загрузка…</div>
      ) : null}
    </div>
  );
}
