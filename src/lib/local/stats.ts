/** One finished reading stretch, the raw material of the stats page. */
type Session = { day: string; bookId: string; seconds: number };

/**
 * Reading time: one row per day and book, summed the way the stats page shows.
 *
 * A session is the raw material — a finished stretch, as the reader reported
 * it — and the page asks for windows and streaks over the whole log, so both
 * live next to the log they walk.
 */

import type { ReadingStats } from "@/lib/bindings";
import * as db from "@/lib/local/db";
import { type StoredBook, now, two } from "./rows";

/** Local `YYYY-MM-DD`, the day key the stats page groups by. */
function dayOf(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
async function sessions(): Promise<Session[]> {
  return (await db.get<Session[]>("meta", "sessions")) ?? [];
}

export async function statsRecordSession(bookId: string, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  const log = await sessions();
  // One row per day and book: the page only ever sums them, so a day of reading
  // is a handful of rows rather than one per stretch.
  const day = dayOf(now());
  const row = log.find((entry) => entry.day === day && entry.bookId === bookId);
  if (row) row.seconds += seconds;
  else log.push({ day, bookId, seconds });
  await db.put("meta", "sessions", log);
}

const STATS_WINDOW = 180;
const TOP_WINDOW = 30;

export async function statsReading(): Promise<ReadingStats> {
  const log = await sessions();
  const titles = new Map((await db.all<StoredBook>("books")).map((book) => [book.id, book.title]));
  const today = dayOf(now());
  const byDay = new Map<string, number>();
  const byBook = new Map<string, number>();
  for (const entry of log) {
    byDay.set(entry.day, (byDay.get(entry.day) ?? 0) + entry.seconds);
    if (inWindow(entry.day, TOP_WINDOW)) {
      byBook.set(entry.bookId, (byBook.get(entry.bookId) ?? 0) + entry.seconds);
    }
  }

  const days: { day: string; seconds: number }[] = [];
  for (let back = STATS_WINDOW - 1; back >= 0; back -= 1) {
    const day = dayOf(now() - back * 86_400);
    days.push({ day, seconds: byDay.get(day) ?? 0 });
  }

  let streak = 0;
  for (let back = 0; back < 400; back += 1) {
    const seconds = byDay.get(dayOf(now() - back * 86_400)) ?? 0;
    if (seconds > 0) streak += 1;
    else if (back > 0) break;
    // A day with no reading yet does not end a streak that is still running.
  }

  let best = 0;
  let run = 0;
  for (const day of [...byDay.keys()].toSorted()) {
    const previous = dayOf(Date.parse(`${day}T00:00:00`) / 1000 - 86_400);
    run = byDay.has(previous) ? run + 1 : 1;
    best = Math.max(best, run);
  }

  return {
    todaySeconds: byDay.get(today) ?? 0,
    weekSeconds: days.slice(-7).reduce((total, day) => total + day.seconds, 0),
    totalSeconds: log.reduce((total, entry) => total + entry.seconds, 0),
    streak,
    daysRead: byDay.size,
    days,
    bestStreak: best,
    topBooks: [...byBook.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([bookId, seconds]) => ({
        bookId,
        title: titles.get(bookId) ?? "（已删除）",
        seconds,
      })),
  };
}

export async function statsClear(): Promise<void> {
  await db.put("meta", "sessions", []);
}

/** Whether a `YYYY-MM-DD` day is within the last `days` days, today included. */
function inWindow(day: string, days: number): boolean {
  const limit = dayOf(now() - (days - 1) * 86_400);
  return day >= limit;
}
