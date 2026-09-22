import type { RefObject } from "react";
import { motion } from "motion/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowsIn,
  ArrowsOut,
  BookmarkSimple,
  CaretLeft,
  CaretRight,
  Faders,
  Graph,
  HighlighterCircle,
  ListBullets,
  Lightning,
  MagnifyingGlass,
  Minus,
  Pause,
  Plus,
  SpeakerHigh,
  Sparkle,
} from "@phosphor-icons/react";

import { GlassButton, GlassIconButton } from "@/components/glass/button";
import { IconSwap } from "@/components/motion/IconSwap";
import { HeaderCover, HeaderRule } from "@/features/reader/ReaderHeader";
import { estimateLabel } from "@/features/reader/progress";
import { MAX_PDF_ZOOM, MIN_PDF_ZOOM, PDF_ZOOM_STEP } from "@/features/reader/usePdfZoom";
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "@/stores/reader";
import { cn } from "@/lib/cn";

/** Which side panel is open. Only one at a time, so they never stack. */
export type Panel =
  "none" | "annotations" | "search" | "ai" | "guide" | "graph" | "toc" | "settings";

/**
 * Reader chrome buttons: same anatomy as the sidebar's glass buttons, but
 * fill and hairline come from the re-rooted reading-surface tokens — the
 * fill is a wash of the paper colour (`--glass-btn`), so the circles read as
 * liquid glass over the page without darkening it like an ink fill would.
 */
const CHROME_BTN = "bg-(--glass-btn) border-hairline-strong shadow-glass";

export function ReaderHeaderBar({
  fullscreen,
  onBack,
  bookId,
  coverUrl,
  coverBoxRef,
  title,
  index,
  total,
  isPdf,
  chapterLabel,
  onTogglePanel,
  pdfZoom,
  onZoom,
  fontSize,
  onFontSize,
  atBookmark,
  onToggleBookmark,
  bookmarkPending,
  onToggleFullscreen,
}: {
  fullscreen: boolean;
  onBack: () => void;
  bookId: string;
  coverUrl: string | null;
  coverBoxRef: RefObject<HTMLSpanElement | null>;
  title: string;
  /** 1-based position in the chapter list, or the page number for a PDF. */
  index: number;
  total: number;
  isPdf: boolean;
  /** Chapter heading, shown for prose books only. */
  chapterLabel: string;
  onTogglePanel: (panel: Exclude<Panel, "none">) => void;
  pdfZoom: number;
  onZoom: (next: number) => void;
  fontSize: number;
  onFontSize: (next: number) => void;
  atBookmark: boolean;
  onToggleBookmark: () => void;
  bookmarkPending: boolean;
  onToggleFullscreen: () => void;
}) {
  return (
    <header
      className={cn(
        "border-hairline flex items-center gap-3 border-b px-6 py-3",
        fullscreen && "bg-(--glass-btn) backdrop-blur-xl",
      )}
    >
      <GlassIconButton label="返回书库" size="sm" onClick={onBack} className={CHROME_BTN}>
        <ArrowLeft size={16} />
      </GlassIconButton>
      <HeaderCover bookId={bookId} coverUrl={coverUrl} boxRef={coverBoxRef} />
      <div className="min-w-0 flex-1">
        <p className="text-text-1 truncate text-sm font-medium">{title}</p>
        <p className="text-text-3 truncate text-xs">
          第 {index} / {total} {isPdf ? "页" : "章"}
          {!isPdf && chapterLabel && ` · ${chapterLabel}`}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <GlassIconButton
          label="目录与书签"
          size="sm"
          className={CHROME_BTN}
          onClick={() => onTogglePanel("toc")}
        >
          <ListBullets size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="搜索"
          size="sm"
          className={CHROME_BTN}
          onClick={() => onTogglePanel("search")}
        >
          <MagnifyingGlass size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="标注"
          size="sm"
          className={CHROME_BTN}
          onClick={() => onTogglePanel("annotations")}
        >
          <HighlighterCircle size={16} />
        </GlassIconButton>
        <HeaderRule />
        <GlassIconButton
          label="知识图谱"
          size="sm"
          className={CHROME_BTN}
          onClick={() => onTogglePanel("graph")}
        >
          <Graph size={16} />
        </GlassIconButton>
        <GlassIconButton
          label="AI 导读"
          size="sm"
          className={CHROME_BTN}
          onClick={() => onTogglePanel("guide")}
        >
          <Sparkle size={16} />
        </GlassIconButton>
        <HeaderRule />
        <GlassIconButton
          label="阅读设置"
          size="sm"
          className={CHROME_BTN}
          onClick={() => onTogglePanel("settings")}
        >
          <Faders size={16} />
        </GlassIconButton>
        {isPdf ? (
          // PDF pages are fixed bitmaps; the header steppers zoom the page.
          <>
            <GlassIconButton
              label="缩小页面"
              size="sm"
              className={CHROME_BTN}
              onClick={() => onZoom(pdfZoom / PDF_ZOOM_STEP)}
              disabled={pdfZoom <= MIN_PDF_ZOOM}
            >
              <Minus size={16} />
            </GlassIconButton>
            <GlassIconButton
              label="重置缩放"
              size="sm"
              className={CHROME_BTN}
              onClick={() => onZoom(1)}
            >
              <span className="text-[11px] font-semibold tabular-nums">
                {Math.round(pdfZoom * 100)}%
              </span>
            </GlassIconButton>
            <GlassIconButton
              label="放大页面"
              size="sm"
              className={CHROME_BTN}
              onClick={() => onZoom(pdfZoom * PDF_ZOOM_STEP)}
              disabled={pdfZoom >= MAX_PDF_ZOOM}
            >
              <Plus size={16} />
            </GlassIconButton>
          </>
        ) : (
          <>
            <GlassIconButton
              label="缩小字号"
              size="sm"
              className={CHROME_BTN}
              onClick={() => onFontSize(fontSize - 1)}
              disabled={fontSize <= MIN_FONT_SIZE}
            >
              <span className="text-[11px] font-semibold">A</span>
            </GlassIconButton>
            <GlassIconButton
              label="放大字号"
              size="sm"
              className={CHROME_BTN}
              onClick={() => onFontSize(fontSize + 1)}
              disabled={fontSize >= MAX_FONT_SIZE}
            >
              <span className="text-sm font-semibold">A</span>
            </GlassIconButton>
          </>
        )}
        <HeaderRule />
        <GlassIconButton
          label={atBookmark ? "取消本书签" : "添加书签"}
          size="sm"
          className={CHROME_BTN}
          onClick={onToggleBookmark}
          disabled={bookmarkPending}
        >
          {/* Remounting on state flip restarts the pop; the icon eases between
              outline and filled + accent instead of snapping. */}
          <span
            key={atBookmark ? "saved" : "idle"}
            className={cn(
              "inline-flex transition-colors duration-300",
              atBookmark && "text-accent animate-[bookmark-pop_0.45s_ease-out]",
            )}
          >
            <BookmarkSimple size={16} weight={atBookmark ? "fill" : "regular"} />
          </span>
        </GlassIconButton>
        <GlassIconButton
          label={fullscreen ? "退出全屏" : "全屏阅读"}
          size="sm"
          className={CHROME_BTN}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
        </GlassIconButton>
      </div>
    </header>
  );
}

/**
 * Footer controls, shared by the in-flow bar and the fullscreen bottom hud.
 *
 * `speechStatus` drives the one button that means three things: start, pause
 * and resume. `paged` decides whether the wheel button scrolls or turns pages,
 * which is also what its label promises.
 */
export function ReaderFooterControls({
  speechStatus,
  onToggleSpeech,
  onTogglePlayer,
  speechRate,
  paged,
  autoScrolling,
  onToggleAutoScroll,
  onStepChapter,
  chapterIdx,
  total,
  chapterRemaining,
  bookRemaining,
  readingSpeed,
  progress,
  rsvpOn,
  onRsvp,
}: {
  speechStatus: "idle" | "playing" | "paused";
  onToggleSpeech: () => void;
  onTogglePlayer: () => void;
  speechRate: number;
  paged: boolean;
  autoScrolling: boolean;
  onToggleAutoScroll: () => void;
  onStepChapter: (dir: 1 | -1) => void;
  chapterIdx: number;
  total: number;
  chapterRemaining: number;
  bookRemaining: number;
  /** Words per minute, from the reader's own measured reading speed. */
  readingSpeed: number;
  progress: number;
  /** Speed reading is running: the button shows it rather than only opening it. */
  rsvpOn: boolean;
  onRsvp: () => void;
}) {
  /** Speech first, then the player, then auto-scroll — see the footer's own
   *  note on why the scroll button is not available in every layout. */
  const autoScrollLabel = paged
    ? "自动滚动仅在滚动排版下可用"
    : autoScrolling
      ? "暂停自动滚动"
      : "开始自动滚动";

  const speechLabel =
    speechStatus === "paused"
      ? "继续朗读"
      : speechStatus === "playing"
        ? "暂停朗读"
        : "从当前位置朗读";

  return (
    <>
      <GlassIconButton
        label={speechLabel}
        size="sm"
        className={CHROME_BTN}
        onClick={onToggleSpeech}
      >
        <IconSwap state={speechStatus}>
          {speechStatus === "playing" ? <Pause size={16} /> : <SpeakerHigh size={16} />}
        </IconSwap>
      </GlassIconButton>
      <GlassIconButton label="朗读播放器" size="sm" className={CHROME_BTN} onClick={onTogglePlayer}>
        <span className="text-[11px] font-semibold tabular-nums">{speechRate}×</span>
      </GlassIconButton>
      {/* Speed reading, third next to listening and scrolling: it is the same
          job — taking in the chapter without moving your hands — done by the
          eye instead of the ear. */}
      <GlassIconButton
        label="速读（RSVP）"
        size="sm"
        className={cn(CHROME_BTN, rsvpOn && "text-accent")}
        aria-pressed={rsvpOn}
        onClick={onRsvp}
      >
        <Lightning size={16} weight={rsvpOn ? "fill" : "regular"} />
      </GlassIconButton>
      <GlassIconButton
        // Auto-scroll is a rolling viewport; a paged one has no flow to roll,
        // so the control is off there rather than re-pointed at page turns —
        // two behaviours under one icon was how "自动滚动" came to mean
        // "每隔几秒跳一屏" to readers who had picked the other layout.
        label={autoScrollLabel}
        title={paged ? autoScrollLabel : undefined}
        size="sm"
        className={CHROME_BTN}
        disabled={paged}
        onClick={onToggleAutoScroll}
      >
        <IconSwap state={autoScrolling ? "on" : "off"}>
          {autoScrolling ? <Pause size={16} /> : <ArrowDown size={16} />}
        </IconSwap>
      </GlassIconButton>
      <GlassButton
        variant="subtle"
        size="sm"
        onClick={() => onStepChapter(-1)}
        disabled={chapterIdx === 0}
      >
        <CaretLeft size={14} /> 上一章
      </GlassButton>
      <span className="text-text-3 text-xs">
        本章 {estimateLabel(chapterRemaining, readingSpeed)} · 全书{" "}
        {estimateLabel(bookRemaining, readingSpeed)}
      </span>
      {/* The readout pops as it changes: progress arriving silently next to
          buttons that all respond reads as frozen, not as steady. */}
      <motion.span
        key={Math.round(progress * 100)}
        data-reader-progress
        initial={{ opacity: 0.35 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="text-text-3 text-xs tabular-nums"
      >
        {Math.round(progress * 100)}%
      </motion.span>
      <GlassButton
        variant="subtle"
        size="sm"
        onClick={() => onStepChapter(1)}
        disabled={chapterIdx >= total - 1}
      >
        下一章 <CaretRight size={14} />
      </GlassButton>
      <span className="text-text-3 text-xs">{paged ? "← → 翻页" : "← → 翻章"}</span>
    </>
  );
}
