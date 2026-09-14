import { Clock, Fire, CalendarBlank, TrendUp } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

import { EmptyState } from "@/components/common/EmptyState";
import { GlassPanel } from "@/components/glass/panel";
import { useLibraryStats } from "@/hooks/useLibrary";
import { useReadingStats } from "@/hooks/useReading";
import type { DayTotal } from "@/types/ipc";

/**
 * Reading stats: how much time went into reading, and when.
 *
 * The heat map is the point of the page. Four numbers alone are a scoreboard
 * nobody acts on; a half year of squares shows rhythm, and rhythm is what
 * makes a reader come back tomorrow.
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

interface MetricProps {
  icon: ReactNode;
  label: string;
  value: string;
  hint?: string;
}

function Metric({ icon, label, value, hint }: MetricProps) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <span className="text-text-3 mt-0.5 flex">{icon}</span>
      <div className="min-w-0">
        <p className="text-text-2 text-xs">{label}</p>
        <p className="text-text-1 mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-text-3 mt-0.5 text-[11px]">{hint}</p>}
      </div>
    </div>
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

export function StatsPage() {
  const reduce = useReducedMotion();
  const { data, isPending } = useReadingStats();
  const library = useLibraryStats();

  const stats = data;
  const tracked = (stats?.totalSeconds ?? 0) > 0;

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
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          >
            <GlassPanel className="divide-hairline grid grid-cols-2 divide-y md:grid-cols-4 md:divide-x md:divide-y-0">
              <Metric
                icon={<Clock size={18} />}
                label="今日阅读"
                value={duration(stats?.todaySeconds ?? 0)}
              />
              <Metric
                icon={<Fire size={18} />}
                label="连续天数"
                value={`${stats?.streak ?? 0} 天`}
                hint={stats?.streak ? "别断在今天" : "今天开一本就续上"}
              />
              <Metric
                icon={<TrendUp size={18} />}
                label="最近七天"
                value={duration(stats?.weekSeconds ?? 0)}
              />
              <Metric
                icon={<CalendarBlank size={18} />}
                label="累计阅读"
                value={duration(stats?.totalSeconds ?? 0)}
                hint={`${stats?.daysRead ?? 0} 天有过阅读`}
              />
            </GlassPanel>
          </motion.div>
        )}

        <GlassPanel className="px-5 py-4">
          {tracked && stats ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-text-1 text-sm font-medium">过去半年</h2>
                <Legend />
              </div>
              <Heatmap days={stats.days} />
              <p className="text-text-3 mt-4 text-[11px]">
                书架里读完 {library.data?.finished ?? 0} 本，在读 {library.data?.reading ?? 0} 本。
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
      </div>
    </div>
  );
}
