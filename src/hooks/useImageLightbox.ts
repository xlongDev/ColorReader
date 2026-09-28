import { useCallback, useState } from "react";

import type { BookImage } from "@/types/ipc";

/**
 * The book's pictures, and which one the lightbox viewer is on.
 *
 * The viewer is addressed by **container path, not by position**, and that is
 * why this is one hook rather than two pieces of state. A position is only
 * meaningful against one list, and there are two: the book's own, which the
 * importer collects, and the one built from what has been clicked, for a row
 * written before the book's list existed. Keeping a position meant the click
 * computed it against one list while the viewer rendered the other, so clicking
 * the third picture opened the first. A path is also what survives the book's
 * list *arriving* — the query fills in after the first click — where an index
 * would silently point at whatever moved into its place.
 *
 * The two lists are kept apart rather than merged: `urls` only ever has entries
 * for pictures that arrived as blobs, and the viewer reads the URL back instead
 * of fetching.
 */

export interface ImageLightboxControls {
  /** The pictures the viewer walks, in the book's own order. */
  images: BookImage[];
  /** Blob URLs for pictures registered from a click, by container path. */
  urls: Record<string, string>;
  /** The picture the viewer is on, by path; `null` while it is closed. */
  path: string | null;
  /** Its position in `images`, or `null` when it is not in that list. */
  index: number | null;
  /** Opens the picture at `at` — a position in `images`. */
  openAt: (at: number) => void;
  /** Registers a picture the reader clicked in the book, and opens it. */
  openFromBook: (path: string, src?: string, section?: number) => void;
  /** Steps the viewer `delta` pictures through the book, staying inside it. */
  step: (delta: number) => void;
  close: () => void;
}

export function useImageLightbox(book: BookImage[] | undefined): ImageLightboxControls {
  const [path, setPath] = useState<string | null>(null);
  /** What the browser build registers as pictures are clicked: the entry path,
   *  the blob URL foliate made for it, and the section it lives in. The desktop
   *  build has `book_images`/`book_asset` behind it and never fills this in. */
  const [web, setWeb] = useState<{ list: BookImage[]; urls: Record<string, string> }>({
    list: [],
    urls: {},
  });

  // The importer's list wins whenever it has one: it is the book's own order,
  // and the list built from clicks only exists because the browser build has no
  // importer behind it.
  const images = book !== undefined && book.length > 0 ? book : web.list;

  /** Where `path` sits in the list the viewer renders — the only list its
   *  position can mean anything against. `-1` for a path that is not in it (a
   *  picture registered from a click before the book's list arrived, or one the
   *  importer skipped), which closes the viewer rather than showing somebody
   *  else's picture. */
  const index = path === null ? null : images.findIndex((image) => image.path === path);

  /** Opens the picture at `at` — a position in the same list the viewer
   *  renders, which is what the prose path's taps and the viewer's own arrows
   *  both hand over. */
  const openAt = useCallback((at: number) => setPath(images[at]?.path ?? null), [images]);

  /** Steps the viewer `delta` pictures through the book, staying inside it. */
  const step = useCallback(
    (delta: number) => {
      setPath((current) => {
        if (current === null) return null;
        const at = images.findIndex((image) => image.path === current);
        const next = images[Math.min(Math.max(at + delta, 0), images.length - 1)];
        return next?.path ?? current;
      });
    },
    [images],
  );

  /**
   * A picture clicked inside the book's own rendering. foliate reports the
   * archive entry it came from (see `FoliateBookView`), which is what the
   * book-wide list is keyed by — and, since the entry *is* what the viewer
   * holds, also what it opens on. An entry the importer skipped (rare: an image
   * used only by the book's own CSS) has no row here, and nothing opens rather
   * than the first picture opening in its place.
   */
  const openFromBook = useCallback(
    (clicked: string, src?: string, section?: number) => {
      // The browser branch runs first and returns. The URL foliate decoded for
      // this very picture is the one thing this side has that the book's own
      // list does not, so registering it is the whole branch: where the viewer
      // opens is `path`'s business, and the list it lands in is `images`'.
      if (src !== undefined) {
        setWeb((current) => {
          const known = current.list.some((image) => image.path === clicked);
          return {
            list: known
              ? current.list
              : [...current.list, { chapterIdx: section ?? 0, path: clicked }].toSorted(
                  (a, b) => a.chapterIdx - b.chapterIdx,
                ),
            urls: { ...current.urls, [clicked]: src },
          };
        });
        setPath(clicked);
        return;
      }
      const exact = images.findIndex((image) => image.path === clicked);
      // The importer stores the entry name as it appears in the container
      // while foliate decodes percent escapes before resolving, so a CJK or
      // spaced filename can arrive spelled the two ways. Same file, same
      // basename — only the encoding differs.
      const decoded = (value: string) => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const at =
        exact >= 0
          ? exact
          : images.findIndex(
              (image) =>
                image.path.slice(image.path.lastIndexOf("/") + 1) ===
                decoded(clicked).slice(clicked.lastIndexOf("/") + 1),
            );
      if (at >= 0) setPath(images[at]!.path);
    },
    [images],
  );

  /** Stable, because the reader's key handler puts it in its dependency list:
   *  a fresh identity there re-binds the listener on every render. */
  const close = useCallback(() => setPath(null), []);

  return { images, urls: web.urls, path, index, openAt, openFromBook, step, close };
}
