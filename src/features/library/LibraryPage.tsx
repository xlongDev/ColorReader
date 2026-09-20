import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Upload } from "@phosphor-icons/react";

import { OverlayPortal } from "@/components/glass/overlay";
import { ContinueReadingCard } from "@/features/library/ContinueReadingCard";
import { ImportSummary } from "@/features/library/ImportSummary";
import { pickFiles } from "@/features/library/importFiles";
import { ShelfBatchBar } from "@/features/library/ShelfBatchBar";
import { ShelfGrid } from "@/features/library/ShelfGrid";
import { ShelfHeader } from "@/features/library/ShelfHeader";
import { ShelfToolbar } from "@/features/library/ShelfToolbar";
import { TagBar } from "@/features/library/TagBar";
import { DeleteBookDialog } from "@/features/library/BookCard";
import { pickContinueReading, sortOptions, titleForFilter } from "@/features/library/format";
import { shelfSections, type ShelfGroup } from "@/features/library/group";
import { batchNeedsPassword } from "@/features/library/pack";
import { buildBookQuery, type LibraryFilter } from "@/features/library/shelfQuery";
import { useShelfSelection } from "@/features/library/useShelfSelection";
import { useDragDropImport } from "@/hooks/useDragDropImport";
import { useShelfWindow } from "@/hooks/useShelfWindow";
import { useAssignTags, useTags } from "@/hooks/useTags";
import {
  useBooks,
  useDeleteBook,
  useExportPack,
  useImportBooks,
  useImportProgress,
  useLibraryStats,
  usePdfCovers,
  useSetFavorite,
  useUpdateBook,
} from "@/hooks/useLibrary";
import { DURATION, useMotion } from "@/lib/motion";
import { isDesktopRuntime } from "@/lib/ipc";
import { useBookHandoff } from "@/stores/book-handoff";
import { useSettings } from "@/stores/settings";
import type { BookQuery, BookSummary, ImportOutcome, LibrarySort } from "@/types/ipc";

// Dialog chunks load on first open; local disk, so no spinner is needed.
const ExportPackDialog = lazy(() =>
  import("@/features/library/PackDialog").then((m) => ({ default: m.ExportPackDialog })),
);
const PackPasswordDialog = lazy(() =>
  import("@/features/library/PackDialog").then((m) => ({ default: m.PackPasswordDialog })),
);
const SourceDialog = lazy(() =>
  import("@/features/source/SourceDialog").then((m) => ({ default: m.SourceDialog })),
);
const TagDialog = lazy(() =>
  import("@/features/library/TagDialog").then((m) => ({ default: m.TagDialog })),
);
const ClippingsDialog = lazy(() =>
  import("@/features/library/ClippingsDialog").then((m) => ({ default: m.ClippingsDialog })),
);
const BookMetaDialog = lazy(() =>
  import("@/features/library/BookMetaDialog").then((m) => ({ default: m.BookMetaDialog })),
);

/**
 * Where the shelf was left, per filter.
 *
 * The router is a memory router, so the browser's own scroll restoration never
 * applies, and this list is unmounted on every trip into the reader — without
 * this the reader comes back to the top of a shelf they had scrolled halfway
 * down, which also means the cover flying home has no tile to land on. Module
 * scope rather than a store: it is a number per view, and it should not survive
 * a reload.
 */
const shelfScroll = new Map<LibraryFilter, number>();

/** One shared empty list, so the books keep their identity while the query is
 *  still loading — a fresh `[]` per render is a new dependency everywhere it
 *  is used. */
const NO_BOOKS: BookSummary[] = [];

/**
 * The shelf. Owns the scroll position and the ways a book arrives or leaves;
 * the chrome it is made of lives in its own modules.
 */
export function LibraryPage({ filter }: { filter: LibraryFilter }) {
  const navigate = useNavigate();
  const meta = titleForFilter(filter);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** The card grid. Owned here and handed to `useShelfWindow`, which measures
   *  it: a ref returned by a hook cannot be told apart from the data beside it. */
  const gridRef = useRef<HTMLDivElement>(null);
  // Before paint, or the reader sees the top of the shelf for a frame and then
  // a jump. The place is remembered as it is scrolled rather than on unmount:
  // the route transition keeps the outgoing shelf mounted until its exit
  // animation ends, so a save in the cleanup lands *after* the incoming shelf
  // has already restored — which is exactly nothing.
  const remember = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller) shelfScroll.set(filter, scroller.scrollTop);
  }, [filter]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = shelfScroll.get(filter) ?? 0;
    // Not saved in the cleanup. The outgoing shelf outlives the incoming one —
    // the route keeps it for the length of its exit animation — and by then
    // `popLayout` has taken it out of flow, so the position it reports is a
    // pixel off. Written there it would overwrite the value the incoming shelf
    // has already restored, and the next visit would land a pixel away.
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [filter, remember]);

  /**
   * Real input on the shelf ends a cover that is still in the air.
   *
   * A flight is aimed once (`useLandingBox`) and lands on the slot its tile had
   * when it left. A scroll under it therefore ends with the cover hopping from
   * the slot it landed on to wherever its tile actually went — measured: a 60px
   * scroll left the flight at y=347 and its tile at y=288, and the cover image
   * jumped those 59px the instant the handoff ended. Dropping the handoff at the
   * gesture moves that discontinuity to the moment the reader started moving the
   * shelf: the content under the cover is moving anyway, and the cover is back on
   * its own tile in the same frame.
   *
   * Driven by input events rather than by `scroll`, because the shelf restores
   * its own scroll position as it mounts — and that fires `scroll` too, which
   * would cancel every flight home at birth.
   *
   * Only a flight *coming home* (`side === "reader"`): on the way out the cover
   * is heading for the reader's header, which is not moving, and its tile is on
   * a page that is already on its way out — cancelling there would jump the
   * cover back to a slot that is disappearing.
   */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const drop = () => {
      const handoff = useBookHandoff.getState();
      if (handoff.id !== null && handoff.side === "reader") handoff.end();
    };
    scroller.addEventListener("wheel", drop, { passive: true });
    scroller.addEventListener("pointerdown", drop);
    return () => {
      scroller.removeEventListener("wheel", drop);
      scroller.removeEventListener("pointerdown", drop);
    };
  }, []);

  /** Leaving for the reader: the place is saved here, synchronously, because a
   *  scroll listener only reports the last position it was told about. */
  const openBook = useCallback(
    (target: BookSummary) => {
      remember();
      navigate(`/reader?book=${target.id}`);
    },
    [navigate, remember],
  );

  const [now, setNow] = useState(() => new Date());
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recentlyAdded");
  /** True while the shelf reads the backend's order backwards. Kept as the
   *  flip rather than as a direction because every order arrives in its own
   *  one — 最近添加 is already descending, 书名 already ascending — and a
   *  stored "descending" would have to be recomputed whenever the order
   *  changed. Reversing the array gives all seven both directions for free,
   *  with no second `ORDER BY` per option. */
  const [reversed, setReversed] = useState(false);
  /** The piles the shelf is shown in, if any; see `group.ts` for the
   *  dimensions. Kept beside the order rather than in the settings store: like
   *  the order, it is how this visit is reading the shelf, not a preference. */
  const [group, setGroup] = useState<ShelfGroup>("none");
  /** The piles whose cards are folded away, by section key. Beside the grouping
   *  rather than in the settings store, for the same reason: which piles a
   *  reader has folded shut is how this visit is reading the shelf.
   *
   *  Not cleared when the grouping changes: keys from another dimension simply
   *  match nothing, and coming back to this one finds the piles as they were. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleSection = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const defaultDesc = sortOptions.find((option) => option.value === sort)?.desc ?? false;
  const descending = defaultDesc !== reversed;
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<BookSummary | null>(null);
  const [lockedBatch, setLockedBatch] = useState<string[] | null>(null);
  const [lastOutcomes, setLastOutcomes] = useState<ImportOutcome[] | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The import-clippings sheet; a file picker plus a preview lives inside. */
  const [clippingsOpen, setClippingsOpen] = useState(false);
  /** True when the import button was clicked in the browser, which has no backend. */
  const [webNotice, setWebNotice] = useState(false);
  /** Tag shelf: the tag being shown, `null` for the whole shelf. */
  const [tag, setTag] = useState<string | null>(null);
  /** Books the label sheet is open for; one book = edit, several = add. */
  const [tagTarget, setTagTarget] = useState<BookSummary[] | null>(null);
  /** The book whose metadata sheet is open; one book at a time, since a title
   *  is not something a multi-selection could share. */
  const [metaTarget, setMetaTarget] = useState<BookSummary | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const query: BookQuery = useMemo(
    () => buildBookQuery(filter, sort, search, tag),
    [filter, sort, search, tag],
  );

  const books = useBooks(query);
  const stats = useLibraryStats();
  const tags = useTags();
  const assignTags = useAssignTags();
  const importBooks = useImportBooks();
  const exportPack = useExportPack();
  const deleteBook = useDeleteBook();
  const setFavorite = useSetFavorite();
  const updateBook = useUpdateBook();
  const progress = useImportProgress();
  usePdfCovers(books.data ?? []);

  const list = useMemo(
    () => (reversed ? (books.data ?? NO_BOOKS).toReversed() : (books.data ?? NO_BOOKS)),
    [books.data, reversed],
  );
  /**
   * The shelf as piles.
   *
   * `cards` is the same books in a different order — every dimension is
   * exclusive, so nothing is counted twice and the grid keeps rendering one
   * card per book, keyed by book id. `sections` is where each pile begins, and
   * that is what the window cuts the list into lines with: a heading takes a
   * line of its own and the cards of a pile are cut *within* it, so a pile
   * always starts on a fresh line.
   *
   * The order is chosen first (`list`) and grouping reorders the piles, never
   * the books inside them — the two controls answer different questions.
   */
  const { cards, sections } = useMemo(() => shelfSections(list, group), [list, group]);
  const shelfLayout = useSettings((s) => s.shelfLayout);
  const setShelfLayout = useSettings((s) => s.setShelfLayout);
  const continueReading = filter === "all" ? pickContinueReading(list) : undefined;

  /**
   * Only the lines the viewport can reach are rendered (see `useShelfWindow`);
   * the rest of the list is held open by the two spacers in `ShelfGrid`.
   *
   * Declared *here*, after the scroll restore above: the window has to be
   * measured from the restored position. Effects run in the order they are
   * written, and a window measured before the restore would be the top of the
   * list — which is where the cover flying home would then fail to find a tile.
   *
   * The grouping is *not* part of the content key: folding a pile changes what
   * is drawn but not which books are on the shelf, so nothing should replay its
   * entrance over it.
   */
  const shelf = useShelfWindow(
    scrollerRef,
    gridRef,
    sections,
    cards.length,
    collapsed,
    `${filter}|${sort}|${reversed}|${group}|${search}|${tag ?? ""}`,
    shelfScroll.get(filter) ?? 0,
    shelfLayout,
  );
  /**
   * The label line is part of every tile in a list that has labels anywhere, so
   * that rows keep one height — the window's arithmetic has no way to know that
   * the fourth card of a row is a line taller than its neighbours. Taken over
   * the whole list rather than the window, because a window that scrolls into
   * tagged books would otherwise change the row height under the reader.
   */
  const tagRow = useMemo(() => cards.some((book) => book.tags.length > 0), [cards]);

  const selection = useShelfSelection({
    list: cards,
    onFavorite: (ids, favorite) => {
      for (const id of ids) setFavorite.mutate({ id, favorite });
    },
    onDelete: (ids) => {
      for (const id of ids) deleteBook.mutate(id);
    },
    onRequestTags: setTagTarget,
  });

  // Native dialog picks and window drops both funnel into the same mutation.
  // An encrypted pack cannot be opened without a password, so the batch is
  // held back until one is supplied rather than failing the file.
  const importPaths = (paths: string[], password?: string) => {
    if (paths.length === 0) return;
    if (password === undefined && batchNeedsPassword(paths)) {
      setLockedBatch(paths);
      return;
    }
    setLockedBatch(null);
    importBooks.mutate({ paths, password }, { onSuccess: (outcomes) => setLastOutcomes(outcomes) });
  };

  // Tauri intercepts native drops and reports absolute file paths.
  const dragging = useDragDropImport((paths) => importPaths(paths));

  // The browser build has no Rust backend: picking files would silently fail,
  // so the button surfaces an explanation instead of doing nothing.
  const startImport = () => {
    if (!isDesktopRuntime) {
      setWebNotice(true);
      return;
    }
    void pickFiles().then(importPaths);
  };

  const m = useMotion();
  const picking = importBooks.isPending;

  return (
    <div className="flex h-full flex-col">
      <ShelfHeader
        filter={filter}
        meta={meta}
        now={now}
        importing={picking}
        webNotice={webNotice}
        onDismissNotice={() => setWebNotice(false)}
        onClippings={() => setClippingsOpen(true)}
        onSource={() => setSourceOpen(true)}
        onImport={startImport}
      />

      <div
        ref={scrollerRef}
        data-shelf-scroller
        className="flex-1 overflow-y-auto px-8 pb-8 [overflow-anchor:none]"
      >
        {filter === "all" && <ContinueReadingCard book={continueReading} onOpen={openBook} />}

        {filter === "tags" && <TagBar tags={tags.data ?? []} selected={tag} onSelect={setTag} />}

        <ShelfToolbar
          search={search}
          onSearch={setSearch}
          sort={sort}
          onSort={setSort}
          descending={descending}
          onDescending={(next) => setReversed(next !== defaultDesc)}
          group={group}
          onGroup={setGroup}
          layout={shelfLayout}
          onLayout={setShelfLayout}
          managing={selection.managing}
          onToggleManaging={() => (selection.managing ? selection.exit() : selection.begin())}
          stats={stats.data}
        />

        {/* The headings live inside the grid, as lines of it — see
            `ShelfGrid`. This used to be a sticky bar floating over the top,
            which cost the window nothing but could only ever name one pile at
            a time: the boundary had to go past before the reader learned what
            was under it. A heading in the flow shows the pile *and* where the
            next one starts, which is the thing a reader is actually looking
            for, and it was worth rewriting the window's arithmetic for. */}

        <ShelfGrid
          pending={books.isPending}
          error={books.error}
          search={search}
          list={cards}
          shelf={shelf}
          gridRef={gridRef}
          layout={shelfLayout}
          tagRow={tagRow}
          collapsed={collapsed}
          onToggleSection={toggleSection}
          managing={selection.managing}
          selected={selection.selected}
          busy={setFavorite.isPending || deleteBook.isPending}
          onToggleSelect={selection.toggle}
          onOpen={openBook}
          onToggleFavorite={(target) =>
            setFavorite.mutate({ id: target.id, favorite: !target.favorite })
          }
          onAskDelete={setDeleteTarget}
          onAskExport={setExportTarget}
          onEditTags={(target) => setTagTarget([target])}
          onEditMeta={setMetaTarget}
          onImport={startImport}
        />
      </div>

      <ShelfBatchBar
        anchorRef={scrollerRef}
        selection={selection}
        busy={{ favorite: setFavorite.isPending, delete: deleteBook.isPending }}
      />

      {sourceOpen && (
        <Suspense fallback={null}>
          <SourceDialog open onClose={() => setSourceOpen(false)} />
        </Suspense>
      )}

      {clippingsOpen && (
        <Suspense fallback={null}>
          {/* Unmounted when closed: the sheet holds a picked path and a preview
              report, and reopening it should start from an empty picker. */}
          <ClippingsDialog open onClose={() => setClippingsOpen(false)} />
        </Suspense>
      )}

      {dragging && (
        <OverlayPortal>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: m.reduce ? 0 : DURATION.base }}
            className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/30"
          >
            <motion.div
              initial={{ opacity: 0, scale: m.reduce ? 1 : 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={m.panel}
              className="glass-2 shadow-panel text-text-1 flex items-center gap-3 rounded-2xl px-6 py-5"
            >
              <Upload size={20} weight="duotone" />
              <span className="text-sm font-medium">松开手指即可导入</span>
            </motion.div>
          </motion.div>
        </OverlayPortal>
      )}

      {picking && progress && (
        <OverlayPortal>
          <motion.div
            initial={{ opacity: 0, y: m.reduce ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={m.panel}
            className="glass-2 shadow-panel text-text-1 fixed right-6 bottom-6 z-40 flex items-center gap-3 rounded-2xl px-5 py-4"
          >
            <Upload size={16} className="text-accent" />
            <span className="text-sm">
              正在导入 {progress.done}/{progress.total}
            </span>
          </motion.div>
        </OverlayPortal>
      )}

      {lastOutcomes && (
        <ImportSummary outcomes={lastOutcomes} onClose={() => setLastOutcomes(null)} />
      )}

      {lockedBatch && (
        <PackPasswordDialog
          count={lockedBatch.length}
          busy={importBooks.isPending}
          onCancel={() => setLockedBatch(null)}
          onConfirm={(password) => importPaths(lockedBatch, password)}
        />
      )}

      {exportTarget && (
        <Suspense fallback={null}>
          <ExportPackDialog
            book={exportTarget}
            busy={exportPack.isPending}
            error={exportPack.error ? String(exportPack.error) : null}
            onCancel={() => {
              setExportTarget(null);
              exportPack.reset();
            }}
            onConfirm={({ book, path, password }) =>
              exportPack.mutate(
                { id: book.id, path, password },
                { onSuccess: () => setExportTarget(null) },
              )
            }
          />
        </Suspense>
      )}

      {tagTarget && (
        <Suspense fallback={null}>
          {/* Keyed by the target: reopening for another book must not inherit
              the previous book's chip selection. */}
          <TagDialog
            key={tagTarget.map((book) => book.id).join(",")}
            books={tagTarget}
            allTags={tags.data ?? []}
            busy={assignTags.isPending}
            onCancel={() => setTagTarget(null)}
            onSave={(change) =>
              assignTags.mutate(
                { ids: tagTarget.map((book) => book.id), ...change },
                { onSuccess: () => setTagTarget(null) },
              )
            }
          />
        </Suspense>
      )}

      {metaTarget && (
        <Suspense fallback={null}>
          <BookMetaDialog
            book={metaTarget}
            busy={updateBook.isPending}
            onCancel={() => {
              setMetaTarget(null);
              // A failed save left its error on the mutation; the next open must
              // not inherit it.
              updateBook.reset();
            }}
            onSave={(patch) =>
              updateBook.mutate(
                { id: metaTarget.id, patch },
                { onSuccess: () => setMetaTarget(null) },
              )
            }
          />
        </Suspense>
      )}

      <DeleteBookDialog
        book={deleteTarget}
        busy={deleteBook.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={(book) =>
          deleteBook.mutate(book.id, {
            onSuccess: () => setDeleteTarget(null),
          })
        }
      />
    </div>
  );
}
