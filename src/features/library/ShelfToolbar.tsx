import { useReducedMotion } from "motion/react";
import { motion } from "motion/react";
import { CaretDown, MagnifyingGlass, Rows, SquaresFour, X } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassInput } from "@/components/glass/input";
import { sortOptions } from "@/features/library/format";
import { SPRING } from "@/lib/motion";
import { cn } from "@/lib/cn";
import type { useLibraryStats } from "@/hooks/useLibrary";
import type { LibrarySort } from "@/types/ipc";

/**
 * Search, sort, layout and the batch-manage switch — the one row of controls
 * that acts on the whole shelf rather than on a book.
 */
export function ShelfToolbar({
  search,
  onSearch,
  sort,
  onSort,
  layout,
  onLayout,
  managing,
  onToggleManaging,
  stats,
}: {
  search: string;
  onSearch: (value: string) => void;
  sort: LibrarySort;
  onSort: (value: LibrarySort) => void;
  layout: "grid" | "list";
  onLayout: (value: "grid" | "list") => void;
  managing: boolean;
  onToggleManaging: () => void;
  stats: ReturnType<typeof useLibraryStats>["data"];
}) {
  const reduce = useReducedMotion();
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-64">
        <MagnifyingGlass
          size={14}
          className="text-text-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
        />
        <GlassInput
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索书名或作者"
          className="pr-8 pl-8"
          aria-label="搜索书名或作者"
        />
        {search && (
          <button
            type="button"
            aria-label="清除搜索"
            onClick={() => onSearch("")}
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
          onChange={(event) => onSort(event.target.value as LibrarySort)}
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
          const active = layout === option.value;
          const Icon = option.icon;
          return (
            <button
              key={option.value}
              type="button"
              title={option.label}
              aria-label={option.label}
              aria-pressed={active}
              onClick={() => onLayout(option.value)}
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

      <GlassButton size="md" variant={managing ? "primary" : "subtle"} onClick={onToggleManaging}>
        <SquaresFour size={15} /> {managing ? "退出管理" : "批量管理"}
      </GlassButton>

      {stats && stats.total > 0 && !managing && (
        <p className="text-text-3 ml-auto text-xs">
          共 {stats.total} 本{stats.reading > 0 && ` · 在读 ${stats.reading}`}
          {stats.favorites > 0 && ` · 收藏 ${stats.favorites}`}
        </p>
      )}
    </div>
  );
}
