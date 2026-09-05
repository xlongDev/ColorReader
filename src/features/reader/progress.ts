import type { ChapterMeta } from "@/types/ipc";

/** Sum of every chapter's character count. */
export function totalChars(chapters: ChapterMeta[]): number {
  return chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
}

/**
 * Maps a global 0..1 progress fraction onto a chapter and the fraction within
 * it, using character counts so no content is loaded to locate the position.
 */
export function locateChapter(
  chapters: ChapterMeta[],
  progress: number,
): { idx: number; fraction: number } {
  if (chapters.length === 0) return { idx: 0, fraction: 0 };

  const total = totalChars(chapters);
  if (total <= 0) return { idx: 0, fraction: 0 };

  const target = Math.min(Math.max(progress, 0), 1) * total;
  let before = 0;
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const chars = chapter.chars;
    if (target < before + chars || i === chapters.length - 1) {
      const fraction = chars > 0 ? (target - before) / chars : 0;
      return { idx: i, fraction: Math.min(Math.max(fraction, 0), 1) };
    }
    before += chars;
  }
  return { idx: chapters.length - 1, fraction: 1 };
}

/** Global progress from a chapter position, for persisting. */
export function globalProgress(chapters: ChapterMeta[], idx: number, fraction: number): number {
  if (chapters.length === 0) return 0;
  const total = totalChars(chapters);
  if (total <= 0) return 0;

  const clamped = Math.max(0, Math.min(idx, chapters.length - 1));
  let before = 0;
  for (let i = 0; i < clamped; i++) before += chapters[i]!.chars;
  const chapter = chapters[clamped]!;
  return (before + chapter.chars * Math.min(Math.max(fraction, 0), 1)) / total;
}

/** Characters from the current position to the end of the book. */
export function remainingChars(chapters: ChapterMeta[], idx: number, fraction: number): number {
  const total = totalChars(chapters);
  const before = globalProgress(chapters, idx, fraction) * total;
  return Math.max(0, Math.round(total - before));
}

/**
 * Human reading-time label for a character count at `charsPerMinute`.
 * Sub-minute stays are called out instead of rounding to a bare zero.
 */
export function estimateLabel(chars: number, charsPerMinute: number): string {
  if (charsPerMinute <= 0) return "未知";
  const minutes = chars / charsPerMinute;
  if (minutes < 1) return "不到 1 分钟";
  const whole = Math.floor(minutes);
  if (whole < 60) return `约 ${whole} 分钟`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${rest} 分钟`;
}
