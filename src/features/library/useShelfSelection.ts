import { useCallback, useEffect, useState } from "react";

import type { BookSummary } from "@/types/ipc";

interface ShelfSelectionOptions {
  /** The books currently on the shelf, in shelf order. */
  list: BookSummary[];
  /** Favourite flag for a batch of ids. */
  onFavorite: (ids: string[], favorite: boolean) => void;
  /** Delete a batch of ids. */
  onDelete: (ids: string[]) => void;
  /** Open the label sheet for a batch. */
  onRequestTags: (books: BookSummary[]) => void;
}

/**
 * Batch-manage mode for the shelf.
 *
 * Selection lives outside `BookCard` because the cards are windowed: only the
 * rows the viewport can reach are mounted, so a card cannot remember whether
 * it was picked — it would come back unselected on every scroll.
 */
export function useShelfSelection({
  list,
  onFavorite,
  onDelete,
  onRequestTags,
}: ShelfSelectionOptions) {
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);

  const exit = useCallback(() => {
    setManaging(false);
    setSelected(new Set());
    setDeleteOpen(false);
  }, []);

  /**
   * Escape leaves batch-manage mode.
   *
   * It has to be a key handler rather than a click target, because the shelf
   * is the mode's own selection surface and any layer that catches a click
   * "outside" catches clicks on the books too. A keyboard user still needs a
   * way out that is not the bar's 完成 button.
   *
   * Suppressed while the delete confirmation is up, so Escape there closes
   * the dialog rather than the mode behind it.
   */
  useEffect(() => {
    if (!managing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || deleteOpen) return;
      exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managing, deleteOpen, exit]);

  const toggle = (book: BookSummary) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });

  const allSelected = list.length > 0 && list.every((b) => selected.has(b.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((b) => b.id)));

  return {
    managing,
    begin: () => setManaging(true),
    exit,
    count: selected.size,
    selected,
    toggle,
    allSelected,
    toggleAll,
    /** Labels the whole selection: the sheet only ever adds in this mode. */
    requestTags: () => onRequestTags(list.filter((book) => selected.has(book.id))),
    favorite: (favorite: boolean) => onFavorite([...selected], favorite),
    deleteOpen,
    openDelete: () => setDeleteOpen(true),
    closeDelete: () => setDeleteOpen(false),
    confirmDelete: () => {
      onDelete([...selected]);
      setSelected(new Set());
      setDeleteOpen(false);
    },
  };
}

export type ShelfSelection = ReturnType<typeof useShelfSelection>;
