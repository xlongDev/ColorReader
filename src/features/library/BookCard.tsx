import { BookOpen, Check, Export, Star, Trash } from "@phosphor-icons/react";

import { GlassDialog } from "@/components/glass/overlay";
import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { authorLine, formatFileSize } from "@/features/library/format";
import { cn } from "@/lib/cn";
import type { BookSummary } from "@/types/ipc";

interface BookCardProps {
  book: BookSummary;
  busy?: boolean;
  onOpen: (book: BookSummary) => void;
  onToggleFavorite: (book: BookSummary) => void;
  onAskDelete: (book: BookSummary) => void;
  onAskExport: (book: BookSummary) => void;
  /** Batch-manage mode: clicks toggle selection instead of opening. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (book: BookSummary) => void;
}

/** One shelf tile: cover, title, authors and quiet hover actions. */
export function BookCard({
  book,
  busy,
  onOpen,
  onToggleFavorite,
  onAskDelete,
  onAskExport,
  selecting = false,
  selected = false,
  onToggleSelect,
}: BookCardProps) {
  const authors = authorLine(book);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={() => (selecting ? onToggleSelect?.(book) : onOpen(book))}
        aria-pressed={selecting ? selected : undefined}
        className="w-full text-left disabled:opacity-50"
        disabled={busy}
      >
        <div className="glass relative aspect-[3/4] overflow-hidden rounded-md transition-transform group-hover:-translate-y-0.5">
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
              <BookOpen size={28} weight="duotone" />
            </div>
          )}
          {book.progress > 0 && (
            <div className="absolute right-0 bottom-0 left-0 h-1 bg-black/30">
              <div
                className="bg-accent h-full"
                style={{ width: `${Math.round(Math.min(book.progress, 1) * 100)}%` }}
              />
            </div>
          )}
        </div>
        <p className="text-text-1 mt-2 truncate text-sm font-medium">{book.title}</p>
        <p className="text-text-3 mt-0.5 truncate text-xs">
          {authors || book.format.toUpperCase()}
          {book.fileSize > 0 && ` · ${formatFileSize(book.fileSize)}`}
        </p>
      </button>

      {selecting ? (
        <span
          className={cn(
            "absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full border transition-colors",
            selected ? "border-accent bg-accent text-on-accent" : "border-hairline glass-solid",
          )}
        >
          <Check size={13} weight="bold" className={selected ? undefined : "opacity-0"} />
        </span>
      ) : (
        <div className="glass-solid absolute top-2 right-2 flex gap-1 rounded-full p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <GlassIconButton
            label={book.favorite ? "取消收藏" : "收藏"}
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onToggleFavorite(book);
            }}
          >
            <Star
              size={14}
              weight={book.favorite ? "fill" : "regular"}
              className={book.favorite ? "text-accent" : "text-text-2"}
            />
          </GlassIconButton>
          <GlassIconButton
            label="导出书档"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onAskExport(book);
            }}
          >
            <Export size={14} className="text-text-2" />
          </GlassIconButton>
          <GlassIconButton
            label="删除"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onAskDelete(book);
            }}
          >
            <Trash size={14} className="text-text-2" />
          </GlassIconButton>
        </div>
      )}
    </div>
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
