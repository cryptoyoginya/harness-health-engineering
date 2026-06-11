// KbLayer.tsx — список документов в одном слое.

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { api, type TreeResponse, type DocMeta } from "@/api";

const LAYER_LABEL: Record<string, string> = {
  "00_context": "Контекст",
  "02_sources": "Source summaries",
  "03_wiki": "Wiki",
  "04_synthesis": "Synthesis",
  "05_decisions": "Decisions",
  "06_outputs": "Outputs",
};

export function KbLayer() {
  const { layer = "" } = useParams<{ layer: string }>();
  const [tree, setTree] = useState<TreeResponse | null>(null);

  useEffect(() => {
    api.tree().then(setTree);
  }, []);

  const docs: DocMeta[] = tree?.tree[layer] ?? [];

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-10">
      <Link to="/" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ChevronLeft className="h-3 w-3" /> На главную
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {LAYER_LABEL[layer] ?? layer}
        <span className="ml-3 text-sm font-normal text-muted-foreground">/{layer}/</span>
      </h1>

      {!tree ? <div className="mt-6 text-sm text-muted-foreground">загрузка…</div> : null}

      {tree ? (
        <ul className="mt-6 divide-y divide-border">
          {docs.map((d) => {
            const ageDays = Math.max(0, Math.floor((Date.now() - d.mtime) / 86_400_000));
            const type = typeof d.frontmatter.type === "string" ? d.frontmatter.type : null;
            return (
              <li key={d.path} className="flex items-baseline gap-3 py-2 text-sm">
                <Link to={`/doc/${d.path}`} className="flex-1 truncate hover:underline">
                  {d.title || d.name}
                </Link>
                {type ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                    {type}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">{ageDays}д</span>
              </li>
            );
          })}
          {docs.length === 0 ? (
            <li className="py-2 text-sm text-muted-foreground">_(пусто)_</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
