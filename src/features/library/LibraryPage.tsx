import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  CaretDown,
  CaretRight,
  FilePlus,
  Globe,
  Highlighter,
  MagnifyingGlass,
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
import { DURATION, SPRING, staggerDelay, useMotion } from "@/lib/motion";
import { BookCard, DeleteBookDialog } from "@/features/library/BookCard";
import {
  failedMessage,
  sortOptions,
  summarizeOutcomes,
  titleForFilter,
} from "@/features/library/format";
import { batchNeedsPassword, PACK_EXTENSIONS } from "@/features/library/pack";
import { TagBar } from "@/features/library/TagBar";
import { useDragDropImport } from "@/hooks/useDragDropImport";
import { useAssignTags, useTags } from "@/hooks/useTags";

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

export function LibraryPage({ filter }: { filter: LibraryFilter }) {
  const navigate = useNavigate();
  const meta = titleForFilter(filter);
  const [now, setNow] = useState(() => new Date());
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recentlyAdded");
  const [deleteTarget, setDeleteTarget] = useState<BookSummary | null>(null);
  const [exportTarget, setExportTarget] = useState<BookSummary | null>(null);
  const [lockedBatch, setLockedBatch] = useState<string[] | null>(null);
  const [lastOutcomes, setLastOutcomes] = useState<ImportOutcome[] | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** The Kindle clippings sheet; a file picker plus a preview lives inside. */
  const [clippingsOpen, setClippingsOpen] = useState(false);
  /** True when the import button was clicked in the browser, which has no backend. */
  const [webNotice, setWebNotice] = useState(false);
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
  const picking = importBooks.isPending;
  const list = books.data ?? [];
  const continueReading = filter === "all" ? list.find((b) => b.progress > 0) : undefined;

  const exitManaging = () => {
    setManaging(false);
    setSelected(new Set());
    setBatchDeleteOpen(false);
  };
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
          <div>
            <h1 className="text-text-1 text-2xl font-semibold tracking-tight">{meta.title}</h1>
            <p className="text-text-2 mt-1 text-sm">{meta.subtitle}</p>
          </div>
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

      <div className="flex-1 overflow-y-auto px-8 pb-8">
        {filter === "all" && (
          <ContinueReadingCard
            book={continueReading}
            onOpen={(target) => navigate(`/reader?book=${target.id}`)}
          />
        )}

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
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {/* AnimatePresence + the cards' layout FLIP: removed cards shrink
                in place while the survivors glide into their slots. */}
            <AnimatePresence initial={false}>
              {list.map((book, index) => (
                <BookCard
                  key={book.id}
                  book={book}
                  delay={staggerDelay(index, m.stagger)}
                  busy={setFavorite.isPending || deleteBook.isPending}
                  selecting={managing}
                  selected={selected.has(book.id)}
                  onToggleSelect={toggleSelect}
                  onOpen={(target) => navigate(`/reader?book=${target.id}`)}
                  onToggleFavorite={(target) =>
                    setFavorite.mutate({ id: target.id, favorite: !target.favorite })
                  }
                  onAskDelete={setDeleteTarget}
                  onAskExport={setExportTarget}
                  onEditTags={(target) => setTagTarget([target])}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <OverlayPortal>
        <AnimatePresence>
          {managing && (
            <motion.div
              initial={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96, x: "-50%" }}
              animate={{ opacity: 1, y: 0, scale: 1, x: "-50%" }}
              exit={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96, x: "-50%" }}
              transition={m.panel}
              className="glass-2 shadow-panel fixed bottom-6 left-1/2 z-40 flex items-center gap-1.5 rounded-2xl p-2 pl-4"
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
    <output
      aria-label="正在加载书架"
      className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
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

  const percent = Math.round(Math.min(book.progress, 1) * 100);
  return (
    <motion.button
      type="button"
      onClick={() => onOpen(book)}
      whileTap={m.reduce ? undefined : { scale: 0.995 }}
      transition={m.tap}
      className="glass focus-visible:focus-ring group mb-6 flex w-full items-center gap-4 rounded-2xl p-4 text-left"
    >
      <span className="relative block h-16 w-12 shrink-0 overflow-hidden rounded-sm">
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
