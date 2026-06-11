// Sidebar.tsx — data-driven навигация по дереву KB.
// Читает /api/tree, рендерит сворачиваемые группы по слоям, фильтр по подстроке.

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { api, type DocMeta, type TreeResponse } from "@/api";

const LAYER_LABEL: Record<string, string> = {
  "00_context": "Контекст",
  "01_raw": "Сырые источники",
  "02_sources": "Source summaries",
  "03_wiki": "Wiki",
  "04_synthesis": "Synthesis",
  "05_decisions": "Decisions",
  "06_outputs": "Outputs",
};

export function Sidebar() {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const loc = useLocation();

  useEffect(() => {
    api
      .tree()
      .then((t) => {
        setTree(t);
        // По умолчанию открываем все слои с непустым содержимым
        const initial: Record<string, boolean> = {};
        for (const layer of t.layers) initial[layer] = (t.tree[layer]?.length ?? 0) > 0;
        setOpen(initial);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    if (!tree) return null;
    if (!filter.trim()) return tree.tree;
    const q = filter.toLowerCase();
    const out: Record<string, DocMeta[]> = {};
    for (const [layer, docs] of Object.entries(tree.tree)) {
      out[layer] = docs.filter(
        (d) =>
          d.path.toLowerCase().includes(q) ||
          (d.title ?? "").toLowerCase().includes(q) ||
          d.name.toLowerCase().includes(q),
      );
    }
    return out;
  }, [tree, filter]);

  return (
    <aside className="w-72 shrink-0 border-r border-border bg-card/40 overflow-y-auto">
      <div className="sticky top-0 z-10 bg-card/95 backdrop-blur p-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="search"
            placeholder="Фильтр…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded-md border border-border bg-background pl-7 pr-2 py-1.5 text-sm outline-none focus:border-foreground/40"
          />
        </div>
      </div>

      {error ? (
        <div className="p-3 text-xs text-[var(--color-saldo-neg,#c43)]">{error}</div>
      ) : !tree || !filtered ? (
        <div className="p-3 text-xs text-muted-foreground">загрузка…</div>
      ) : (
        <nav className="px-2 py-2 text-sm">
          {tree.layers.map((layer) => {
            const docs = filtered[layer] || [];
            if (filter && docs.length === 0) return null;
            const isOpen = open[layer] ?? false;
            return (
              <div key={layer} className="mb-1">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [layer]: !isOpen }))}
                  className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs uppercase tracking-wider text-muted-foreground hover:bg-muted"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  <span>{LAYER_LABEL[layer] ?? layer}</span>
                  <span className="ml-auto text-[10px] font-normal opacity-60">{docs.length}</span>
                </button>
                {isOpen ? (
                  <ul className="mb-2 ml-3 mt-1 space-y-0.5">
                    {docs.map((d) => {
                      const href = `/doc/${d.path}`;
                      const active = loc.pathname === href;
                      const display = d.title || d.name.replace(/\.md$/i, "");
                      return (
                        <li key={d.path}>
                          <Link
                            to={href}
                            className={
                              "block rounded px-2 py-1 text-[13px] leading-snug truncate " +
                              (active
                                ? "bg-muted font-medium text-foreground"
                                : "text-foreground/80 hover:bg-muted/60 hover:text-foreground")
                            }
                            title={d.path}
                          >
                            {display}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </nav>
      )}
    </aside>
  );
}
