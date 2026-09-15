import { useRef } from "react";
import { motion } from "motion/react";
import { BookOpen, Check, Export, Star, Tag, Trash } from "@phosphor-icons/react";

import { GlassDialog } from "@/components/glass/overlay";
import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { authorLine, formatFileSize } from "@/features/library/format";
import { cn } from "@/lib/cn";
import { SPRING, useMotion } from "@/lib/motion";
import { boxOf, useBookHandoff } from "@/stores/book-handoff";
import type { BookSummary } from "@/types/ipc";

interface BookCardProps {
  book: BookSummary;
  busy?: boolean;
  /** Entrance offset inside a staggered shelf; see `staggerDelay`. */
  delay?: number;
  onOpen: (book: BookSummary) => void;
  onToggleFavorite: (book: BookSummary) => void;
  onAskDelete: (book: BookSummary) => void;
  onAskExport: (book: BookSummary) => void;
  onEditTags: (book: BookSummary) => void;
  /** Batch-manage mode: clicks toggle selection instead of opening. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (book: BookSummary) => void;
}

/** One hover action on the cover: black glass, white icon — keyed to the cover
 *  art rather than the theme, so it holds on any cover in either palette. */
const coverAction =
  "h-6 w-6 rounded-full border-white/15 bg-black/45 text-white/90 backdrop-blur-[2px] " +
  "hover:bg-black/65 hover:text-white";

/** One shelf tile: cover, title, authors and quiet hover actions. */
export function BookCard({
  book,
  busy,
  delay = 0,
  onOpen,
  onToggleFavorite,
  onAskDelete,
  onAskExport,
  onEditTags,
  selecting = false,
  selected = false,
  onToggleSelect,
}: BookCardProps) {
  const authors = authorLine(book);
  const m = useMotion();
  const beginHandoff = useBookHandoff((s) => s.begin);
  const coverRef = useRef<HTMLSpanElement>(null);

  /** Hands the cover off to the reader's header before the route changes. */
  const open = () => {
    const cover = coverRef.current;
    if (cover) beginHandoff({ id: book.id, coverUrl: book.coverUrl, from: boxOf(cover) });
    onOpen(book);
  };

  return (
    // layout: shared-layout FLIP, so resorting or filtering the shelf glides
    // cards to their new slots instead of snapping the grid into place.
    <motion.div
      layout
      initial={{ opacity: 0, scale: m.reduce ? 1 : 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: m.reduce ? 1 : 0.94 }}
      transition={{ ...m.layout, delay }}
      whileTap={busy || m.reduce ? undefined : { scale: 0.985 }}
      className="group relative"
    >
      <button
        type="button"
        onClick={() => (selecting ? onToggleSelect?.(book) : open())}
        aria-pressed={selecting ? selected : undefined}
        className="focus-visible:focus-ring w-full rounded-md text-left disabled:opacity-50"
        disabled={busy}
      >
        {/* The cover carries the whole hover gesture — it rises, deepens its
            shadow and catches a band of light — while the title below stays
            put. The book lifts off the shelf; the label does not. */}
        <span
          ref={coverRef}
          className={cn(
            "glass relative block aspect-[3/4] overflow-hidden rounded-md",
            // Tailwind v4 moves `translate-y-*` with the `translate` property,
            // not `transform` — listing `transform` here would leave the lift
            // un-animated and snapping into place.
            "transition-[translate,box-shadow] duration-300 ease-out",
            "group-hover:-translate-y-1 group-hover:shadow-[var(--shadow-cover-lift)]",
            "motion-reduce:transition-none motion-reduce:group-hover:translate-y-0",
          )}
        >
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <span className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
              <BookOpen size={28} weight="duotone" />
            </span>
          )}
          {/* Light sweeping the gloss: one pass per hover, no pointer tracking,
              so a 200-book shelf stays cheap. */}
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 -translate-x-full",
              "bg-gradient-to-r from-transparent via-white/12 to-transparent",
              "transition-[translate] duration-700 ease-out group-hover:translate-x-full",
              "motion-reduce:hidden",
            )}
          />
          {book.progress > 0 && (
            <span className="absolute right-0 bottom-0 left-0 block h-1 bg-black/30">
              <span
                className="bg-accent block h-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${Math.round(Math.min(book.progress, 1) * 100)}%` }}
              />
            </span>
          )}
        </span>
        <p className="text-text-1 mt-2 truncate text-sm font-medium">{book.title}</p>
        <p className="text-text-3 mt-0.5 truncate text-xs">
          {authors || book.format.toUpperCase()}
          {book.fileSize > 0 && ` · ${formatFileSize(book.fileSize)}`}
        </p>
        {/* Only when there are labels: an untagged shelf keeps the two-line
            rhythm it had, and a tagged one gets a single extra line that
            truncates rather than reflowing the grid. */}
        {book.tags.length > 0 && (
          <p className="text-accent mt-1 truncate text-[11px]">
            {book.tags.map((tag) => `#${tag}`).join("  ")}
          </p>
        )}
      </button>

      {selecting ? (
        <span
          className={cn(
            "absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full border transition-colors",
            selected ? "border-accent bg-accent text-on-accent" : "border-hairline glass-solid",
          )}
        >
          <motion.span
            initial={false}
            animate={{ scale: selected ? 1 : 0.4, opacity: selected ? 1 : 0 }}
            transition={SPRING.tap}
            className="flex"
          >
            <Check size={13} weight="bold" />
          </motion.span>
        </span>
      ) : (
        <div
          className={cn(
            // grid-cols-4 across the cover's own width: the cells shrink with
            // the cover, so four actions fit a tile at any breakpoint instead
            // of riding out past the cover's edge (what a fixed-width pill
            // did on the 6-column shelf).
            "absolute inset-x-1.5 top-1.5 grid grid-cols-4 place-items-center gap-0.5",
            "translate-y-1 opacity-0 transition-all duration-200 ease-out",
            "group-hover:translate-y-0 group-hover:opacity-100",
            "focus-within:translate-y-0 focus-within:opacity-100",
            "motion-reduce:transition-none",
          )}
        >
          {/* The chips are inked against the cover (black glass, white icons)
              rather than against the theme: a shelf tile is always read
              against its cover art, never against the page behind it, so the
              same chip must hold on a white cover in day mode and a black one
              at night. Filled icons carry the "on" state — an accent colour
              would flip contrast between the themes. */}
          <GlassIconButton
            label={book.favorite ? "取消收藏" : "收藏"}
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(book);
            }}
            className={coverAction}
          >
            <Star size={13} weight={book.favorite ? "fill" : "regular"} />
          </GlassIconButton>
          <GlassIconButton
            label="标签"
            onClick={(event) => {
              event.stopPropagation();
              onEditTags(book);
            }}
            className={coverAction}
          >
            <Tag size={13} weight={book.tags.length > 0 ? "fill" : "regular"} />
          </GlassIconButton>
          <GlassIconButton
            label="导出书档"
            onClick={(event) => {
              event.stopPropagation();
              onAskExport(book);
            }}
            className={coverAction}
          >
            <Export size={13} />
          </GlassIconButton>
          <GlassIconButton
            label="删除"
            onClick={(event) => {
              event.stopPropagation();
              onAskDelete(book);
            }}
            className={cn(coverAction, "hover:bg-danger/70")}
          >
            <Trash size={13} />
          </GlassIconButton>
        </div>
      )}
    </motion.div>
  );
}

interface DeleteDialogProps {
  book: BookSummary | null;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (book: BookSummary) => void;
}

/** Confirmation for removing a book and its files from the shelf. */
export function DeleteBookDialog({ book, busy, onCancel, onConfirm }: DeleteDialogProps) {
  return (
    <GlassDialog
      open={book !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title="删除这本书？"
      description={`《${book?.title ?? ""}》会从书库中移除，对应的书籍文件和封面也会一并删除，此操作无法撤销。`}
      widthClass="w-[min(92vw,420px)]"
    >
      <div className="flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={onCancel} disabled={busy}>
          取消
        </GlassButton>
        <GlassButton
          variant="ghost"
          className="text-danger"
          onClick={() => book && onConfirm(book)}
          disabled={busy || !book}
        >
          删除
        </GlassButton>
      </div>
    </GlassDialog>
  );
}
