import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { BookmarkSimple, CaretRight, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { cn } from "@/lib/cn";
import type { PdfOutlineItem } from "@/lib/pdf";
import type { Bookmark, ChapterMeta } from "@/types/ipc";

import {
  currentTocRow,
  parentIndices,
  pathToCurrent,
  tocRows,
  tocTree,
  type TocNode,
  type TocRow,
} from "./toc";

/**
 * The table of contents with bookmarks stacked on top. Both sections jump:
 * a chapter lands at its top, a bookmark restores the exact fraction it saved.
 *
 * The list folds at every level, for every format. A PDF offers the document's
 * own outline; every other book offers its chapters, and a foliate-driven one
 * tags those with a nesting depth. `toc.ts` turns either into the same tree, so
 * the two paths only differ in what a row jumps to — the folding is shared.
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
  /** `depth` is optional: foliate-driven books supply a nested TOC. */
  chapters: (ChapterMeta & { depth?: number })[];
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
  const navRef = useRef<HTMLElement>(null);

  // Opening the drawer should land on where the reader already is — but it has
  // to be this panel's own scroller that moves, not `scrollIntoView`, which
  // walks *every* scrollable ancestor. The drawer is anchored inside the
  // reading viewport now, and while the sheet is still sliding in from the
  // right the current row counts as off-screen, so `scrollIntoView` scrolled
  // the reading area sideways to reach it and the whole panel lurched on open.
  // Measuring the row against the scroller touches nothing but the scroller,
  // and the subtraction cancels the entrance transform — it moves both rects
  // by the same amount.
  useEffect(() => {
    const nav = navRef.current;
    const row = currentRef.current;
    if (!nav || !row) return;
    const navRect = nav.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    nav.scrollTop += rowRect.top - navRect.top - (nav.clientHeight - rowRect.height) / 2;
  }, []);

  const rows = useMemo(() => tocRows(chapters, outline), [chapters, outline]);
  const current = useMemo(
    () => currentTocRow(rows, currentIdx, outline.length > 0),
    [rows, currentIdx, outline.length],
  );

  // Nested entries start collapsed; the only path opened initially is the one
  // leading to the entry being read. Re-seeded only when a different TOC
  // arrives (render-time adjust), never on page turns.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [seededFor, setSeededFor] = useState<TocRow[]>([]);
  if (seededFor !== rows) {
    setSeededFor(rows);
    setExpanded(pathToCurrent(rows, current));
  }

  const tree = useMemo(() => tocTree(rows), [rows]);
  const foldable = useMemo(() => parentIndices(tree), [tree]);
  const allOpen = foldable.length > 0 && foldable.every((index) => expanded.has(index));

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
        {foldable.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(allOpen ? new Set() : new Set(foldable))}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 cursor-pointer text-[11px] transition-colors"
          >
            {allOpen ? "收起全部" : "展开全部"}
          </button>
        )}
      </div>
      <nav ref={navRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="目录">
        <ul className="space-y-0.5">
          {tree.map((node) => (
            <TocBranch
              key={`${node.row.depth}:${node.row.target}:${node.row.title}`}
              node={node}
              current={current}
              expanded={expanded}
              currentRef={currentRef}
              onJump={onJump}
              onToggle={toggleNode}
            />
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** One row plus its folding children. The fold animates through a 0fr↔1fr grid
    track — height animation without measuring anything. A row with no children
    gets no toggle, so a flat chapter list never offers a chevron that would do
    nothing. */
function TocBranch({
  node,
  current,
  expanded,
  currentRef,
  onJump,
  onToggle,
}: {
  node: TocNode;
  current: number;
  expanded: Set<number>;
  currentRef: RefObject<HTMLButtonElement | null>;
  onJump: (target: number) => void;
  onToggle: (index: number) => void;
}) {
  const { row, index, children } = node;
  const atCurrent = index === current;
  const open = expanded.has(index);
  return (
    <li>
      <div className="flex items-center">
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? `折叠 ${row.title}` : `展开 ${row.title}`}
            aria-expanded={open}
            onClick={() => onToggle(index)}
            className="focus-visible:focus-ring text-text-3 hover:text-text-1 shrink-0 cursor-pointer p-1 transition-colors"
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
          ref={atCurrent ? currentRef : undefined}
          type="button"
          onClick={() => onJump(row.target)}
          style={{ paddingInlineStart: `${8 + row.depth * 14}px` }}
          className={cn(
            "focus-visible:focus-ring hover:bg-surface-1 text-text-2 hover:text-text-1 flex min-w-0 flex-1 items-baseline gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition-colors",
            atCurrent && "bg-accent-soft text-accent",
          )}
        >
          <span className="text-text-3 w-9 shrink-0 text-right text-[11px] tabular-nums">
            {row.marker}
          </span>
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
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
                <TocBranch
                  key={`${child.row.depth}:${child.row.target}:${child.row.title}`}
                  node={child}
                  current={current}
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
              "focus-visible:focus-ring hover:bg-surface-1 text-text-2 hover:text-text-1 min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
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
            className="focus-visible:focus-ring text-text-3 hover:text-danger shrink-0 p-1.5 transition-colors disabled:opacity-50"
          >
            <Trash size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}
