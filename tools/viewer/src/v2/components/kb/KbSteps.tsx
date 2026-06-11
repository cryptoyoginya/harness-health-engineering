import { Children, isValidElement, type ReactNode } from "react";
import { cn } from "@/v2/lib/utils";

type StepsProps = { children: ReactNode; className?: string };
type StepProps = { title?: string; children?: ReactNode; className?: string };

/**
 * KbSteps — вертикальный список нумерованных шагов в стиле Nextra/Starlight.
 * Markdown:
 *   <kb-steps>
 *     <kb-step title="Шаг 1">…</kb-step>
 *   </kb-steps>
 * Слева — круглый бейдж с цифрой, вниз тянется тонкая соединительная линия.
 */
export function KbSteps({ children, className }: StepsProps) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <ol className={cn("kb-steps", className)} role="list">
      {items.map((child, i) => {
        const props = (child.props ?? {}) as Record<string, unknown>;
        return (
          <li key={i} className="kb-step" data-index={i + 1}>
            <span className="kb-step-marker" aria-hidden="true">
              {i + 1}
            </span>
            <div className="kb-step-body">
              {typeof props.title === "string" && props.title.length > 0 ? (
                <h4 className="kb-step-title">{props.title}</h4>
              ) : null}
              <div className="kb-step-content">{props.children as ReactNode}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Wrapper — родитель KbSteps читает props и собирает <li> сам. */
export function KbStep({ title, children, className }: StepProps) {
  return (
    <div className={cn("kb-step-standalone", className)}>
      {title ? <h4 className="kb-step-title">{title}</h4> : null}
      <div className="kb-step-content">{children}</div>
    </div>
  );
}
