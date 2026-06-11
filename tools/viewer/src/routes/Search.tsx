// Search.tsx — страница поиска через /api/search (вызывает scripts/semantic/search.mjs).

import { useState } from "react";
import { Link } from "react-router-dom";
import { Search as SearchIcon } from "lucide-react";
import { api, type SearchResponse, type SearchResult } from "@/api";

export function Search() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"hybrid" | "vector" | "bm25">("hybrid");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const r: SearchResponse = await api.search(q, mode, 15);
      if ("error" in r) setError(r.error);
      else setResults(r.results);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Поиск по KB</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Hybrid retrieval: vector (multilingual-e5-small) + BM25 + RRF.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            placeholder="ваш запрос…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
        </div>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          className="rounded-md border border-border bg-background px-2 py-2 text-sm"
        >
          <option value="hybrid">hybrid</option>
          <option value="vector">vector</option>
          <option value="bm25">bm25</option>
        </select>
        <button
          type="submit"
          disabled={loading || !q.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {loading ? "…" : "Искать"}
        </button>
      </form>

      {error ? (
        <div className="mt-4 rounded-md border border-[var(--color-saldo-neg,#c43)] p-3 text-sm">
          {error}
          <div className="mt-1 text-xs text-muted-foreground">
            Проверьте, что построен индекс: <code>node scripts/semantic/index.mjs</code>.
          </div>
        </div>
      ) : null}

      {results ? (
        <ul className="mt-6 space-y-3">
          {results.map((r, i) => {
            const score = r.fused != null ? r.fused : r.similarity != null ? r.similarity : r.bm25_score;
            return (
              <li
                key={`${r.file}:${r.line}:${i}`}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <Link to={`/doc/${r.file}`} className="text-sm font-medium hover:underline">
                    {r.file}
                    <span className="ml-2 text-xs text-muted-foreground">:{r.line}</span>
                  </Link>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="font-mono">{r.layer}</span>
                    {score != null ? <span>score={score.toFixed(4)}</span> : null}
                  </div>
                </div>
                {r.heading ? (
                  <div className="mt-1 text-xs text-foreground/70">heading «{r.heading}»</div>
                ) : null}
                <p className="mt-2 line-clamp-3 text-[13px] text-foreground/80">{r.text}</p>
              </li>
            );
          })}
          {results.length === 0 ? (
            <li className="text-sm text-muted-foreground">Ничего не найдено.</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
