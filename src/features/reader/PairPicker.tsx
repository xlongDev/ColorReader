import { BookOpen, X } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { authorLine } from "@/features/library/format";
import { buildBookQuery } from "@/features/library/shelfQuery";
import { useBooks } from "@/hooks/useLibrary";
import { cn } from "@/lib/cn";
import { displayTitle } from "@/lib/title";
import type { BookSummary } from "@/types/ipc";

/**
 * Picks the companion book for 对照阅读.
 *
 * One list, one tap: the shelf is already loaded and cached by the time a
 * reader opens this, so there is nothing to fetch and nothing to filter —
 * the book they want is the one they were just looking at. A search field
 * would earn its keep on a thousand-book shelf; below that it is one more
 * thing to dismiss.
 *
 * ponytail: no filter input, no sort control — the shelf's own ordering
 * (最近) is what people open books from anyway. Add when the list gets long
 * enough that scrolling is the annoyance, not the exception.
 */
export function PairPicker({
  open,
  currentId,
  partnerId,
  onPick,
  onClose,
  onExitPair,
}: {
  open: boolean;
  /** The book being read; never offered as its own companion. */
  currentId: string | null;
  /** The book already paired, if any; offered again would be a no-op. */
  partnerId: string | null;
  onPick: (bookId: string) => void;
  onClose: () => void;
  /** Leaves the pair. Shown while a pair is open — the seam's ✕ is the other
   *  way out, and it is invisible until the pointer finds the middle of the
   *  seam, which is a fine affordance once known and a bad one to depend on. */
  onExitPair?: () => void;
}) {
  const booksQuery = useBooks(buildBookQuery("all", "recentlyRead", "", null));
  const books = (booksQuery.data ?? []).filter(
    (book) => book.id !== currentId && book.id !== partnerId,
  );

  return (
    <GlassDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="对照阅读"
      description="选一本书，与当前这本并排阅读。两本书各自记住阅读位置，互不打扰。"
      widthClass="w-[min(92vw,520px)]"
    >
      <div className="-mx-1 max-h-[50vh] overflow-y-auto px-1">
        {books.length === 0 ? (
          <p className="text-text-3 px-2 py-8 text-center text-sm">书库里还没有别的书</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {books.map((book) => (
              <li key={book.id}>
                <PairRow book={book} onPick={() => onPick(book.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {onExitPair && (
        <div className="border-hairline mt-3 flex items-center justify-between gap-3 border-t pt-3">
          <p className="text-text-3 text-xs">现在两本书并排阅读</p>
          <GlassButton variant="subtle" size="sm" onClick={onExitPair}>
            <X size={13} /> 退出对照阅读
          </GlassButton>
        </div>
      )}
    </GlassDialog>
  );
}

/** One candidate book: cover, title, and how far into it the reader is. */
function PairRow({ book, onPick }: { book: BookSummary; onPick: () => void }) {
  const progress = book.progress ?? 0;
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "focus-visible:focus-ring flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left",
        "hover:bg-surface-1 transition-colors",
      )}
    >
      <span className="glass flex h-11 w-8 shrink-0 items-center justify-center overflow-hidden rounded">
        {book.coverUrl ? (
          <img src={book.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <BookOpen size={16} weight="duotone" className="text-text-3" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-text-1 block truncate text-sm font-medium">
          {displayTitle(book.title)}
        </span>
        <span className="text-text-3 mt-0.5 block truncate text-xs">
          {authorLine(book) || "未知作者"}
          {` · ${book.format.toUpperCase()}`}
          {progress > 0 && ` · 已读 ${Math.round(progress * 100)}%`}
        </span>
      </span>
    </button>
  );
}
