import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeRaw from "rehype-raw";
import {
  Check,
  Copy,
  Info,
  Lightbulb,
  AlertTriangle,
  CheckCircle2,
  Compass,
  OctagonAlert,
} from "lucide-react";
import { Button } from "@/v2/components/ui/button";
import { KbSteps, KbStep } from "@/v2/components/kb/KbSteps";
import { KbAccordion, KbAccordionItem } from "@/v2/components/kb/KbAccordion";
import { KbTabs, KbTab } from "@/v2/components/kb/KbTabs";
import { KbFileTree, KbFolder, KbFile } from "@/v2/components/kb/KbFileTree";
import { KbLinkCard } from "@/v2/components/kb/KbLinkCard";
import { cn } from "@/v2/lib/utils";

type Props = {
  source: string;
  className?: string;
  showCopy?: boolean;
};

type CalloutKind = "note" | "tip" | "warning" | "info" | "success" | "danger";

const calloutMeta: Record<
  CalloutKind,
  { label: string; icon: typeof Info; iconCls: string }
> = {
  note: { label: "Note", icon: Info, iconCls: "text-foreground/60" },
  tip: { label: "Tip", icon: Lightbulb, iconCls: "text-[var(--color-income)]" },
  warning: { label: "Warning", icon: AlertTriangle, iconCls: "text-[var(--color-warning)]" },
  info: { label: "Info", icon: Compass, iconCls: "text-[var(--color-balance)]" },
  success: { label: "Success", icon: CheckCircle2, iconCls: "text-[var(--color-income)]" },
  danger: { label: "Danger", icon: OctagonAlert, iconCls: "text-[var(--color-saldo-neg)]" },
};

const NUMBERED_H2_RE = /^\s*(\d{1,2})\s*[·.\-—–]\s+(.+)$/;

function isElementOnly(node: ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  return isValidElement(node);
}

function detectCallout(children: ReactNode): { kind: CalloutKind; rest: ReactNode[] } | null {
  const arr = Children.toArray(children).filter(isElementOnly);
  if (arr.length === 0) return null;
  const first = arr[0];
  if (!isValidElement(first)) return null;
  const inner = Children.toArray(
    (first.props as { children?: ReactNode }).children ?? [],
  ).filter(isElementOnly);
  if (inner.length === 0) return null;
  const head = inner[0];
  if (!isValidElement(head)) return null;
  const headProps = head.props as { children?: ReactNode };
  const headText = String(headProps.children ?? "")
    .trim()
    .toLowerCase();
  const map: Record<string, CalloutKind> = {
    note: "note",
    tip: "tip",
    warning: "warning",
    info: "info",
    success: "success",
    danger: "danger",
  };
  const kind = map[headText];
  if (!kind) return null;
  return { kind, rest: arr };
}

function extractText(children: ReactNode): string {
  const arr = Children.toArray(children);
  let out = "";
  for (const n of arr) {
    if (typeof n === "string") out += n;
    else if (isValidElement(n)) {
      out += extractText((n.props as { children?: ReactNode }).children ?? "");
    }
  }
  return out;
}

export function MarkdownDoc({ source, className, showCopy = true }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <div className={cn("space-y-3", className)}>
      {showCopy ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={copy}
            className="text-muted-foreground hover:text-foreground"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="ml-2 text-xs">{copied ? "Скопировано" : "Копировать страницу"}</span>
          </Button>
        </div>
      ) : null}
      <article>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeSlug, rehypeRaw]}
          components={{
            // Custom KB-теги. react-markdown с rehypeRaw пропускает unknown
            // элементы — здесь мы их перехватываем и рендерим React-компонентом.
            // Cast через unknown — тип Components не знает про dashed-имена.
            // Этап D3 — канонические KB-компоненты.
            "kb-steps": KbSteps as unknown as Components["div"],
            "kb-step": KbStep as unknown as Components["div"],
            "kb-accordion": KbAccordion as unknown as Components["div"],
            "kb-accordion-item": KbAccordionItem as unknown as Components["div"],
            "kb-tabs": KbTabs as unknown as Components["div"],
            "kb-tab": KbTab as unknown as Components["div"],
            "kb-tree": KbFileTree as unknown as Components["div"],
            "kb-folder": KbFolder as unknown as Components["div"],
            "kb-file": KbFile as unknown as Components["div"],
            "kb-linkcard": KbLinkCard as unknown as Components["div"],
            h1: ({ children, id }) => (
              <h1
                id={id}
                className="mt-12 mb-5 scroll-mt-20 text-4xl font-semibold tracking-tight first:mt-0"
              >
                {children}
              </h1>
            ),
            h2: ({ children, id }) => {
              const raw = extractText(children).trim();
              const m = NUMBERED_H2_RE.exec(raw);
              if (m) {
                const num = m[1].padStart(2, "0");
                const rest = m[2];
                return (
                  <h2
                    id={id}
                    data-toc-title={`${num} · ${rest}`}
                    className="mt-14 mb-5 scroll-mt-20 flex items-baseline gap-3 text-2xl font-semibold tracking-tight first:mt-0"
                  >
                    <span className="kb-numbered-chip" aria-hidden="true">
                      {num}
                    </span>
                    <span>{rest}</span>
                  </h2>
                );
              }
              return (
                <h2
                  id={id}
                  data-toc-title={raw}
                  className="mt-14 mb-5 scroll-mt-20 text-2xl font-semibold tracking-tight first:mt-0"
                >
                  {children}
                </h2>
              );
            },
            h3: ({ children, id }) => (
              <h3
                id={id}
                className="mt-10 mb-3 scroll-mt-20 text-xl font-semibold tracking-tight"
              >
                {children}
              </h3>
            ),
            h4: ({ children, id }) => (
              <h4
                id={id}
                className="mt-6 mb-2 scroll-mt-20 text-base font-semibold tracking-tight text-foreground"
              >
                {children}
              </h4>
            ),
            h5: ({ children, id }) => (
              <h5
                id={id}
                className="mt-5 mb-2 scroll-mt-20 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {children}
              </h5>
            ),
            h6: ({ children, id }) => (
              <h6
                id={id}
                className="mt-4 mb-1 scroll-mt-20 font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground"
              >
                {children}
              </h6>
            ),
            p: ({ children }) => (
              <p className="mt-6 first:mt-0 max-w-[75ch] text-base leading-7 text-foreground/90">
                {children}
              </p>
            ),
            aside: ({ children, className: cls }) => (
              <aside
                className={cn(
                  "my-3 rounded-md border border-border-soft bg-muted/30 px-3 py-2 text-[14px] leading-relaxed text-foreground/80",
                  cls,
                )}
              >
                {children}
              </aside>
            ),
            ul: ({ children, className: cls }) => (
              <ul
                className={cn(
                  "mt-6 first:mt-0 max-w-[75ch] space-y-2 text-base leading-7 text-foreground/90",
                  cls?.includes("contains-task-list") ? "list-none pl-0" : "list-disc pl-6",
                )}
              >
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="mt-6 first:mt-0 max-w-[75ch] list-decimal space-y-2 pl-6 text-base leading-7 text-foreground/90">
                {children}
              </ol>
            ),
            li: ({ children, className: cls }) => (
              <li
                className={cn(
                  "marker:text-muted-foreground",
                  cls?.includes("task-list-item") ? "flex items-start gap-2 [&>input]:mt-1.5" : "",
                )}
              >
                {children}
              </li>
            ),
            strong: ({ children }) => (
              <strong className="font-semibold text-foreground">{children}</strong>
            ),
            em: ({ children }) => <em className="italic text-foreground/90">{children}</em>,
            a: ({ href, children }) => (
              <a
                href={href}
                target={href?.startsWith("http") ? "_blank" : undefined}
                rel={href?.startsWith("http") ? "noreferrer" : undefined}
                className="text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-foreground"
              >
                {children}
              </a>
            ),
            code: ({ children, className: cls }) => {
              const isBlock = cls && /language-/.test(cls);
              if (isBlock) {
                return (
                  <code className="block font-mono text-[13px] leading-relaxed">{children}</code>
                );
              }
              return (
                <code className="rounded bg-muted px-[0.3rem] py-[0.15rem] font-mono text-[14px] text-foreground">
                  {children}
                </code>
              );
            },
            pre: ({ children }) => (
              <pre className="my-4 overflow-x-auto rounded-md border border-border-soft bg-muted/60 p-3 font-mono text-[13px] leading-relaxed">
                {children}
              </pre>
            ),
            blockquote: ({ children }) => {
              const callout = detectCallout(children);
              if (callout) {
                const meta = calloutMeta[callout.kind];
                const Icon = meta.icon;
                const arr = callout.rest;
                const firstP = arr[0];
                let firstPRest: ReactNode = null;
                if (isValidElement(firstP)) {
                  const inner = Children.toArray(
                    (firstP.props as { children?: ReactNode }).children ?? [],
                  );
                  // strong (index 0) + возможный <br/> + ведущий whitespace убираем
                  let i = 1;
                  while (i < inner.length) {
                    const n = inner[i];
                    if (typeof n === "string" && !n.trim()) {
                      i++;
                      continue;
                    }
                    if (
                      isValidElement(n) &&
                      (n.type === "br" || (typeof n.type === "string" && n.type === "br"))
                    ) {
                      i++;
                      continue;
                    }
                    break;
                  }
                  const dropped = inner.slice(i);
                  firstPRest = dropped.length ? (
                    <p className="my-0 max-w-[70ch] text-[15px] leading-7 text-foreground/90">
                      {dropped}
                    </p>
                  ) : null;
                }
                return (
                  <aside className="my-6 rounded-lg border border-border bg-muted/30 px-4 py-3">
                    <div className="flex items-start gap-3">
                      <Icon className={cn("mt-[0.15rem] h-4 w-4 shrink-0", meta.iconCls)} />
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/70">
                          {meta.label}
                        </div>
                        <div className="space-y-2 text-[15px] leading-7 text-foreground/90">
                          {firstPRest}
                          {arr.slice(1)}
                        </div>
                      </div>
                    </div>
                  </aside>
                );
              }
              return (
                <blockquote className="my-4 border-l-2 border-border pl-4 text-muted-foreground">
                  {children}
                </blockquote>
              );
            },
            hr: () => <hr className="my-8 border-border-soft" />,
            table: ({ children }) => (
              <div className="my-5 overflow-x-auto">
                <table className="w-full border-collapse text-[14px]">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="border-b border-border">{children}</thead>
            ),
            tbody: ({ children }) => <tbody>{children}</tbody>,
            tr: ({ children }) => (
              <tr className="border-b border-border-soft last:border-0">{children}</tr>
            ),
            th: ({ children }) => (
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">{children}</th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-2 align-top text-foreground/90">{children}</td>
            ),
            details: ({ children }) => (
              <details className="my-4 rounded-md border border-border-soft bg-muted/30 px-4 py-2 [&[open]>summary]:mb-2">
                {children}
              </details>
            ),
            summary: ({ children }) => (
              <summary className="cursor-pointer select-none py-1 text-[15px] font-medium text-foreground hover:text-foreground/80">
                {children}
              </summary>
            ),
            img: ({ src, alt }) => (
              <figure className="my-6">
                <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-border-soft bg-muted/40 text-xs text-muted-foreground">
                  {alt || src || "Изображение"}
                </div>
                {alt ? (
                  <figcaption className="mt-2 text-center text-xs text-muted-foreground">
                    {alt}
                  </figcaption>
                ) : null}
              </figure>
            ),
          } as Components}
        >
          {source}
        </ReactMarkdown>
      </article>
    </div>
  );
}
