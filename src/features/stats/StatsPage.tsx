import { Clock, Fire, CalendarBlank, TrendUp, BookOpen } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { GlassPanel } from "@/components/glass/panel";
import { Reveal } from "@/components/motion/Reveal";
import { useLibraryStats } from "@/hooks/useLibrary";
import { useClearReadingStats, useReadingStats } from "@/hooks/useReading";
import { useToasts } from "@/stores/toasts";
import type { DayTotal, TopBook } from "@/types/ipc";
import { staggerDelay, useMotion } from "@/lib/motion";

/**
 * Reading stats: how much time went into reading, and where it went.
 *
 * The heat map is the anchor — half a year of squares shows the rhythm that
 * brings a reader back tomorrow. Around it: the same rhythm at day scale
 * (trailing month as bars) and at book scale (the trailing-month ranking),
 * so the page answers "how am I doing" and "what was I reading" together.
 */

/** Cell size and gap of the heat map, in px. */
const CELL = 11;
const GAP = 3;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** Human reading time. Below an hour it is minutes; above it, hours. */
function duration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

function dayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)} 月 ${Number(date)} 日`;
}

function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
}

interface MetricProps {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
  /** Entrance offset inside the row of four; see `staggerDelay`. */
  delay?: number;
}

function Metric({ icon, label, value, hint, delay = 0 }: MetricProps) {
  const m = useMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: m.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...m.enter, delay }}
      className="flex items-start gap-3 px-5 py-4"
    >
      <span className="text-text-3 mt-0.5 flex">{icon}</span>
      <div className="min-w-0">
        <p className="text-text-2 text-xs">{label}</p>
        <p className="text-text-1 mt-0.5 text-lg font-semibold tabular-nums md:text-xl">{value}</p>
        {hint && <p className="text-text-3 mt-0.5 text-[11px]">{hint}</p>}
      </div>
    </motion.div>
  );
}

/**
 * Squares for the trailing days, one column per week, oldest first.
 *
 * Leading blanks pad the first column so every row is one weekday; without
 * them the Sunday-to-Saturday labels would drift against the data.
 */
function Heatmap({ days }: { days: DayTotal[] }) {
  const first = days[0] ? new Date(`${days[0].day}T00:00:00`).getDay() : 0;
  const cells: (DayTotal | null)[] = [...Array<null>(first).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (DayTotal | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }

  // Four shades over the reader's own busiest day: the scale means nothing
  // absolute, so it is relative rather than a fixed minutes ladder.
  const busiest = Math.max(...days.map((day) => day.seconds), 1);
  const shade = (seconds: number) => {
    const ratio = seconds / busiest;
    if (ratio > 0.66) return 1;
    if (ratio > 0.33) return 0.72;
    if (ratio > 0.08) return 0.44;
    return 0.22;
  };

  let lastMonth = -1;
  return (
    <div className="flex gap-2">
      <div className="flex flex-col pt-[15px]" style={{ gap: GAP }} aria-hidden="true">
        {WEEKDAYS.map((label, index) => (
          <span
            key={label}
            className="text-text-3 text-[9px] leading-none"
            style={{ height: CELL, lineHeight: `${CELL}px` }}
          >
            {index % 2 === 1 ? label : ""}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto">
        <div className="flex" style={{ gap: GAP }}>
          {weeks.map((week, column) => {
            const anchor = week.find((cell) => cell !== null);
            const month = anchor ? Number(anchor.day.split("-")[1]) : lastMonth;
            const showMonth = month !== lastMonth;
            lastMonth = month;
            return (
              <div
                key={anchor?.day ?? `lead-${column}`}
                className="flex flex-col"
                style={{ gap: GAP }}
              >
                <span className="text-text-3 relative h-[11px] text-[9px] leading-none">
                  {showMonth && (
                    <span className="absolute top-0 left-0 whitespace-nowrap">{month} 月</span>
                  )}
                </span>
                {week.map((cell, row) => (
                  <span
                    key={cell?.day ?? `pad-${column}-${row}`}
                    className="heat-cell"
                    style={{ animationDelay: `${column * 14}ms` }}
                  >
                    {cell ? (
                      <span
                        className="bg-accent block rounded-[3px]"
                        style={{
                          width: CELL,
                          height: CELL,
                          opacity: cell.seconds > 0 ? shade(cell.seconds) : 0.1,
                        }}
                        title={`${dayLabel(cell.day)}：${duration(cell.seconds)}`}
                      />
                    ) : (
                      <span className="block rounded-[3px]" style={{ width: CELL, height: CELL }} />
                    )}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="text-text-3 flex items-center gap-1.5 text-[11px]">
      <span>少</span>
      {[0.1, 0.22, 0.44, 0.72, 1].map((opacity) => (
        <span
          key={opacity}
          className="bg-accent block rounded-[3px]"
          style={{ width: CELL, height: CELL, opacity }}
        />
      ))}
      <span>多</span>
    </div>
  );
}

/**
 * One bar per day for the trailing month, oldest left.
 *
 * Height is relative to the month's own busiest day; quiet days stay visible
 * as a stub so gaps read as gaps, not as missing markup.
 */
function TrendBars({ days }: { days: DayTotal[] }) {
  const peak = Math.max(...days.map((day) => day.seconds), 1);
  return (
    <div className="flex h-28 items-end gap-[3px]">
      {days.map((day, index) => (
        <span key={day.day} className="group relative flex h-full min-w-0 flex-1 items-end">
          <span
            className="bg-accent w-full rounded-t-[3px] transition-opacity group-hover:opacity-100!"
            style={{
              height: day.seconds > 0 ? `${Math.max((day.seconds / peak) * 100, 6)}%` : "3%",
              opacity: day.seconds > 0 ? 0.7 : 0.15,
              animationDelay: `${index * 10}ms`,
            }}
            title={`${dayLabel(day.day)}：${duration(day.seconds)}`}
          />
        </span>
      ))}
    </div>
  );
}

/** The trailing-month ranking. Tapping a row opens that book. */
function TopBooks({ books, onOpen }: { books: TopBook[]; onOpen: (bookId: string) => void }) {
  const busiest = Math.max(...books.map((book) => book.seconds), 1);
  return (
    <ul className="-mx-2 flex flex-col">
      {books.map((book, index) => (
        <li key={book.bookId}>
          <button
            type="button"
            onClick={() => onOpen(book.bookId)}
            className="focus-visible:focus-ring hover:bg-surface-1 group w-full rounded-xl px-2 py-2 text-left transition-colors"
            aria-label={`打开《${book.title}》`}
          >
            <span className="flex items-baseline gap-2">
              <span className="text-text-3 w-4 text-xs tabular-nums">{index + 1}</span>
              <span className="text-text-1 min-w-0 flex-1 truncate text-sm">{book.title}</span>
              <span className="text-text-2 text-xs tabular-nums">{duration(book.seconds)}</span>
            </span>
            <span className="bg-surface-1 mt-1.5 ml-6 flex h-[3px] overflow-hidden rounded-full">
              <span
                className="bg-accent block h-full rounded-full transition-[width]"
                style={{
                  width: `${Math.max((book.seconds / busiest) * 100, 4)}%`,
                  opacity: 1 - index * 0.16,
                }}
              />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function StatsPage() {
  const m = useMotion();
  const navigate = useNavigate();
  const { data, isPending } = useReadingStats();
  const library = useLibraryStats();
  const clear = useClearReadingStats();
  const toast = useToasts((state) => state.push);
  const [clearOpen, setClearOpen] = useState(false);

  const stats = data;
  const tracked = (stats?.totalSeconds ?? 0) > 0;
  const days = stats?.days ?? [];
  const yesterday = days.at(-2);
  const month = days.slice(-30);
  const bestDay = month.reduce<DayTotal | null>(
    (top, day) => (!top || day.seconds > top.seconds ? day : top),
    null,
  );
  const openBook = (bookId: string) => navigate(`/reader?book=${bookId}`);

  /** Irreversible, so it asks; the toast is the only feedback after the fact
   *  because what it wiped is no longer on screen to show. */
  const confirmClear = () => {
    clear.mutate(undefined, {
      onSuccess: () => {
        setClearOpen(false);
        toast({ tone: "success", message: "阅读时长已清除，书和笔记都还在" });
      },
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="px-8 pt-8 pb-6">
        <h1 className="text-text-1 text-2xl font-semibold tracking-tight">阅读统计</h1>
        <p className="text-text-2 mt-1 text-sm">
          打开书的时间会被记下来，一半是给自己的交代，一半是明天再打开的理由。
        </p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pb-8">
        {isPending ? (
          <GlassPanel className="h-[92px] animate-pulse" />
        ) : (
          <GlassPanel className="divide-hairline grid grid-cols-2 divide-y md:grid-cols-4 md:divide-x md:divide-y-0">
            <Metric
              icon={<Clock size={18} />}
              label="今日阅读"
              value={duration(stats?.todaySeconds ?? 0)}
              hint={yesterday ? `昨天 ${duration(yesterday.seconds)}` : undefined}
              delay={staggerDelay(0, m.stagger)}
            />
            <Metric
              icon={<Fire size={18} />}
              label="连续天数"
              value={`${stats?.streak ?? 0} 天`}
              hint={stats?.streak ? `历史最长 ${stats.bestStreak} 天` : "今天开一本就续上"}
              delay={staggerDelay(1, m.stagger)}
            />
            <Metric
              icon={<TrendUp size={18} />}
              label="最近七天"
              value={duration(stats?.weekSeconds ?? 0)}
              hint={
                (stats?.weekSeconds ?? 0) > 0
                  ? `日均 ${duration(Math.round((stats?.weekSeconds ?? 0) / 7))}`
                  : undefined
              }
              delay={staggerDelay(2, m.stagger)}
            />
            <Metric
              icon={<CalendarBlank size={18} />}
              label="累计阅读"
              value={duration(stats?.totalSeconds ?? 0)}
              hint={`${stats?.daysRead ?? 0} 天有过阅读`}
              delay={staggerDelay(3, m.stagger)}
            />
          </GlassPanel>
        )}

        <Reveal delay={staggerDelay(4, m.stagger)}>
          <GlassPanel className="px-5 py-4">
            {tracked && stats ? (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-text-1 text-sm font-medium">过去半年</h2>
                  <Legend />
                </div>
                <Heatmap days={stats.days} />
                <p className="text-text-3 mt-4 text-[11px]">
                  书架里读完 {library.data?.finished ?? 0} 本，在读 {library.data?.reading ?? 0}{" "}
                  本。
                </p>
              </>
            ) : (
              <EmptyState
                className="py-10"
                icon={<Clock size={24} />}
                title="还没有阅读记录"
                description="打开一本书读一会儿，这里会按天记下你花了多少时间，半年之后就是一张图。"
              />
            )}
          </GlassPanel>
        </Reveal>

        {tracked && stats && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <Reveal delay={staggerDelay(5, m.stagger)} className="lg:col-span-2">
              <GlassPanel className="h-full px-5 py-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-text-1 text-sm font-medium">最近 30 天</h2>
                  <span className="text-text-3 text-[11px] tabular-nums">
                    {shortDay(month[0]?.day ?? "")} – {shortDay(month.at(-1)?.day ?? "")}
                  </span>
                </div>
                <TrendBars days={month} />
                {bestDay && bestDay.seconds > 0 && (
                  <p className="text-text-3 mt-3 text-[11px]">
                    最投入的一天：{dayLabel(bestDay.day)} · {duration(bestDay.seconds)}
                  </p>
                )}
              </GlassPanel>
            </Reveal>

            <Reveal delay={staggerDelay(6, m.stagger)} className="lg:col-span-3">
              <GlassPanel className="h-full px-5 py-4">
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-text-1 text-sm font-medium">最近在读</h2>
                  <span className="text-text-3 text-[11px]">近 30 天 · 点击回到书里</span>
                </div>
                {stats.topBooks.length > 0 ? (
                  <TopBooks books={stats.topBooks} onOpen={openBook} />
                ) : (
                  <p className="text-text-3 flex items-center gap-2 py-6 text-xs">
                    <BookOpen size={14} className="shrink-0" />
                    最近 30 天还没有翻开过书。
                  </p>
                )}
              </GlassPanel>
            </Reveal>
          </div>
        )}

        {tracked && (
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => setClearOpen(true)}
              className="focus-visible:focus-ring text-text-3 hover:text-danger rounded-lg px-2 py-1 text-[11px] transition-colors"
            >
              清除阅读数据
            </button>
          </div>
        )}
      </div>

      <GlassDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="清除全部阅读时长？"
        description="热力图、连续天数和最近在读都会归零，此操作无法撤销。书籍、进度、标注和笔记不受影响。"
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton
            variant="subtle"
            onClick={() => setClearOpen(false)}
            disabled={clear.isPending}
          >
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            onClick={confirmClear}
            disabled={clear.isPending}
          >
            清除
          </GlassButton>
        </div>
      </GlassDialog>
    </div>
  );
}
