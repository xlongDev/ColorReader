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
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  CaretDown,
  CaretRight,
  FilePlus,
  Globe,
  Highlighter,
  MagnifyingGlass,
  Rows,
  Sparkle,
  SquaresFour,
  Star,
  Sun,
  Tag,
  Upload,
  X,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { GlassDialog, OverlayPortal } from "@/components/glass/overlay";
import { GlassInput } from "@/components/glass/input";
import { isDesktopRuntime } from "@/lib/ipc";
import { DURATION, EASE_OUT, SPRING, staggerDelay, useMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { boxOf, useBookHandoff } from "@/stores/book-handoff";
import { BookCard, DeleteBookDialog } from "@/features/library/BookCard";
import {
  failedMessage,
  pickContinueReading,
  sortOptions,
  summarizeOutcomes,
  titleForFilter,
} from "@/features/library/format";
import { batchNeedsPassword, PACK_EXTENSIONS } from "@/features/library/pack";
import { TagBar } from "@/features/library/TagBar";
import { useDragDropImport } from "@/hooks/useDragDropImport";
import { useShelfWindow } from "@/hooks/useShelfWindow";
import { useAssignTags, useTags } from "@/hooks/useTags";
import { useSettings } from "@/stores/settings";

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

import {
  useBooks,
  useDeleteBook,
  useExportPack,
  useImportBooks,
  useImportProgress,
  useLibraryStats,
  usePdfCovers,
  useSetFavorite,
} from "@/hooks/useLibrary";
import type { BookQuery, BookSummary, ImportOutcome, LibrarySort } from "@/types/ipc";

export type LibraryFilter = "all" | "recent" | "favorites" | "tags";

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

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

/** See `list`. */
const NO_BOOKS: BookSummary[] = [];

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
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<BookSummary | null>(null);
  const [lockedBatch, setLockedBatch] = useState<string[] | null>(null);
  const [lastOutcomes, setLastOutcomes] = useState<ImportOutcome[] | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The import-clippings sheet; a file picker plus a preview lives inside. */
  const [clippingsOpen, setClippingsOpen] = useState(false);
  /** True when the import button was clicked in the browser, which has no backend. */
  const [webNotice, setWebNotice] = useState(false);
  /** The batch bar's element, so the pane-centring effect above can place it
   *  without going through state. */
  const batchBarRef = useRef<HTMLDivElement>(null);
  /** Batch-manage mode: cards toggle selection instead of opening. */
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  /** Tag shelf: the tag being shown, `null` for the whole shelf. */
  const [tag, setTag] = useState<string | null>(null);
  /** Books the label sheet is open for; one book = edit, several = add. */
  const [tagTarget, setTagTarget] = useState<BookSummary[] | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * Where the batch bar belongs, horizontally.
   *
   * The bar is `position: fixed` in the shell's overlay host, and that host is
   * the window — so a plain `left: 50%` is the *window's* middle. The bar acts
   * on the shelf, which the sidebar pushes ~130px right of that middle
   * (measured at 1440 with the rail open: bar centre 720, pane centre 850),
   * and the bar read as misaligned by exactly that.
   *
   * So the placement is written as the pane's *gutters* — padding on a
   * full-width wrapper — rather than as a `left` on the bar itself. That is
   * not a style preference: an absolutely positioned box with a `left` and no
   * `right` is shrink-to-fit against the space between that `left` and the
   * viewport edge, so a bar told to sit at the pane's centre was silently
   * capped at (viewport − centre) wide. At 1280 that is 765px and the bar
   * needed 510, so nothing showed; at the ~1080 window in the bug report it is
   * ~416px, and every label in the bar wrapped to one character per line —
   * 已选 0 本 and 取消收藏 stacked vertically. Padding on a full-width wrapper
   * has no such ceiling, and `justify-center` inside it centres on the pane.
   *
   * Written straight onto the element instead of into state: the sidebar
   * animates its own width over ~340ms, so this tracks the spring frame by
   * frame, and a re-render per frame is the one thing the shelf's windowed
   * grid cannot afford.
   *
   * `scrollerRef.parentElement` is the page's own root, which is the pane's
   * content box — the pane carries no padding of its own.
   */
  useLayoutEffect(() => {
    if (!managing) return;
    const pane = scrollerRef.current?.parentElement;
    const bar = batchBarRef.current;
    if (!pane || !bar) return;
    const place = () => {
      const box = pane.getBoundingClientRect();
      bar.style.paddingLeft = `${box.left}px`;
      bar.style.paddingRight = `${window.innerWidth - box.right}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [managing]);

  const query: BookQuery = useMemo(
    () => ({
      filter: filter === "recent" || filter === "favorites" ? filter : "all",
      sort: filter === "recent" ? "recentlyRead" : sort,
      search: search.trim() || undefined,
      tag: filter === "tags" ? (tag ?? undefined) : undefined,
    }),
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
  const progress = useImportProgress();
  usePdfCovers(books.data ?? []);

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

  const m = useMotion();
  const reduce = useReducedMotion();
  const picking = importBooks.isPending;
  /** One shared empty list, so `list` keeps its identity while the books are
   *  still loading — a fresh `[]` per render is a new dependency everywhere it
   *  is used. */
  const list = books.data ?? NO_BOOKS;
  const shelfLayout = useSettings((s) => s.shelfLayout);
  const setShelfLayout = useSettings((s) => s.setShelfLayout);
  const continueReading = filter === "all" ? pickContinueReading(list) : undefined;

  /**
   * Only the cards the viewport can reach are rendered (see `useShelfWindow`);
   * the rest of the list is held open by the two spacers below.
   *
   * Declared *here*, after the scroll restore above: the window has to be
   * measured from the restored position. Effects run in the order they are
   * written, and a window measured before the restore would be the top of the
   * list — which is where the cover flying home would then fail to find a tile.
   */
  const shelf = useShelfWindow(
    scrollerRef,
    gridRef,
    list.length,
    `${filter}|${sort}|${search}|${tag ?? ""}`,
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
  const tagRow = useMemo(() => list.some((book) => book.tags.length > 0), [list]);

  const exitManaging = useCallback(() => {
    setManaging(false);
    setSelected(new Set());
    setBatchDeleteOpen(false);
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
      if (event.key !== "Escape" || batchDeleteOpen) return;
      exitManaging();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managing, batchDeleteOpen, exitManaging]);
  const toggleSelect = (book: BookSummary) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(book.id)) next.delete(book.id);
      else next.add(book.id);
      return next;
    });
  const allSelected = list.length > 0 && list.every((b) => selected.has(b.id));
  const toggleSelectAll = () =>
    setSelected(allSelected ? new Set() : new Set(list.map((b) => b.id)));
  const batchFavorite = (favorite: boolean) => {
    for (const id of selected) setFavorite.mutate({ id, favorite });
  };
  const confirmBatchDelete = () => {
    for (const id of selected) deleteBook.mutate(id);
    setSelected(new Set());
    setBatchDeleteOpen(false);
  };
  /** Labels the whole selection: the sheet only ever adds in this mode. */
  const openBatchTags = () => setTagTarget(list.filter((book) => selected.has(book.id)));

  // The browser build has no Rust backend: picking files would silently fail,
  // so the button surfaces an explanation instead of doing nothing.
  const startImport = () => {
    if (!isDesktopRuntime) {
      setWebNotice(true);
      return;
    }
    void pickFiles().then(importPaths);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-8 pt-8 pb-6">
        <p className="text-text-2 text-sm">{greeting(now)}</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          {/* 书库 / 最近 / 收藏 / 标签 are one page with four filters — the shell
              keeps them mounted (see `AppShell`), so changing filter has nowhere
              else to show itself. The heading steps out and the new one rises
              into its place, while the grid reflows underneath: the incoming
              cards glide, the outgoing ones shrink away.

              Only the heading moves. The buttons beside it are part of the same
              gesture but are pinned right by `justify-between` and must not be
              re-mounted out from under a click — which is also why `popLayout`
              (the leaving heading goes out of flow) is safe here. */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={filter}
              initial={{ opacity: 0, y: m.reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: m.reduce ? 0 : -8 }}
              transition={{ duration: m.reduce ? 0 : DURATION.fast, ease: EASE_OUT }}
            >
              <h1 className="text-text-1 text-2xl font-semibold tracking-tight">{meta.title}</h1>
              <p className="text-text-2 mt-1 text-sm">{meta.subtitle}</p>
            </motion.div>
          </AnimatePresence>
          <div className="flex items-center gap-2">
            <GlassButton size="md" onClick={() => setClippingsOpen(true)}>
              <Highlighter size={15} /> 导入摘录
            </GlassButton>
            <GlassButton size="md" onClick={() => setSourceOpen(true)}>
              <Globe size={15} /> 在线找书
            </GlassButton>
            <GlassButton variant="primary" size="md" disabled={picking} onClick={startImport}>
              <FilePlus size={15} /> 导入书籍
            </GlassButton>
          </div>
        </div>
        <AnimatePresence>
          {webNotice && (
            <motion.div
              initial={{ opacity: 0, y: m.reduce ? 0 : -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: m.reduce ? 0 : -6 }}
              transition={{ duration: m.reduce ? 0 : DURATION.base }}
              className="border-hairline glass-2 mt-4 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5"
            >
              <p className="text-text-2 text-sm">
                网页版仅用于界面预览，导入书籍需要下载桌面端应用（阅读数据保存在本机）。
              </p>
              <button
                type="button"
                aria-label="关闭提示"
                className="text-text-3 hover:text-text-1 shrink-0 transition-colors"
                onClick={() => setWebNotice(false)}
              >
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <div
        ref={scrollerRef}
        data-shelf-scroller
        className="flex-1 overflow-y-auto px-8 pb-8 [overflow-anchor:none]"
      >
        {filter === "all" && <ContinueReadingCard book={continueReading} onOpen={openBook} />}

        {filter === "tags" && <TagBar tags={tags.data ?? []} selected={tag} onSelect={setTag} />}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-64">
            <MagnifyingGlass
              size={14}
              className="text-text-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
            />
            <GlassInput
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索书名或作者"
              className="pr-8 pl-8"
              aria-label="搜索书名或作者"
            />
            {search && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => setSearch("")}
                className="text-text-3 hover:text-text-1 absolute top-1/2 right-2 -translate-y-1/2"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="border-hairline bg-surface-1 relative inline-flex h-9 items-center rounded-md border">
            <select
              aria-label="排序方式"
              value={sort}
              onChange={(event) => setSort(event.target.value as LibrarySort)}
              className="text-text-1 appearance-none bg-transparent pr-7 pl-3 text-sm outline-none [&>option]:text-black"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <CaretDown
              size={12}
              className="text-text-3 pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
            />
          </div>

          {/* Shelf layout: grid tiles (cover-on-top) or single-column rows.
              Same `layoutId` highlight as the sidebar's theme pill: one
              stadium springs between the two cells instead of each cell
              rendering its own background, so the choice reads as motion.

              The thumb's radius is derived from the track's rather than being
              a literal. The track is a stadium (36px tall, `--radius-md` 18px),
              so 1px of border and 4px of padding leave a 13px inner curve — and
              a thumb whose radius does not match it cuts across the curve the
              track has already turned away from. Measured with the old 7px
              literal, the thumb's corner sat 10.9px outside the track's outline
              and read as "the thumb is too big" even though it fitted inside
              with 2px to spare.

              The padding is 4px rather than the usual 2px for the same reason:
              at 2px the thumb is 32px in a 36px track, and a 13-16px radius on
              a near-square 36×32 cell renders as a circle — rounder than the
              track it sits in, which reads as *bigger*, not smaller. 26×36 is
              a stadium that is wider than it is tall, which is what a
              segmented thumb is supposed to look like. */}
          <div className="border-hairline bg-surface-1 relative inline-flex h-9 items-stretch rounded-md border p-1">
            {(
              [
                { value: "grid", icon: SquaresFour, label: "网格视图" },
                { value: "list", icon: Rows, label: "列表视图" },
              ] as const
            ).map((option) => {
              const active = shelfLayout === option.value;
              const Icon = option.icon;
              return (
                <button
                  key={option.value}
                  type="button"
                  title={option.label}
                  aria-label={option.label}
                  aria-pressed={active}
                  onClick={() => setShelfLayout(option.value)}
                  className={cn(
                    "focus-visible:focus-ring relative flex w-9 items-center justify-center rounded-[calc(var(--radius-md)-5px)] transition-colors",
                    active ? "text-text-1" : "text-text-3 hover:text-text-2",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="shelf-layout-pill"
                      className="bg-surface-3 shadow-glass absolute inset-0 rounded-[calc(var(--radius-md)-5px)]"
                      transition={reduce ? { duration: 0 } : SPRING.layout}
                    />
                  )}
                  <Icon size={14} weight={active ? "fill" : "regular"} className="relative" />
                </button>
              );
            })}
          </div>

          <GlassButton
            size="md"
            variant={managing ? "primary" : "subtle"}
            onClick={() => (managing ? exitManaging() : setManaging(true))}
          >
            <SquaresFour size={15} /> {managing ? "退出管理" : "批量管理"}
          </GlassButton>

          {stats.data && stats.data.total > 0 && !managing && (
            <p className="text-text-3 ml-auto text-xs">
              共 {stats.data.total} 本{stats.data.reading > 0 && ` · 在读 ${stats.data.reading}`}
              {stats.data.favorites > 0 && ` · 收藏 ${stats.data.favorites}`}
            </p>
          )}
        </div>

        {books.isPending ? (
          <ShelfSkeleton />
        ) : books.isError ? (
          <EmptyState
            className="min-h-[30vh]"
            icon={<BookOpen size={26} weight="duotone" />}
            title="书架暂时打不开"
            description={String(books.error)}
          />
        ) : list.length === 0 ? (
          <EmptyState
            className="min-h-[40vh]"
            icon={<BookOpen size={26} weight="duotone" />}
            title={search ? "没有找到匹配的书" : "书库还是空的"}
            description={
              search
                ? "换个关键词试试，搜索会同时匹配书名和作者。"
                : "把 EPUB、TXT 或 Markdown 文件拖进窗口，或者点击右上角的导入按钮。"
            }
            action={
              !search && (
                <GlassButton variant="primary" size="md" onClick={startImport}>
                  <Sparkle size={14} /> 导入书籍
                </GlassButton>
              )
            }
          />
        ) : (
          <>
            {/* The rows above the window, held open at exactly the height they
                would have taken: the two spacers and the grid add up to the full
                list's height, gap for gap. Empty boxes rather than padding on
                the scroller, so the scrollbar length never depends on which
                rows happen to be rendered. */}
            {shelf.top > 0 && <div style={{ height: shelf.top }} aria-hidden />}
            <div
              ref={gridRef}
              // The track list is pinned from the window's count as soon as
              // there is one, and pinning it is what makes a column change
              // animate (see `ShelfWindow.columns`). Left to `auto-fill` alone,
              // the tracks follow the pane the instant the sidebar moves — a
              // reflow with no DOM mutation for motion to snapshot around, so
              // the cards teleported into their new slots. Hence an inline
              // `style` and not only a class: this has to be a *render*.
              // `--shelf-track` keeps the pinned `repeat()` and the `auto-fill`
              // fallback (the class, used until the first measurement lands) on
              // one number.
              style={
                shelfLayout === "grid" && shelf.columns > 0
                  ? {
                      gridTemplateColumns: `repeat(${shelf.columns}, minmax(0, var(--shelf-track)))`,
                    }
                  : undefined
              }
              className={cn(
                shelfLayout === "grid"
                  ? // A fixed cover width, not `1fr` columns. `1fr` ties the
                    // cover to the pane, and the pane is 248px narrower with
                    // the sidebar open — so toggling the rail resized every
                    // cover on the shelf (measured at 1440: 165px open,
                    // 194px closed, a 17% swing on a gesture that is not
                    // about the books). With a fixed track the rail buys
                    // another *column* instead, and a cover is the same
                    // object in both states. The track is sized to the width
                    // the six-column shelf has at the default window, so the
                    // common case is untouched; the leftover at other widths
                    // is a right margin, which is what a shelf of fixed
                    // objects does.
                    "grid grid-cols-[repeat(auto-fill,minmax(0,var(--shelf-track)))] gap-x-5 gap-y-6"
                  : // List: a single column, tight row gap (the row itself pads
                    // itself). The list row already sizes its own cover + meta
                    // inside; only the gap between rows is the grid's job.
                    "grid grid-cols-1 gap-y-2",
              )}
            >
              {/* No `AnimatePresence` around the window. Its children set changes
                  on every scroll, and an exit animation is not something that can
                  be told apart from a filter change — so the removed tiles were
                  kept in the DOM for it (measured: one whole window's worth, back
                  in flow, which made the grid twice the height of the list it
                  stands for and pushed the scroll position around under the
                  reader). Tiles leaving the window therefore stop being rendered,
                  and what is left of the filter-change motion is the survivors'
                  FLIP below plus the arriving cards' stagger. */}
              {list.slice(shelf.start, shelf.end).map((book, index) => (
                <BookCard
                  key={book.id}
                  book={book}
                  // The stagger is a position in the *list* — the window's own
                  // order would restart it at every scroll.
                  delay={staggerDelay(shelf.start + index, m.stagger)}
                  entering={!shelf.sliding}
                  reserveTags={tagRow && shelfLayout === "grid"}
                  busy={setFavorite.isPending || deleteBook.isPending}
                  selecting={managing}
                  selected={selected.has(book.id)}
                  onToggleSelect={toggleSelect}
                  onOpen={openBook}
                  variant={shelfLayout}
                  onToggleFavorite={(target) =>
                    setFavorite.mutate({ id: target.id, favorite: !target.favorite })
                  }
                  onAskDelete={setDeleteTarget}
                  onAskExport={setExportTarget}
                  onEditTags={(target) => setTagTarget([target])}
                />
              ))}
            </div>
            {shelf.bottom > 0 && <div style={{ height: shelf.bottom }} aria-hidden />}
          </>
        )}
      </div>

      <OverlayPortal>
        {/* No scrim behind the bar.
            One used to sit here — a `fixed inset-0 z-30` button whose job was
            "click outside to exit". It also covered the shelf, and the shelf
            is the thing this mode is *for*: every click on a card landed on
            the scrim instead, so the mode exited and nothing was ever
            selected (measured in both engines: the topmost element at a
            card's centre was the scrim, not the card). A selection mode whose
            selection surface is behind a dismiss layer is not a mode.
            The way out is 完成, or Escape — see the key handler above.

            The wrapper is always mounted, with the bar itself inside
            `AnimatePresence`: the placement effect writes the pane's gutters
            onto it as padding, and a `fixed inset-x-0` box has no width
            ceiling for those gutters to run into. Empty it is zero-height and
            `pointer-events-none`, so it costs nothing between uses. */}
        <div
          ref={batchBarRef}
          className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center"
        >
          <AnimatePresence>
            {managing && (
              <motion.div
                initial={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                transition={m.panel}
                // Centred by the wrapper's flex, not by a `-translate-x-1/2`:
                // motion writes `transform` for the spring, and the half-width
                // nudge is only safe in a property it does not touch. The
                // `whitespace-nowrap` is the last line of defence — a label
                // that wrapped to one character per line is what this bug
                // looked like from the outside.
                className="glass-2 shadow-panel pointer-events-auto flex items-center gap-1.5 rounded-2xl p-2 pl-4 whitespace-nowrap"
                data-batch-bar
              >
                <span className="text-text-2 mr-1 text-sm whitespace-nowrap">
                  已选{" "}
                  <motion.span
                    key={selected.size}
                    initial={{ y: 8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={SPRING.tap}
                    className="text-text-1 inline-block font-semibold tabular-nums"
                  >
                    {selected.size}
                  </motion.span>{" "}
                  本
                </span>
                <GlassButton size="sm" variant="subtle" onClick={toggleSelectAll}>
                  {allSelected ? "取消全选" : "全选"}
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={selected.size === 0}
                  onClick={openBatchTags}
                >
                  <Tag size={13} /> 打标签
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={selected.size === 0 || setFavorite.isPending}
                  onClick={() => batchFavorite(true)}
                >
                  <Star size={13} /> 收藏
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={selected.size === 0 || setFavorite.isPending}
                  onClick={() => batchFavorite(false)}
                >
                  取消收藏
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={selected.size === 0 || deleteBook.isPending}
                  onClick={() => setBatchDeleteOpen(true)}
                >
                  删除
                </GlassButton>
                <GlassButton size="sm" variant="primary" onClick={exitManaging}>
                  完成
                </GlassButton>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </OverlayPortal>

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

      <GlassDialog
        open={batchDeleteOpen}
        onOpenChange={(next) => {
          if (!next) setBatchDeleteOpen(false);
        }}
        title={`删除选中的 ${selected.size} 本书？`}
        description="选中的书籍会从书库中移除，对应的书籍文件和封面也会一并删除，此操作无法撤销。"
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setBatchDeleteOpen(false)}
            disabled={deleteBook.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            onClick={confirmBatchDelete}
            disabled={deleteBook.isPending}
          >
            删除
          </GlassButton>
        </div>
      </GlassDialog>
    </div>
  );
}

function ShelfSkeleton() {
  return (
    // Mirrors the real tile's box (cover + two text lines) so the grid does not
    // jump when the books land, and announces itself once for screen readers.
    // The track must match the real grid's (see the shelf below) or the covers
    // shift sideways the moment the books arrive.
    <output
      aria-label="正在加载书架"
      className="grid grid-cols-[repeat(auto-fill,minmax(0,var(--shelf-track)))] gap-x-5 gap-y-6"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index}>
          <div className="skeleton aspect-[3/4] rounded-md" />
          <div className="skeleton mt-2 h-3.5 w-3/4 rounded-full" />
          <div className="skeleton mt-1.5 h-3 w-1/2 rounded-full" />
        </div>
      ))}
    </output>
  );
}

function ImportSummary({ outcomes, onClose }: { outcomes: ImportOutcome[]; onClose: () => void }) {
  const failures = outcomes.filter(
    (o): o is Extract<ImportOutcome, { kind: "failed" }> => o.kind === "failed",
  );
  return (
    <OverlayPortal>
      <div className="glass-2 shadow-panel fixed right-6 bottom-6 z-40 w-80 rounded-2xl p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-text-1 text-sm font-medium">{summarizeOutcomes(outcomes)}</p>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="text-text-3 hover:text-text-1"
          >
            <X size={13} />
          </button>
        </div>
        {failures.length > 0 && (
          <ul className="mt-2 space-y-1">
            {failures.slice(0, 3).map((outcome) => (
              <li key={outcome.path} className="text-text-3 text-xs break-all">
                {failedMessage(outcome)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </OverlayPortal>
  );
}

/**
 * The shelf's one always-on shortcut: the book you were last in, with the
 * cover you recognise it by.
 *
 * It used to be a sentence — "上次读到《…》的 18% 处" — with nothing to click.
 * Now it is the resume control: the reader already restores the saved fraction
 * when a book opens, so opening it is the whole feature.
 */
function ContinueReadingCard({
  book,
  onOpen,
}: {
  book: BookSummary | undefined;
  onOpen: (book: BookSummary) => void;
}) {
  const m = useMotion();
  const beginHandoff = useBookHandoff((s) => s.begin);
  const coverRef = useRef<HTMLSpanElement>(null);

  if (!book) {
    return (
      <section className="glass mb-6 rounded-2xl p-5">
        <div className="text-text-2 flex items-center gap-2">
          <Sun size={16} weight="duotone" />
          <h2 className="text-text-1 text-sm font-medium">继续阅读</h2>
        </div>
        <p className="text-text-2 mt-2 text-[13px]">
          当你打开一本新书时，最近阅读的位置会出现在这里。
        </p>
      </section>
    );
  }

  const percent = Math.round(Math.min(book.progress ?? 0, 1) * 100);
  return (
    <motion.button
      type="button"
      onClick={() => {
        const cover = coverRef.current;
        if (cover) {
          beginHandoff({ id: book.id, coverUrl: book.coverUrl, from: boxOf(cover), side: "shelf" });
        }
        onOpen(book);
      }}
      whileTap={m.reduce ? undefined : { scale: 0.995 }}
      transition={m.tap}
      className="glass focus-visible:focus-ring group mb-6 flex w-full items-center gap-4 rounded-2xl p-4 text-left"
    >
      {/* Cornered to the tile's ratio (18px on a 138px cover), like the reader
          header's thumbnail: this cover is the other origin of a flight, so a
          rounder corner here is a cover that changes shape on the way in. */}
      <span
        ref={coverRef}
        className="relative block h-16 w-12 shrink-0 overflow-hidden rounded-[6px]"
      >
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="bg-surface-1 text-text-3 flex h-full w-full items-center justify-center">
            <BookOpen size={18} weight="duotone" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-text-3 flex items-center gap-1.5 text-[11.5px]">
          <Sun size={12} weight="duotone" /> 继续阅读
        </span>
        <span className="text-text-1 mt-0.5 block truncate text-sm font-medium">{book.title}</span>
        <span className="mt-2 flex items-center gap-2">
          <span className="bg-hairline h-1 flex-1 overflow-hidden rounded-full">
            <span
              className="bg-accent block h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="text-text-3 shrink-0 text-[11.5px] tabular-nums">已读 {percent}%</span>
        </span>
      </span>
      <CaretRight
        size={14}
        className="text-text-3 group-hover:text-text-1 shrink-0 transition-colors"
      />
    </motion.button>
  );
}

/** Every extension `BookFormat::from_path` accepts; kept here so the dialog and
    the Rust side never drift apart. */
const BOOK_EXTENSIONS = [
  "epub",
  "pdf",
  "mobi",
  "azw",
  "azw3",
  "prc",
  "fb2",
  "cbz",
  "txt",
  "md",
  "markdown",
] as const;

/** Native open dialog, restricted to the formats the library understands. */
async function pickFiles(): Promise<string[]> {
  try {
    const picked = await open({
      multiple: true,
      title: "选择要导入的书籍",
      filters: [
        {
          name: "书籍与书档",
          extensions: [...BOOK_EXTENSIONS, ...PACK_EXTENSIONS],
        },
      ],
    });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    // Outside the Tauri shell there is no dialog; importing stays desktop-only.
    return [];
  }
}
