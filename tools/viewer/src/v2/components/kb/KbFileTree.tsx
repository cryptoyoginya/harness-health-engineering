import { Children, isValidElement, useState, type ReactNode } from "react";
import { ChevronRight, File as FileIcon, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/v2/lib/utils";

type TreeProps = { children: ReactNode; className?: string };
type FolderProps = {
  name?: string;
  open?: boolean | string;
  highlight?: boolean | string;
  children?: ReactNode;
};
type FileProps = { name?: string; highlight?: boolean | string };

/** rehypeRaw отдаёт boolean-атрибуты как "" — нормализуем. */
function attrTruthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") return v !== "false";
  return false;
}

/**
 * KbFileTree — дерево файлов/папок (Starlight-стиль).
 *   <kb-tree>
 *     <kb-folder name="07_phase3" open>
 *       <kb-file name="_manifest.yaml" highlight />
 *       <kb-folder name="research">
 *         <kb-file name="2026-05-12-architect.md" />
 *       </kb-folder>
 *     </kb-folder>
 *   </kb-tree>
 */
export function KbFileTree({ children, className }: TreeProps) {
  return (
    <ul className={cn("kb-tree", className)} role="tree">
      {renderEntries(children)}
    </ul>
  );
}

function renderEntries(children: ReactNode): ReactNode {
  return Children.toArray(children)
    .filter(isValidElement)
    .map((child, i) => {
      const props = (child.props ?? {}) as Record<string, unknown>;
      const tagName =
        typeof child.type === "string"
          ? child.type
          : (child.type as { displayName?: string; name?: string }).displayName ??
            (child.type as { name?: string }).name ??
            "";
      const isFolder = tagName === "kb-folder" || tagName === "KbFolder";
      if (isFolder) {
        return (
          <KbFolderNode
            key={i}
            name={String(props.name ?? "")}
            open={attrTruthy(props.open)}
            highlight={attrTruthy(props.highlight)}
          >
            {props.children as ReactNode}
          </KbFolderNode>
        );
      }
      return (
        <KbFileNode
          key={i}
          name={String(props.name ?? "")}
          highlight={attrTruthy(props.highlight)}
        />
      );
    });
}

function KbFolderNode({
  name,
  open: initialOpen,
  highlight,
  children,
}: {
  name: string;
  open: boolean;
  highlight: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(initialOpen);
  return (
    <li
      className="kb-tree-node kb-tree-folder"
      data-open={open ? "true" : "false"}
      data-highlight={highlight ? "true" : undefined}
      role="treeitem"
      aria-expanded={open}
    >
      <button
        type="button"
        className="kb-tree-row"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Папка ${name}, ${open ? "свернуть" : "развернуть"}`}
      >
        <ChevronRight
          className={cn("kb-tree-caret", open && "kb-tree-caret-open")}
          aria-hidden="true"
        />
        {open ? (
          <FolderOpen className="kb-tree-icon kb-tree-icon-folder" aria-hidden="true" />
        ) : (
          <Folder className="kb-tree-icon kb-tree-icon-folder" aria-hidden="true" />
        )}
        <span className="kb-tree-name">{name}</span>
      </button>
      {open ? (
        <ul className="kb-tree-children" role="group">
          {renderEntries(children)}
        </ul>
      ) : null}
    </li>
  );
}

function KbFileNode({ name, highlight }: { name: string; highlight: boolean }) {
  return (
    <li
      className="kb-tree-node kb-tree-file"
      data-highlight={highlight ? "true" : undefined}
      role="treeitem"
    >
      <div className="kb-tree-row kb-tree-row-file">
        <span className="kb-tree-caret kb-tree-caret-empty" aria-hidden="true" />
        <FileIcon className="kb-tree-icon kb-tree-icon-file" aria-hidden="true" />
        <span className="kb-tree-name">{name}</span>
      </div>
    </li>
  );
}

export function KbFolder({ name, open, highlight, children }: FolderProps) {
  return (
    <KbFolderNode
      name={String(name ?? "")}
      open={attrTruthy(open)}
      highlight={attrTruthy(highlight)}
    >
      {children}
    </KbFolderNode>
  );
}

export function KbFile({ name, highlight }: FileProps) {
  return <KbFileNode name={String(name ?? "")} highlight={attrTruthy(highlight)} />;
}
