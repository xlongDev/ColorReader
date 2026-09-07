import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { BookmarkSimple, CaretRight, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { cn } from "@/lib/cn";
import type { PdfOutlineItem } from "@/lib/pdf";
import type { Bookmark, ChapterMeta } from "@/types/ipc";

/**
 * The table of contents with bookmarks stacked on top. Both sections jump:
 * a chapter lands at its top, a bookmark restores the exact fraction it saved.
 *
 * A PDF with bookmarks shows the document's own outline (indented by depth)
 * instead of the flat per-page chapter table; the current entry is whichever
 * outline target is the last one at or before the page being read.
 */
export function TocPanel({
  chapters,
  outline,
  currentIdx,
  bookmarks,
  busy,
  onJump,
  onJumpBookmark,
  onDeleteBookmark,
  onAddBookmark,
}: {
  chapters: ChapterMeta[];
  outline: PdfOutlineItem[];
  currentIdx: number;
  bookmarks: Bookmark[];
  busy: boolean;
  onJump: (idx: number) => void;
  onJumpBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (id: string) => void;
  onAddBookmark: () => void;
}) {
  const currentRef = useRef<HTMLButtonElement>(null);

  // Opening the drawer should land on where the reader already is.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "center" });
  }, []);

  const currentOutline = useMemo(() => {
    let active = -1;
    outline.forEach((item, index) => {
      if (item.page <= currentIdx) active = index;
    });
    return active;
  }, [outline, currentIdx]);

  // Nested outline entries start collapsed; the only path opened initially is
  // the one leading to the entry being read. Re-seeded only when a different
  // outline arrives (render-time adjust), never on page turns.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [seededFor, setSeededFor] = useState<typeof outline>([]);
  if (seededFor !== outline) {
    setSeededFor(outline);
    setExpanded(pathToCurrent(outline, currentOutline));
  }

  // Flat list → tree, so each level folds as one animated grid track.
  const tree = useMemo(() => {
    const roots: OutlineNode[] = [];
    const stack: OutlineNode[] = [];
    outline.forEach((item, index) => {
      const node: OutlineNode = { item, index, children: [] };
      while (stack.length > item.depth) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      stack.push(node);
    });
    return roots;
  }, [outline]);

  const parentIndices = useMemo(() => {
    const indices: number[] = [];
    const walk = (nodes: OutlineNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) indices.push(node.index);
        walk(node.children);
      }
    };
    walk(tree);
    return indices;
  }, [tree]);
  const allOpen = parentIndices.length > 0 && parentIndices.every((i) => expanded.has(i));

  const toggleNode = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline flex items-center justify-between border-b px-4 py-2.5">
        <p className="text-text-3 text-[11px]">书签</p>
        <GlassButton variant="subtle" size="sm" onClick={onAddBookmark} disabled={busy}>
          <BookmarkSimple size={13} /> 添加书签
        </GlassButton>
      </div>
      <BookmarkList
        bookmarks={bookmarks}
        busy={busy}
        currentIdx={currentIdx}
        onJump={onJumpBookmark}
        onDelete={onDeleteBookmark}
      />

      <div className="border-hairline flex items-center justify-between border-t px-4 pt-2.5 pb-1">
        <p className="text-text-3 text-[11px]">
          {outline.length > 0 ? `目录 · ${outline.length} 项` : `目录 · ${chapters.length} 章`}
        </p>
        {parentIndices.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(allOpen ? new Set() : new Set(parentIndices))}
            className="text-text-3 hover:text-text-1 cursor-pointer text-[11px] transition-colors"
          >
            {allOpen ? "收起全部" : "展开全部"}
          </button>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="目录">
        {outline.length > 0 ? (
          <ul className="space-y-0.5">
            {tree.map((node) => (
              <OutlineBranch
                key={`${node.item.depth}:${node.item.page}:${node.item.title}`}
                node={node}
                currentOutline={currentOutline}
                expanded={expanded}
                currentRef={currentRef}
                onJump={onJump}
                onToggle={toggleNode}
              />
            ))}
          </ul>
        ) : (
          <ul className="space-y-0.5">
            {chapters.map((chapter) => {
              const current = chapter.idx === currentIdx;
              return (
                <li key={chapter.idx}>
                  <button
                    ref={current ? currentRef : undefined}
                    type="button"
                    onClick={() => onJump(chapter.idx)}
                    className={cn(
                      "hover:bg-surface-1 text-text-2 hover:text-text-1 flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
                      current && "bg-accent-soft text-accent",
                    )}
                  >
                    <span className="text-text-3 w-9 shrink-0 text-right text-[11px] tabular-nums">
                      {chapter.idx + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {chapter.title || `第 ${chapter.idx + 1} 章`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}

/** Indices of `active`'s ancestor chain: the sections opened when the drawer
    first shows, so the entry being read is visible in a collapsed tree. */
function pathToCurrent(outline: PdfOutlineItem[], active: number): Set<number> {
  const path = new Set<number>();
  if (active < 0) return path;
  let target = active;
  for (let i = active; i >= 0; i--) {
    if (outline[i]!.depth < outline[target]!.depth) {
      path.add(i);
      target = i;
    }
  }
  return path;
}

interface OutlineNode {
  item: PdfOutlineItem;
  /** Position in the flat outline; the expanded set and current entry key on it. */
  index: number;
  children: OutlineNode[];
}

/** One outline row plus its folding children. The fold animates through a
    0fr↔1fr grid track — height animation without measuring anything. */
function OutlineBranch({
  node,
  currentOutline,
  expanded,
  currentRef,
  onJump,
  onToggle,
}: {
  node: OutlineNode;
  currentOutline: number;
  expanded: Set<number>;
  currentRef: RefObject<HTMLButtonElement | null>;
  onJump: (idx: number) => void;
  onToggle: (index: number) => void;
}) {
  const { item, index, children } = node;
  const current = index === currentOutline;
  const open = expanded.has(index);
  return (
    <li>
      <div className="flex items-center">
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? `折叠 ${item.title}` : `展开 ${item.title}`}
            aria-expanded={open}
            onClick={() => onToggle(index)}
            className="text-text-3 hover:text-text-1 shrink-0 cursor-pointer p-1 transition-colors"
          >
            <CaretRight
              size={10}
              className={cn("transition-transform duration-200 ease-out", open && "rotate-90")}
            />
          </button>
        ) : (
          <span className="w-[18px] shrink-0" aria-hidden />
        )}
        <button
          ref={current ? currentRef : undefined}
          type="button"
          onClick={() => onJump(item.page)}
          style={{ paddingInlineStart: `${8 + item.depth * 14}px` }}
          className={cn(
            "hover:bg-surface-1 text-text-2 hover:text-text-1 flex min-w-0 flex-1 items-baseline gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition-colors",
            current && "bg-accent-soft text-accent",
          )}
        >
          <span className="text-text-3 w-9 shrink-0 text-right text-[11px] tabular-nums">
            {item.page + 1}
          </span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
        </button>
      </div>
      {children.length > 0 && (
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
          style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
        >
          <div className="overflow-hidden">
            <ul className="space-y-0.5">
              {children.map((child) => (
                <OutlineBranch
                  key={`${child.item.depth}:${child.item.page}:${child.item.title}`}
                  node={child}
                  currentOutline={currentOutline}
                  expanded={expanded}
                  currentRef={currentRef}
                  onJump={onJump}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}

function BookmarkList({
  bookmarks,
  busy,
  currentIdx,
  onJump,
  onDelete,
}: {
  bookmarks: Bookmark[];
  busy: boolean;
  currentIdx: number;
  onJump: (bookmark: Bookmark) => void;
  onDelete: (id: string) => void;
}) {
  if (bookmarks.length === 0) {
    return (
      <p className="text-text-3 px-4 py-3 text-[12.5px] leading-relaxed">
        还没有书签。读到想记住的位置时，点「添加书签」把它钉在这里。
      </p>
    );
  }
  return (
    <ul className="max-h-56 shrink-0 space-y-0.5 overflow-y-auto px-3 py-2">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.id} className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => onJump(bookmark)}
            className={cn(
              "hover:bg-surface-1 text-text-2 hover:text-text-1 min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
              bookmark.chapterIdx === currentIdx && "text-accent",
            )}
          >
            <span className="block truncate">{bookmark.label}</span>
          </button>
          <button
            type="button"
            aria-label="删除书签"
            disabled={busy}
            onClick={() => onDelete(bookmark.id)}
            className="text-text-3 hover:text-danger shrink-0 p-1.5 transition-colors disabled:opacity-50"
          >
            <Trash size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}
