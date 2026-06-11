// OpenQuestions.tsx — специальная страница: рендерит 04_synthesis/open-questions.md
// + contradictions.md рядом. Удобно как «список того, что не дорешено».

import { useEffect, useState } from "react";
import { api, type DocFull } from "@/api";
import { MarkdownDoc } from "@/v2/components/MarkdownDoc";

export function OpenQuestions() {
  const [open, setOpen] = useState<DocFull | null>(null);
  const [contradictions, setContradictions] = useState<DocFull | null>(null);

  useEffect(() => {
    api.doc("04_synthesis/open-questions.md").then(setOpen).catch(() => setOpen(null));
    api
      .doc("04_synthesis/contradictions.md")
      .then(setContradictions)
      .catch(() => setContradictions(null));
  }, []);

  return (
    <div className="v2 mx-auto max-w-[1000px] px-6 py-10 space-y-12">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Открытые вопросы</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          /04_synthesis/open-questions.md — известные пробелы в KB
        </p>
        {open ? (
          <div className="mt-6">
            <MarkdownDoc source={open.body} showCopy={false} />
          </div>
        ) : (
          <div className="mt-6 text-sm text-muted-foreground">
            Файл не найден. Создайте <code>04_synthesis/open-questions.md</code>.
          </div>
        )}
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">Противоречия</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          /04_synthesis/contradictions.md — зафиксированные конфликты между источниками
        </p>
        {contradictions ? (
          <div className="mt-6">
            <MarkdownDoc source={contradictions.body} showCopy={false} />
          </div>
        ) : (
          <div className="mt-6 text-sm text-muted-foreground">
            Файл не найден. Создайте <code>04_synthesis/contradictions.md</code>.
          </div>
        )}
      </section>
    </div>
  );
}
