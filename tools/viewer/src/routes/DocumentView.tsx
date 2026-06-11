// DocumentView.tsx — рендер любого .md по пути из URL.

import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { api, type DocFull } from "@/api";
import { MarkdownDoc } from "@/v2/components/MarkdownDoc";

export function DocumentView() {
  const params = useParams<{ "*": string }>();
  const path = params["*"] || "";
  const [doc, setDoc] = useState<DocFull | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setErr(null);
    if (!path) return;
    api.doc(path).then(setDoc).catch((e) => setErr(String(e)));
  }, [path]);

  return (
    <div className="v2 mx-auto max-w-[1100px] px-6 py-8">
      <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
        <Link to="/" className="flex items-center gap-1 hover:text-foreground">
          <ChevronLeft className="h-3 w-3" />
          На главную
        </Link>
        <span className="mx-1">/</span>
        <span className="font-mono">{path}</span>
      </div>

      {err ? <div className="text-sm">{err}</div> : null}
      {!doc && !err ? <div className="text-sm text-muted-foreground">загрузка…</div> : null}

      {doc ? (
        <article>
          <MarkdownDoc source={doc.body} />
          {doc.backlinks.length > 0 ? (
            <section className="mt-12 border-t border-border pt-6">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Кто ссылается ({doc.backlinks.length})
              </h3>
              <ul className="space-y-1 text-sm">
                {doc.backlinks.map((b) => (
                  <li key={b}>
                    <Link to={`/doc/${b}`} className="text-foreground/80 hover:text-foreground hover:underline">
                      {b}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}
