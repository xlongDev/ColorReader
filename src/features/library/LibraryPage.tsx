import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  CaretDown,
  FilePlus,
  Globe,
  MagnifyingGlass,
  Sparkle,
  Sun,
  Upload,
  X,
} from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { isDesktopRuntime } from "@/lib/ipc";
import { BookCard, DeleteBookDialog } from "@/features/library/BookCard";
import {
  failedMessage,
  sortOptions,
  summarizeOutcomes,
  titleForFilter,
} from "@/features/library/format";
import { batchNeedsPassword, PACK_EXTENSIONS } from "@/features/library/pack";
import { useDragDropImport } from "@/hooks/useDragDropImport";

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

import {
  useBooks,
  useDeleteBook,
  useExportPack,
  useImportBooks,
  useImportProgress,
  useLibraryStats,
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
  /** True when the import button was clicked in the browser, which has no backend. */
  const [webNotice, setWebNotice] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const query: BookQuery = useMemo(
    () => ({
      filter: filter === "recent" || filter === "favorites" ? filter : "all",
      sort: filter === "recent" ? "recentlyRead" : sort,
      search: search.trim() || undefined,
    }),
    [filter, sort, search],
  );

  const books = useBooks(query);
  const stats = useLibraryStats();
  const importBooks = useImportBooks();
  const exportPack = useExportPack();
  const deleteBook = useDeleteBook();
  const setFavorite = useSetFavorite();
  const progress = useImportProgress();

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

  const picking = importBooks.isPending;
  const list = books.data ?? [];
  const continueReading = filter === "all" ? list.find((b) => b.progress > 0) : undefined;

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
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
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
        {filter === "all" && <ContinueReadingCard book={continueReading} />}

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

          {stats.data && stats.data.total > 0 && (
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
            {list.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                busy={setFavorite.isPending || deleteBook.isPending}
                onOpen={(target) => navigate(`/reader?book=${target.id}`)}
                onToggleFavorite={(target) =>
                  setFavorite.mutate({ id: target.id, favorite: !target.favorite })
                }
                onAskDelete={setDeleteTarget}
                onAskExport={setExportTarget}
              />
            ))}
          </div>
        )}
      </div>

      {sourceOpen && (
        <Suspense fallback={null}>
          <SourceDialog open onClose={() => setSourceOpen(false)} />
        </Suspense>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/30">
          <div className="glass-2 shadow-panel text-text-1 flex items-center gap-3 rounded-2xl px-6 py-5">
            <Upload size={20} weight="duotone" />
            <span className="text-sm font-medium">松开手指即可导入</span>
          </div>
        </div>
      )}

      {picking && progress && (
        <div className="glass-2 shadow-panel text-text-1 fixed right-6 bottom-6 z-40 flex items-center gap-3 rounded-2xl px-5 py-4">
          <Upload size={16} className="text-accent" />
          <span className="text-sm">
            正在导入 {progress.done}/{progress.total}
          </span>
        </div>
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

function ShelfSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="bg-surface-1 aspect-[3/4] animate-pulse rounded-md" />
      ))}
    </div>
  );
}

function ImportSummary({ outcomes, onClose }: { outcomes: ImportOutcome[]; onClose: () => void }) {
  const failures = outcomes.filter(
    (o): o is Extract<ImportOutcome, { kind: "failed" }> => o.kind === "failed",
  );
  return (
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
  );
}

function ContinueReadingCard({ book }: { book: BookSummary | undefined }) {
  return (
    <section className="glass mb-6 rounded-2xl p-5">
      <div className="text-text-2 flex items-center gap-2">
        <Sun size={16} weight="duotone" />
        <h2 className="text-text-1 text-sm font-medium">继续阅读</h2>
      </div>
      {book ? (
        <p className="text-text-2 mt-2 text-[13px]">
          上次读到《{book.title}》的 {Math.round(Math.min(book.progress, 1) * 100)}% 处。
        </p>
      ) : (
        <p className="text-text-2 mt-2 text-[13px]">
          当你打开一本新书时，最近阅读的位置会出现在这里。
        </p>
      )}
    </section>
  );
}

/** Native open dialog, restricted to the formats Phase 2 understands. */
async function pickFiles(): Promise<string[]> {
  try {
    const picked = await open({
      multiple: true,
      title: "选择要导入的书籍",
      filters: [
        { name: "书籍与书档", extensions: ["epub", "txt", "md", "markdown", ...PACK_EXTENSIONS] },
      ],
    });
    if (picked === null) return [];
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    // Outside the Tauri shell there is no dialog; importing stays desktop-only.
    return [];
  }
}
