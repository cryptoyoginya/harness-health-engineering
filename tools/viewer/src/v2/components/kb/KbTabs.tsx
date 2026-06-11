import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/v2/lib/utils";
import { tabsListVariants } from "@/v2/components/ui/tabs";

type TabsProps = {
  children: ReactNode;
  className?: string;
  /** Идентификатор группы — синхронизирует выбор через localStorage. */
  group?: string;
  defaultLabel?: string;
};

type TabProps = { label?: string; children?: ReactNode };

const STORAGE_PREFIX = "v2:kb-tabs:";

function readPersisted(group: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + group);
  } catch {
    return null;
  }
}

function writePersisted(group: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + group, value);
  } catch {
    // ignore (private mode / quota)
  }
}

/**
 * KbTabs — табы с localStorage-персистом по `group` (Fumadocs-стиль). Без `group`
 * работает как обычный Tabs.
 *   <kb-tabs group="example">
 *     <kb-tab label="V2">…</kb-tab>
 *     <kb-tab label="V3">…</kb-tab>
 *   </kb-tabs>
 */
export function KbTabs({ children, className, group, defaultLabel }: TabsProps) {
  const tabs = useMemo(
    () =>
      Children.toArray(children)
        .filter(isValidElement)
        .map((child, i) => {
          const props = (child.props ?? {}) as TabProps;
          const label = props.label ?? `Tab ${i + 1}`;
          return { value: label, label, content: props.children };
        }),
    [children],
  );

  const initial = useMemo(() => {
    if (group) {
      const stored = readPersisted(group);
      if (stored && tabs.some((t) => t.value === stored)) return stored;
    }
    if (defaultLabel && tabs.some((t) => t.value === defaultLabel)) return defaultLabel;
    return tabs[0]?.value ?? "";
  }, [group, defaultLabel, tabs]);

  const [value, setValue] = useState<string>(initial);

  useEffect(() => {
    if (!group) return;
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_PREFIX + group) return;
      if (typeof e.newValue !== "string") return;
      if (tabs.some((t) => t.value === e.newValue)) setValue(e.newValue);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [group, tabs]);

  useEffect(() => {
    if (!group) return;
    const eventName = `v2-kb-tabs:${group}`;
    function onSync(e: Event) {
      const ce = e as CustomEvent<string>;
      if (typeof ce.detail !== "string") return;
      if (tabs.some((t) => t.value === ce.detail)) setValue(ce.detail);
    }
    window.addEventListener(eventName, onSync as EventListener);
    return () => window.removeEventListener(eventName, onSync as EventListener);
  }, [group, tabs]);

  const onValueChange = useCallback(
    (v: string) => {
      setValue(v);
      if (group) {
        writePersisted(group, v);
        try {
          window.dispatchEvent(new CustomEvent(`v2-kb-tabs:${group}`, { detail: v }));
        } catch {
          // ignore
        }
      }
    },
    [group],
  );

  if (tabs.length === 0) return null;

  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      orientation="horizontal"
      className={cn("kb-tabs group/tabs flex flex-col gap-2", className)}
      data-slot="tabs"
      data-orientation="horizontal"
    >
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant="default"
        className={cn(tabsListVariants({ variant: "default" }))}
      >
        {tabs.map((t) => (
          <TabsPrimitive.Trigger
            key={t.value}
            value={t.value}
            data-slot="tabs-trigger"
            className={cn(
              "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
              "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
            )}
          >
            {t.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((t) => (
        <TabsPrimitive.Content
          key={t.value}
          value={t.value}
          data-slot="tabs-content"
          className="kb-tabs-content flex-1 outline-none"
        >
          {t.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}

/** Wrapper. Контент читает KbTabs из children-props. */
export function KbTab({ children }: TabProps) {
  return <>{children}</>;
}
