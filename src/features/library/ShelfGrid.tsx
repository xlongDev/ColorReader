import type { RefObject } from "react";
import { BookOpen, Sparkle } from "@phosphor-icons/react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { BookCard } from "@/features/library/BookCard";
import type { useShelfWindow } from "@/hooks/useShelfWindow";
import { staggerDelay, useMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";
import type { BookSummary } from "@/types/ipc";

/**
 * The windowed card grid.
 *
 * Only the cards the viewport can reach are rendered (see `useShelfWindow`);
 * the rest of the list is held open by the two spacers.
 */
export function ShelfGrid({
  pending,
  error,
  search,
  list,
  shelf,
  gridRef,
  layout,
  tagRow,
  managing,
  selected,
  busy,
  onToggleSelect,
  onOpen,
  onToggleFavorite,
  onAskDelete,
  onAskExport,
  onEditTags,
  onImport,
}: {
  pending: boolean;
  error: unknown;
  search: string;
  list: BookSummary[];
  shelf: ReturnType<typeof useShelfWindow>;
  gridRef: RefObject<HTMLDivElement | null>;
  layout: "grid" | "list";
  tagRow: boolean;
  managing: boolean;
  selected: ReadonlySet<string>;
  busy: boolean;
  onToggleSelect: (book: BookSummary) => void;
  onOpen: (book: BookSummary) => void;
  onToggleFavorite: (book: BookSummary) => void;
  onAskDelete: (book: BookSummary) => void;
  onAskExport: (book: BookSummary) => void;
  onEditTags: (book: BookSummary) => void;
  onImport: () => void;
}) {
  const m = useMotion();

  if (pending) return <ShelfSkeleton />;
  if (error) {
    return (
      <EmptyState
        className="min-h-[30vh]"
        icon={<BookOpen size={26} weight="duotone" />}
        title="书架暂时打不开"
        description={String(error)}
      />
    );
  }
  if (list.length === 0) {
    return (
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
            <GlassButton variant="primary" size="md" onClick={onImport}>
              <Sparkle size={14} /> 导入书籍
            </GlassButton>
          )
        }
      />
    );
  }

  return (
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
          layout === "grid" && shelf.columns > 0
            ? {
                gridTemplateColumns: `repeat(${shelf.columns}, minmax(0, var(--shelf-track)))`,
              }
            : undefined
        }
        className={cn(
          layout === "grid"
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
            reserveTags={tagRow && layout === "grid"}
            busy={busy}
            selecting={managing}
            selected={selected.has(book.id)}
            onToggleSelect={onToggleSelect}
            onOpen={onOpen}
            variant={layout}
            onToggleFavorite={onToggleFavorite}
            onAskDelete={onAskDelete}
            onAskExport={onAskExport}
            onEditTags={onEditTags}
          />
        ))}
      </div>
      {shelf.bottom > 0 && <div style={{ height: shelf.bottom }} aria-hidden />}
    </>
  );
}

function ShelfSkeleton() {
  return (
    // Mirrors the real tile's box (cover + two text lines) so the grid does not
    // jump when the books land, and announces itself once for screen readers.
    // The track must match the real grid's (see the shelf above) or the covers
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
