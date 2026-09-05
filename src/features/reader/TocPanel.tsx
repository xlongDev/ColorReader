import { useEffect, useRef } from "react";
import { BookmarkSimple, Trash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { cn } from "@/lib/cn";
import type { Bookmark, ChapterMeta } from "@/types/ipc";

/**
 * The table of contents with bookmarks stacked on top. Both sections jump:
 * a chapter lands at its top, a bookmark restores the exact fraction it saved.
 */
export function TocPanel({
  chapters,
  currentIdx,
  bookmarks,
  busy,
  onJump,
  onJumpBookmark,
  onDeleteBookmark,
  onAddBookmark,
}: {
  chapters: ChapterMeta[];
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

      <div className="border-hairline border-t px-4 pt-2.5 pb-1">
        <p className="text-text-3 text-[11px]">目录 · {chapters.length} 章</p>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="目录">
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
      </nav>
    </div>
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
