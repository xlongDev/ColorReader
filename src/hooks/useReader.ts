import { useMutation, useQuery } from "@tanstack/react-query";

import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { readPdfOutline, type PdfOutlineItem } from "@/lib/pdf";
import type { BookImage, ChapterContent, ChapterMeta } from "@/types/ipc";

/** A single book for the reader header. */
export function useBook(id: string | null) {
  return useQuery({
    queryKey: ["book", id],
    queryFn: () => {
      if (!id || !isDesktopRuntime) return Promise.resolve(null);
      return ipc.bookGet(id);
    },
    enabled: id !== null,
    staleTime: 30_000,
  });
}

/** Chapter metadata (no bodies) for a book. */
export function useReaderToc(bookId: string | null) {
  return useQuery({
    queryKey: ["reader", "toc", bookId],
    queryFn: () => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<ChapterMeta[]>([]);
      return ipc.readerToc(bookId);
    },
    enabled: bookId !== null,
    staleTime: 60_000,
  });
}

/** The body of one chapter. */
export function useChapter(bookId: string | null, idx: number | null) {
  return useQuery({
    queryKey: ["reader", "chapter", bookId, idx],
    queryFn: () => {
      if (!bookId || idx === null || !isDesktopRuntime) return Promise.resolve(null);
      return ipc.readerChapter(bookId, idx);
    },
    enabled: bookId !== null && idx !== null,
    staleTime: 60_000,
  });
}

/** Every image in the book, in reading order, for the lightbox browser. */
export function useBookImages(bookId: string | null) {
  return useQuery({
    queryKey: ["reader", "images", bookId],
    queryFn: () => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<BookImage[]>([]);
      return ipc.bookImages(bookId);
    },
    enabled: bookId !== null,
    staleTime: 60_000,
  });
}

/** The PDF's bookmark outline, empty when the document has none. Read by
    pdf.js (the same source readest uses), which resolves named destinations
    and encoded titles that a hand-rolled walker misses. Only queried for PDF
    books (`enabled`), where chapters are pages, not headings. */
export function usePdfOutline(bookId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["reader", "pdf-outline", bookId],
    queryFn: () => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve<PdfOutlineItem[]>([]);
      return readPdfOutline(bookId);
    },
    enabled: bookId !== null && enabled,
    staleTime: 60_000,
  });
}

/** Records a reading position. `location` is an opaque CFI for foliate books;
 *  leaving it out keeps whatever anchor is already stored. */
export function useSetProgress(bookId: string | null) {
  return useMutation({
    mutationFn: ({ progress, location }: { progress: number; location?: string }) => {
      if (!bookId || !isDesktopRuntime) return Promise.resolve();
      return ipc.readerSetProgress(bookId, progress, location);
    },
  });
}

export type { ChapterContent };
