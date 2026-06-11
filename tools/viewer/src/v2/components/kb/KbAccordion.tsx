import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "@/v2/lib/utils";

type AccordionProps = {
  children: ReactNode;
  className?: string;
  type?: "single" | "multiple";
};

type AccordionItemProps = {
  id?: string;
  title?: string;
  children?: ReactNode;
  className?: string;
};

/**
 * KbAccordion — раскрывающиеся секции с URL hash deep-link.
 *   <kb-accordion>
 *     <kb-accordion-item id="why-q38" title="Почему?">…</kb-accordion-item>
 *   </kb-accordion>
 */
export function KbAccordion({ children, className, type = "single" }: AccordionProps) {
  const items = useMemo(
    () =>
      Children.toArray(children)
        .filter(isValidElement)
        .map((child, i) => {
          const props = (child.props ?? {}) as AccordionItemProps;
          return {
            id: props.id ?? `acc-${i}`,
            title: props.title ?? "",
            children: props.children,
          };
        }),
    [children],
  );

  const [open, setOpen] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    function syncFromHash() {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) return;
      const match = items.find((it) => it.id === hash);
      if (!match) return;
      setOpen((prev) => {
        if (type === "single") return new Set([match.id]);
        if (prev.has(match.id)) return prev;
        const next = new Set(prev);
        next.add(match.id);
        return next;
      });
      requestAnimationFrame(() => {
        const el = document.getElementById(match.id);
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [items, type]);

  const toggle = useCallback(
    (id: string, nextOpen: boolean) => {
      setOpen((prev) => {
        if (type === "single") return nextOpen ? new Set([id]) : new Set();
        const next = new Set(prev);
        if (nextOpen) next.add(id);
        else next.delete(id);
        return next;
      });
      if (nextOpen) {
        try {
          history.replaceState(null, "", `#${id}`);
        } catch {
          // ignore
        }
      }
    },
    [type],
  );

  return (
    <div className={cn("kb-accordion", className)} data-type={type}>
      {items.map((it) => (
        <KbAccordionItemView
          key={it.id}
          id={it.id}
          title={it.title}
          isOpen={open.has(it.id)}
          onOpenChange={(o) => toggle(it.id, o)}
        >
          {it.children}
        </KbAccordionItemView>
      ))}
    </div>
  );
}

function KbAccordionItemView({
  id,
  title,
  children,
  isOpen,
  onOpenChange,
}: {
  id: string;
  title: string;
  children?: ReactNode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const labelId = useId();
  return (
    <CollapsiblePrimitive.Root
      open={isOpen}
      onOpenChange={onOpenChange}
      className="kb-accordion-item"
      data-state={isOpen ? "open" : "closed"}
    >
      <div id={id} className="kb-accordion-anchor" aria-hidden="true" />
      <CollapsiblePrimitive.Trigger asChild>
        <button
          type="button"
          className="kb-accordion-trigger"
          aria-labelledby={labelId}
          data-state={isOpen ? "open" : "closed"}
        >
          <span id={labelId} className="kb-accordion-title">
            {title}
          </span>
          <ChevronDown
            className="kb-accordion-chevron"
            aria-hidden="true"
            data-state={isOpen ? "open" : "closed"}
          />
        </button>
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content className="kb-accordion-content" forceMount>
        <div className="kb-accordion-content-inner" hidden={!isOpen}>
          {children}
        </div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

/** Wrapper для типов; родитель KbAccordion сам рендерит KbAccordionItemView. */
export function KbAccordionItem({ title, children, className }: AccordionItemProps) {
  return (
    <div className={cn("kb-accordion-item-standalone", className)}>
      {title ? <h4 className="kb-accordion-title">{title}</h4> : null}
      <div>{children}</div>
    </div>
  );
}
