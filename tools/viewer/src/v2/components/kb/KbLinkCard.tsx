import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/v2/lib/utils";

type Props = { href?: string; title?: string; desc?: string; className?: string };

/**
 * KbLinkCard — карточка-CTA для follow-up навигации в конце раздела
 * (Starlight-стиль). Внутренние ссылки (/v2/...) идут через react-router,
 * внешние (http*) — обычный <a target="_blank">.
 *   <kb-linkcard href="/v2/plan" title="Дорожная карта" desc="…"></kb-linkcard>
 */
export function KbLinkCard({ href = "#", title = "", desc, className }: Props) {
  const isExternal = /^https?:\/\//.test(href);
  const content = (
    <>
      <div className="kb-linkcard-body">
        <span className="kb-linkcard-title">{title}</span>
        {desc ? <span className="kb-linkcard-desc">{desc}</span> : null}
      </div>
      <ArrowRight className="kb-linkcard-arrow" aria-hidden="true" />
    </>
  );

  if (isExternal) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn("kb-linkcard", className)}
        aria-label={`${title}${desc ? `. ${desc}` : ""}`}
      >
        {content}
      </a>
    );
  }
  return (
    <Link
      to={href}
      className={cn("kb-linkcard", className)}
      aria-label={`${title}${desc ? `. ${desc}` : ""}`}
    >
      {content}
    </Link>
  );
}
