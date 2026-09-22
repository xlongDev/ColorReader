import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaretLeft,
  CaretRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from "@phosphor-icons/react";

import { GlassButton, GlassIconButton } from "@/components/glass/button";
import {
  focusIndex,
  MAX_WPM,
  MIN_WPM,
  remainingSeconds,
  tokenDelayMs,
} from "@/features/reader/rsvp";

/** How many words the skip buttons move. */
const SKIP = 10;

/** Keys the overlay claims while it is open. */
const HANDLED_KEYS = new Set(["Escape", " ", "ArrowRight", "ArrowLeft"]);

/**
 * Speed reading over one chapter: the words come to the eye instead of the eye
 * going to the words.
 *
 * It takes the reading area rather than a dialog of its own, for the same
 * reason read-aloud does: the page stays behind it, and closing it puts the
 * reader back exactly where they were. The word is laid out in three columns
 * with the middle one fixed — that column is the whole trick, because the
 * letter in it never moves no matter how long the word is (see `focusIndex`).
 *
 * Timing is a chain of timeouts rather than an interval: a sentence end has to
 * hold longer than the word before it, and an interval can only ever be flat.
 *
 * Mounted only while it runs, which is what resets it: a fresh run starts at
 * the first word of whatever chapter it was handed, and the chapter changing
 * under it is a new run rather than a cursor left somewhere in the old one.
 */
export function RsvpPlayer({
  onClose,
  tokens,
  chapter,
  wpm,
  onWpm,
  onNextChapter,
  hasNextChapter,
  background,
}: {
  onClose: () => void;
  /** The chapter's words, in order. */
  tokens: readonly string[];
  chapter: string;
  wpm: number;
  onWpm: (wpm: number) => void;
  onNextChapter: () => void;
  hasNextChapter: boolean;
  /** The reading surface, so the overlay is the same paper as the page. */
  background: string;
}) {
  const [index, setIndex] = useState(0);
  // A run starts running: opening it is the request to read, not to look at a
  // paused first word.
  const [playing, setPlaying] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  // A new chapter is a new run, decided during render rather than in an effect:
  // the reset belongs to the same commit that brought the new words in, and an
  // effect would paint one frame of the old chapter's position first.
  const [shown, setShown] = useState(tokens);
  if (shown !== tokens) {
    setShown(tokens);
    setIndex(0);
    setPlaying(true);
  }

  useEffect(() => {
    // Keys are read on the overlay, so it has to be the thing that has focus.
    boxRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!playing || index >= tokens.length) return;
    const id = window.setTimeout(
      () => setIndex((at) => at + 1),
      tokenDelayMs(tokens[index] ?? "", wpm),
    );
    return () => window.clearTimeout(id);
  }, [playing, index, tokens, wpm]);

  const done = index >= tokens.length;
  const token = done ? "" : (tokens[index] ?? "");
  const chars = [...token];
  const focus = focusIndex(token);

  const step = useCallback(
    (delta: number) => {
      setIndex((at) => Math.min(Math.max(at + delta, 0), tokens.length));
    },
    [tokens.length],
  );

  /**
   * Keys, claimed in the capture phase.
   *
   * The reader's own arrows turn pages, Space turns one in a paged layout and
   * Escape closes panels — all bound on `window`. Capture runs before them, so
   * stopping the event here keeps it from ever reaching the reader, without a
   * keyboard handler sitting on a plain `div`.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!HANDLED_KEYS.has(event.key)) return;
      // The speed slider is a range input: its own arrows and its space are
      // its to handle, and a reader dragging it is not turning pages.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.isContentEditable)
      ) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      if (event.key === "Escape") onClose();
      else if (event.key === " ") setPlaying((on) => !on);
      else step(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, step]);

  return (
    <div
      ref={boxRef}
      aria-label="速读"
      tabIndex={-1}
      data-rsvp
      className="absolute inset-0 z-50 flex flex-col outline-none"
      style={{ background }}
    >
      <header className="flex items-center gap-3 px-6 py-3">
        <p className="text-text-2 min-w-0 flex-1 truncate text-sm">{chapter}</p>
        <GlassIconButton label="关闭速读" size="sm" onClick={onClose}>
          <X size={16} />
        </GlassIconButton>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        {done ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-text-2 text-sm">
              {tokens.length === 0 ? "这一章还没有可速读的文本" : "这一章读完了"}
            </p>
            {hasNextChapter && (
              <GlassButton variant="subtle" size="sm" onClick={onNextChapter}>
                继续下一章 <CaretRight size={14} />
              </GlassButton>
            )}
          </div>
        ) : (
          // Three columns, the middle one fixed: the focus letter sits on the
          // same pixel for every word, which is what lets the eye stay put.
          <div
            className="grid w-full items-baseline text-[clamp(30px,5vw,64px)] leading-tight"
            style={{ gridTemplateColumns: "1fr auto 1fr" }}
          >
            <span className="text-text-1 truncate text-right">
              {chars.slice(0, focus).join("")}
            </span>
            <span className="text-accent relative px-[1px] font-medium">
              {chars[focus] ?? ""}
              {/* The guide: where to look, so the first word of a run is not a
                  search. */}
              <span
                aria-hidden
                className="bg-accent/60 absolute -top-3 left-1/2 h-2 w-px -translate-x-1/2"
              />
              <span
                aria-hidden
                className="bg-accent/60 absolute -bottom-3 left-1/2 h-2 w-px -translate-x-1/2"
              />
            </span>
            <span className="text-text-1 truncate text-left">
              {chars.slice(focus + 1).join("")}
            </span>
          </div>
        )}
      </div>

      <div className="px-6 pb-5">
        <div className="bg-text-3/20 h-px w-full">
          <div
            className="bg-accent h-px transition-[width] duration-100"
            style={{ width: `${tokens.length > 0 ? (index / tokens.length) * 100 : 0}%` }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <GlassIconButton
            label="后退 10 个词"
            size="sm"
            onClick={() => step(-SKIP)}
            disabled={index === 0}
          >
            <SkipBack size={16} />
          </GlassIconButton>
          <GlassIconButton
            label={playing ? "暂停" : "开始"}
            size="sm"
            onClick={() => setPlaying((on) => !on)}
            disabled={done}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </GlassIconButton>
          <GlassIconButton
            label="前进 10 个词"
            size="sm"
            onClick={() => step(SKIP)}
            disabled={done}
          >
            <SkipForward size={16} />
          </GlassIconButton>
          <span className="text-text-3 text-xs tabular-nums">
            {Math.min(index + 1, tokens.length)} / {tokens.length} · 还剩{" "}
            {Math.round(remainingSeconds(tokens.length, index, wpm) / 60)} 分钟
          </span>
          <label className="flex min-w-[180px] flex-1 items-center gap-2">
            <span className="text-text-3 shrink-0 text-[12px]">速度</span>
            <input
              type="range"
              aria-label="速读速度"
              className="range min-w-0 flex-1"
              min={MIN_WPM}
              max={MAX_WPM}
              step={10}
              value={wpm}
              style={{
                ["--range-fill" as string]: `${((wpm - MIN_WPM) / (MAX_WPM - MIN_WPM)) * 100}%`,
              }}
              onChange={(event) => onWpm(Number(event.currentTarget.value))}
            />
            <span className="text-accent w-[86px] shrink-0 text-right text-[12px] font-semibold tabular-nums">
              {wpm} 词/分
            </span>
          </label>
          {hasNextChapter ? (
            <GlassButton variant="subtle" size="sm" onClick={onNextChapter}>
              下一章 <CaretRight size={14} />
            </GlassButton>
          ) : (
            <GlassButton variant="subtle" size="sm" onClick={onClose}>
              <CaretLeft size={14} /> 退出
            </GlassButton>
          )}
        </div>
      </div>
    </div>
  );
}
