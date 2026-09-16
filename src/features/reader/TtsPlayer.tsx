import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BookOpen,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  Check,
  Gauge,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  Timer,
  X,
} from "@phosphor-icons/react";

import { IconSwap } from "@/components/motion/IconSwap";
import { cn } from "@/lib/cn";

import { reloadEdgeVoices } from "./edge";
import { formatClock, queuePosition, speechSeconds, unitAtChar, type SpeechUnit } from "./speech";
import { useSpeechVoices, type SpeechStatus } from "./tts";
import {
  DEFAULT_VOICE_NAME,
  bookLangVoices,
  defaultVoice,
  defaultVoiceMissing,
  languageName,
  voiceGroups,
} from "./voice";
import { EASE_OUT, SPRING } from "@/lib/motion";

/**
 * The read-aloud player: a pill docked above the footer while a session runs,
 * expanding into a card with the transport, a sentence scrubber, and the three
 * settings readest puts behind its transport row (speed, voice, sleep timer).
 *
 * Both surfaces are the same card at two sizes, so the reader never loses the
 * voice's position or the controls they were using. Neither takes a modal: the
 * page stays readable and selectable underneath, which is the whole point of
 * listening to a book you are also looking at.
 */

/** Rates the speed view offers, in picker order. */
const SPEECH_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Sleep-timer choices. */
const SLEEP_MINUTES = [5, 15, 30, 60] as const;

/** What the sleep timer will do when it fires. */
export type SleepTimer =
  { kind: "minutes"; minutes: number; endsAt: number } | { kind: "chapter" } | null;

/** A sleep-timer choice as the view reports it back. */
export type SleepChoice = "off" | "chapter" | number;

export interface TtsPlayerProps {
  /** Card open; the pill is governed by `status` instead. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  coverUrl: string | null;
  /** Chapter (prose) or section (Kindle) label under the title. */
  chapter: string;
  /** Utterances of the chapter or section being read. */
  units: readonly SpeechUnit[];
  /** The unit the voice is on; `null` before the first one starts. */
  index: number | null;
  status: SpeechStatus;
  /** Set when the last attempt to speak failed. Shown on the pill and in full
   *  in the card: a session that stops for no visible reason is the one
   *  failure a reader cannot act on. */
  error: string | null;
  /** True while the Edge engine is synthesising a clip it has no cache for —
   *  drawn as rising bars beside the sentence instead of a frozen clock. */
  loading: boolean;
  rate: number;
  onRate: (rate: number) => void;
  /** Chosen voice URI; `null` shows the default pick as selected. */
  voiceUri: string | null;
  onVoice: (uri: string) => void;
  /** BCP-47 tag of the book's language, or `null` when the book carries none.
   *  The voice picker leads with voices of this language, with a one-chip way
   *  out to the full catalogue. */
  bookLanguage: string | null;
  sleep: SleepTimer;
  onSleep: (choice: SleepChoice) => void;
  onToggle: () => void;
  onStop: () => void;
  /** One utterance. */
  onStep: (dir: 1 | -1) => void;
  /** One paragraph: the next unit belonging to a different source block. */
  onSkip: (dir: 1 | -1) => void;
  onSeek: (index: number) => void;
}

/** One tick a second. Never read during render: the countdown below is the
 *  only consumer, and it mounts only while a timer is armed, so an idle reader
 *  runs no clock at all. */
const subscribeTick = (onTick: () => void) => {
  const id = window.setInterval(onTick, 1000);
  return () => window.clearInterval(id);
};

const snapshotSecond = () => Math.floor(Date.now() / 1000);

/** Cross-fade shared by the card's view switches. Opacity only, no travel:
 *  the card's height change is animated by the root's `layout` spring, and a
 *  `y` offset here just makes the content swim inside a moving box. */
const VIEW_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};

/** Three rising bars: the service is synthesising and the voice has nothing to
 *  say yet. Reduced motion holds a low, steady bar — the movement carries no
 *  information the label does not. */
function LoadingBars({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  return (
    <output
      className={cn("inline-flex h-3 shrink-0 items-end gap-[3px]", className)}
      aria-label="正在加载语音"
    >
      {[0, 1, 2].map((bar) => (
        <motion.span
          key={bar}
          className="bg-accent h-3 w-[3px] origin-bottom rounded-full"
          initial={{ scaleY: 0.3 }}
          animate={reduce ? undefined : { scaleY: [0.3, 1, 0.3] }}
          transition={
            reduce
              ? undefined
              : { duration: 0.9, repeat: Infinity, ease: "easeInOut", delay: bar * 0.18 }
          }
        />
      ))}
    </output>
  );
}

/** `m:ss` left before `endsAt`, ticking. */
function Countdown({ endsAt }: { endsAt: number }) {
  const second = useSyncExternalStore(subscribeTick, snapshotSecond);
  return <>{formatClock(Math.max(0, endsAt / 1000 - second))}</>;
}

/** Cover thumbnail, falling back to a glyph when the book has no artwork. */
function Cover({ url, className }: { url: string | null; className?: string }) {
  if (url) {
    return <img src={url} alt="" draggable={false} className={cn("object-cover", className)} />;
  }
  return (
    <span className={cn("bg-surface-2 text-text-3 grid place-items-center", className)}>
      <BookOpen size={14} />
    </span>
  );
}

function Transport({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="press text-text-2 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-8 place-items-center rounded-full"
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "press focus-visible:focus-ring shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium",
        active ? "bg-accent text-on-accent" : "text-text-2 hover:text-text-1 bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

/** One of the three tiles at the foot of the card. Each is its own card rather
 *  than a column under one rule: the row used to read as a single flat strip
 *  with three labels, and the tap targets were impossible to see. */
function SettingsRow({
  icon,
  label,
  caption,
  onClick,
}: {
  icon: ReactNode;
  label: ReactNode;
  caption: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press bg-surface-2 hover:bg-surface-3 focus-visible:focus-ring flex flex-1 flex-col items-center gap-1 rounded-md px-1 py-2"
    >
      <span className="text-text-2">{icon}</span>
      <span className="text-text-1 max-w-full truncate text-[12px] font-medium">{label}</span>
      <span className="text-text-3 text-[11px]">{caption}</span>
    </button>
  );
}

/** Label for the sleep row: what the timer will do, in three words or less. */
const sleepLabel = (sleep: SleepTimer): ReactNode => {
  if (!sleep) return "关闭";
  if (sleep.kind === "chapter") return "本章结束";
  return <Countdown endsAt={sleep.endsAt} />;
};

export function TtsPlayer({
  open,
  onOpenChange,
  title,
  coverUrl,
  chapter,
  units,
  index,
  status,
  error,
  loading,
  rate,
  onRate,
  voiceUri,
  onVoice,
  bookLanguage,
  sleep,
  onSleep,
  onToggle,
  onStop,
  onStep,
  onSkip,
  onSeek,
}: TtsPlayerProps) {
  const reduce = useReducedMotion();
  const { voices, edgeError } = useSpeechVoices();
  const [view, setView] = useState<"main" | "speed" | "voice" | "timer">("main");
  // Adjust during render: a freshly opened card starts on the transport, not
  // wherever it was left, and the first paint must already show it.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setView("main");
  }

  // Esc closes the card. It is not modal, so nothing else claims the key while
  // it is open; the reader's own shortcuts are behind this listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const active = useMemo(() => defaultVoice(voices, voiceUri), [voices, voiceUri]);
  // A book in a known language leads the picker with that language's voices;
  // `null` from `bookLangVoices` (no tag, or nothing in the catalogue) means
  // the full list — an empty picker helps no one.
  const bookVoices = useMemo(() => bookLangVoices(voices, bookLanguage), [voices, bookLanguage]);
  const [allLangs, setAllLangs] = useState(false);
  const shownVoices = bookVoices !== null && !allLangs ? bookVoices : voices;
  const groups = useMemo(() => voiceGroups(shownVoices), [shownVoices]);
  const missingDefault = useMemo(() => defaultVoiceMissing(voices), [voices]);

  const { spoken, total } = queuePosition(units, index);
  const elapsed = speechSeconds(spoken, rate);
  const remaining = speechSeconds(total - spoken, rate);
  const percent = total > 0 ? Math.round((spoken / total) * 100) : 0;
  const scrolled = percent > 0 && percent < 100;

  // The scrollable sentence list the reference player reads from: the active
  // sentence glides to the middle of the stack, and any sentence clicked becomes
  // the one being read. Reduced motion jumps instead of gliding.
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    const row = index === null ? undefined : rowRefs.current.get(index);
    const list = listRef.current;
    if (!row || !list) return;
    const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: reduce ? "auto" : "smooth" });
  }, [index, reduce]);

  // The sleep timer's custom minutes, kept as text while it is being typed —
  // prefilled from a non-preset timer already running, blank otherwise.
  const [customMinutes, setCustomMinutes] = useState(() =>
    sleep?.kind === "minutes" && !SLEEP_MINUTES.some((preset) => preset === sleep.minutes)
      ? String(sleep.minutes)
      : "",
  );
  const isCustomSleep =
    sleep?.kind === "minutes" && !SLEEP_MINUTES.some((preset) => preset === sleep.minutes);
  const applyCustomSleep = () => {
    const minutes = Math.round(Number(customMinutes));
    if (!Number.isFinite(minutes) || minutes < 1) return;
    onSleep(Math.min(minutes, 720));
  };

  return (
    <>
      <AnimatePresence>
        {(status !== "idle" || error !== null) && !open && (
          <motion.div
            key="tts-pill"
            className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center px-4"
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0, y: 12 }}
            transition={SPRING.panel}
          >
            <div className="glass-solid pointer-events-auto relative flex w-[min(92vw,380px)] items-center gap-2.5 overflow-hidden rounded-full py-1.5 pr-2 pl-1.5">
              {/* The cover opens the card too: a target this obvious should not
                  be dead surface when the title beside it already opens. */}
              <button
                type="button"
                onClick={() => onOpenChange(true)}
                aria-label="展开朗读播放器"
                className="press focus-visible:focus-ring shrink-0 rounded-xs"
              >
                <Cover url={coverUrl} className="shadow-panel size-8 rounded-md" />
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(true)}
                aria-label="展开朗读播放器"
                className="focus-visible:focus-ring min-w-0 flex-1 rounded-xs text-left"
              >
                <p className="text-text-1 truncate text-[12px] font-medium">
                  {title}
                  {chapter !== "" && <span className="text-text-3"> · {chapter}</span>}
                </p>
                <p className="text-text-3 truncate text-[11px] tabular-nums">
                  {error ?? (
                    <>
                      {loading ? (
                        <LoadingBars />
                      ) : (
                        <>
                          {status === "paused" ? "已暂停 · " : ""}
                          {formatClock(elapsed)} · -{formatClock(remaining)}
                        </>
                      )}
                    </>
                  )}
                </p>
              </button>
              <Transport label="上一句" onClick={() => onStep(-1)}>
                <SkipBack size={14} weight="fill" />
              </Transport>
              <button
                type="button"
                aria-label={status === "playing" ? "暂停" : "继续"}
                onClick={onToggle}
                className="bg-accent text-on-accent focus-visible:focus-ring grid size-9 shrink-0 place-items-center rounded-full transition-opacity hover:opacity-90"
              >
                <IconSwap state={status}>
                  {status === "playing" ? (
                    <Pause size={15} weight="fill" />
                  ) : (
                    <Play size={15} weight="fill" />
                  )}
                </IconSwap>
              </button>
              <Transport label="下一句" onClick={() => onStep(1)}>
                <SkipForward size={14} weight="fill" />
              </Transport>
              <Transport label="停止朗读" onClick={onStop}>
                <X size={14} weight="bold" />
              </Transport>
              {/* Position, drawn on the pill's own bottom edge: the narrowest
                  honest progress readout for a bar this short. */}
              {scrolled && (
                <span
                  aria-hidden
                  className="bg-accent absolute inset-x-0 bottom-0 h-0.5 origin-left"
                  style={{ transform: `scaleX(${percent / 100})` }}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            key="tts-card"
            className="pointer-events-none absolute inset-x-0 top-5 bottom-5 z-40 flex items-end justify-center px-4"
            initial={reduce ? { opacity: 1 } : { opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 1 } : { opacity: 0, y: 16 }}
            transition={SPRING.panel}
          >
            {/* Capped, not `max-h-full`: a card free to grow fills the reading
                viewport and the page behind it stops being worth looking at.
                Sentence stack and voice list both take what is left of the cap.
                `layout`: the four views are different heights, and the swap
                used to jump between them — the spring carries the card from
                one height to the next instead. */}
            <motion.div
              layout
              transition={SPRING.panel}
              className="glass-solid pointer-events-auto relative flex max-h-[min(68vh,520px)] w-[min(92vw,420px)] flex-col overflow-hidden rounded-lg p-4"
            >
              <header className="flex items-start gap-3">
                <IconSwap state={view} className="size-11 shrink-0">
                  {view === "main" ? (
                    <Cover url={coverUrl} className="shadow-panel size-11 rounded-md" />
                  ) : (
                    <button
                      type="button"
                      aria-label="返回"
                      onClick={() => setView("main")}
                      className="text-text-2 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-11 place-items-center rounded-sm transition-colors"
                    >
                      <CaretLeft size={16} weight="bold" />
                    </button>
                  )}
                </IconSwap>
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="text-text-1 truncate text-[13.5px] font-medium">{title}</p>
                  <p className="text-text-3 mt-0.5 truncate text-[11px]">
                    {chapter !== "" ? chapter : "朗读"}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="收起播放器"
                  onClick={() => onOpenChange(false)}
                  className="text-text-3 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-7 shrink-0 place-items-center rounded-full transition-colors"
                >
                  <X size={14} weight="bold" />
                </button>
              </header>

              {/* The sentence stack, readest-style: one row per unit, the voice's
                  row kept mid-list by the scroll effect above, any row clicked
                  becoming the one read. The highlight is a shared-layout element,
                  so it glides from row to row as the voice moves. */}
              <AnimatePresence mode="popLayout" initial={false}>
                {view === "main" && (
                  <motion.div key="main" className="flex min-h-0 flex-1 flex-col" {...VIEW_FADE}>
                    {error !== null && (
                      <p className="text-text-2 mt-3 text-[12px] leading-relaxed">{error}</p>
                    )}
                    <div
                      ref={listRef}
                      className="scroll-fade relative mt-3 min-h-0 flex-1 overflow-y-auto"
                      aria-live="polite"
                    >
                      {units.length === 0 ? (
                        <p className="text-text-3 px-2 py-1.5 text-[13px] leading-relaxed">
                          选一段开始朗读
                        </p>
                      ) : (
                        units.map((unit, i) => {
                          const isActive = i === index;
                          return (
                            <button
                              key={`${unit.source}:${unit.start}`}
                              type="button"
                              ref={(el) => {
                                if (el === null) rowRefs.current.delete(i);
                                else rowRefs.current.set(i, el);
                              }}
                              onClick={() => onSeek(i)}
                              aria-current={isActive || undefined}
                              className={cn(
                                // The gap between the line being read and the
                                // rest is spacing and weight, never opacity:
                                // the dim tier is already at 5.3:1 on the
                                // darkest card, and a fade takes it under AA.
                                "relative flex w-full items-start gap-2 rounded-sm px-2 text-left leading-relaxed transition-colors",
                                isActive
                                  ? "text-text-1 py-2 text-[13.5px] font-medium"
                                  : "text-text-3 hover:bg-surface-2 hover:text-text-2 py-1 text-[13px]",
                              )}
                            >
                              {isActive && (
                                <motion.span
                                  layoutId="tts-active-sentence"
                                  aria-hidden
                                  className="absolute inset-0 rounded-sm bg-(--accent-soft)"
                                  transition={reduce ? { duration: 0 } : SPRING.layout}
                                />
                              )}
                              <span className="relative flex-1">{unit.text}</span>
                              {isActive && loading && <LoadingBars className="mt-1" />}
                            </button>
                          );
                        })
                      )}
                    </div>

                    <div className="text-text-3 mt-3 flex items-center gap-3 text-[11px] tabular-nums">
                      <span>{formatClock(elapsed)}</span>
                      <input
                        type="range"
                        className="range flex-1"
                        min={0}
                        max={Math.max(total, 1)}
                        value={spoken}
                        disabled={units.length < 2}
                        aria-label="朗读进度"
                        onChange={(event) => onSeek(unitAtChar(units, Number(event.target.value)))}
                        style={{ "--range-fill": `${percent}%` } as CSSProperties}
                      />
                      <span>-{formatClock(remaining)}</span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Transport sits outside the view switch: tuning the rate or
                  picking a voice is something you do *while listening*, and the
                  old drill-down took play/pause away with the text. */}
              <div className="mt-2.5 flex items-center justify-center gap-2.5">
                <Transport label="上一段" onClick={() => onSkip(-1)}>
                  <CaretDoubleLeft size={15} weight="bold" />
                </Transport>
                <Transport label="上一句" onClick={() => onStep(-1)}>
                  <SkipBack size={15} weight="fill" />
                </Transport>
                <button
                  type="button"
                  aria-label={status === "playing" ? "暂停" : "播放"}
                  onClick={onToggle}
                  className="bg-accent text-on-accent focus-visible:focus-ring mx-1 grid size-12 place-items-center rounded-full transition-opacity hover:opacity-90"
                >
                  <IconSwap state={status}>
                    {status === "playing" ? (
                      <Pause size={19} weight="fill" />
                    ) : (
                      <Play size={19} weight="fill" />
                    )}
                  </IconSwap>
                </button>
                <Transport label="下一句" onClick={() => onStep(1)}>
                  <SkipForward size={15} weight="fill" />
                </Transport>
                <Transport label="下一段" onClick={() => onSkip(1)}>
                  <CaretDoubleRight size={15} weight="bold" />
                </Transport>
              </div>

              <AnimatePresence mode="popLayout" initial={false}>
                {view === "main" && (
                  <motion.div key="main" className="mt-3 flex gap-1.5" {...VIEW_FADE}>
                    <SettingsRow
                      icon={<Gauge size={16} />}
                      label={`${rate}×`}
                      caption="语速"
                      onClick={() => setView("speed")}
                    />
                    <SettingsRow
                      icon={<SpeakerHigh size={16} />}
                      label={active?.name ?? "默认"}
                      caption={active?.engine === "edge" ? "在线语音" : "语音"}
                      onClick={() => setView("voice")}
                    />
                    <SettingsRow
                      icon={<Timer size={16} />}
                      label={sleepLabel(sleep)}
                      caption="定时关闭"
                      onClick={() => setView("timer")}
                    />
                  </motion.div>
                )}
                {view === "speed" && (
                  <motion.div key="speed" className="mt-3 flex flex-wrap gap-1.5" {...VIEW_FADE}>
                    {SPEECH_RATES.map((value) => (
                      <Chip key={value} active={value === rate} onClick={() => onRate(value)}>
                        {value}×
                      </Chip>
                    ))}
                  </motion.div>
                )}
                {view === "voice" && (
                  // The picker is the one view that replaces a scroll of prose
                  // with a scroll of choices, so it announces itself: the whole
                  // block rises in, then the language switch and the list
                  // follow a beat later. Height, as always, is the card's
                  // layout spring — nothing here moves on the y axis of the
                  // card itself.
                  <motion.div
                    key="voice"
                    className="mt-3 flex min-h-0 flex-1 flex-col"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.26, ease: EASE_OUT }}
                  >
                    {edgeError !== null ? (
                      <p className="text-text-3 mb-2 text-[12px] leading-relaxed">
                        {edgeError}
                        <button
                          type="button"
                          onClick={reloadEdgeVoices}
                          className="focus-visible:focus-ring text-accent ml-1 underline"
                        >
                          重试
                        </button>
                      </p>
                    ) : (
                      missingDefault && (
                        <p className="text-text-3 mb-2 text-[12px] leading-relaxed">
                          没有找到 {DEFAULT_VOICE_NAME}，朗读会用下面选中的语音；连上网络即可使用
                          Edge 在线语音里的 {DEFAULT_VOICE_NAME}。
                        </p>
                      )
                    )}
                    {/* The book's language against the whole catalogue. Only
                      rendered when the book carries a language the catalogue
                      can speak — otherwise there is nothing to switch. */}
                    {bookVoices !== null && (
                      <motion.div
                        className="mb-2 flex gap-1.5"
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.24, ease: EASE_OUT, delay: 0.08 }}
                      >
                        <Chip active={!allLangs} onClick={() => setAllLangs(false)}>
                          {languageName(bookLanguage ?? "")}
                        </Chip>
                        <Chip active={allLangs} onClick={() => setAllLangs(true)}>
                          全部语言
                        </Chip>
                      </motion.div>
                    )}
                    {/* One scroll, two headings deep: the engine, then the language.
                      The engine is the one thing the two sources cannot be merged
                      on — only the service needs a connection — and the language
                      has to stay visible while its own voices scroll, which a
                      horizontal strip of chips cannot do (it scrolls the language
                      you are on out of sight while its voices stay put). Both
                      headings are one fixed row tall, so the second can stick
                      directly beneath the first. */}
                    <motion.div
                      className="border-hairline min-h-0 flex-1 overflow-y-auto border-t"
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.28, ease: EASE_OUT, delay: 0.14 }}
                    >
                      {groups.map((group) => (
                        <div key={group.engine}>
                          <p className="bg-surface-2 text-text-2 sticky top-0 flex h-6 items-center px-2 text-[11px] font-medium">
                            {group.label}
                          </p>
                          {group.sections.map((section) => (
                            <div key={section.lang}>
                              <p className="bg-surface-3 text-text-3 sticky top-6 flex h-6 items-center px-2 text-[11px]">
                                {section.label}
                              </p>
                              {section.voices.map((voice) => (
                                <button
                                  key={voice.uri}
                                  type="button"
                                  onClick={() => onVoice(voice.uri)}
                                  className={cn(
                                    "press focus-visible:focus-ring hover:bg-surface-2 flex w-full items-center gap-2 rounded-xs px-2 py-2 text-left",
                                    voice.uri === active?.uri && "text-accent",
                                  )}
                                >
                                  <span className="text-text-1 flex-1 truncate text-[12px]">
                                    {voice.name}
                                  </span>
                                  {/* The service tags nearly every voice
                                    "General"; the label only earns its row
                                    when it actually tells voices apart. */}
                                  {voice.categories !== "" && voice.categories !== "General" && (
                                    <span className="text-text-3 shrink-0 text-[11px]">
                                      {voice.categories}
                                    </span>
                                  )}
                                  {voice.uri === active?.uri && <Check size={13} weight="bold" />}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      ))}
                    </motion.div>
                  </motion.div>
                )}
                {view === "timer" && (
                  <motion.div key="timer" className="mt-3 space-y-3" {...VIEW_FADE}>
                    <div>
                      <p className="text-text-3 px-1 pb-1.5 text-[11px] font-medium">常用</p>
                      <div className="flex flex-wrap gap-1.5">
                        <Chip active={sleep === null} onClick={() => onSleep("off")}>
                          关闭
                        </Chip>
                        {SLEEP_MINUTES.map((minutes) => (
                          <Chip
                            key={minutes}
                            active={sleep?.kind === "minutes" && sleep.minutes === minutes}
                            onClick={() => onSleep(minutes)}
                          >
                            {minutes} 分钟
                          </Chip>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="text-text-3 px-1 pb-1.5 text-[11px] font-medium">其他</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Chip active={sleep?.kind === "chapter"} onClick={() => onSleep("chapter")}>
                          本章结束
                        </Chip>
                        {/* Custom minutes: type a number, Enter or 开始 arms it.
                            A form, so the keyboard comes for free. The armed
                            state is a ring, not the accent fill — the input has
                            to stay readable on whatever it sits on. */}
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            applyCustomSleep();
                          }}
                          className={cn(
                            "bg-surface-2 focus-within:ring-accent flex shrink-0 items-center gap-1 rounded-full py-1 pr-1 pl-3.5 focus-within:ring-1",
                            isCustomSleep && "ring-accent ring-1",
                          )}
                        >
                          <input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={720}
                            value={customMinutes}
                            onChange={(event) => setCustomMinutes(event.target.value)}
                            placeholder="自定义"
                            aria-label="自定义定时分钟数"
                            className="text-text-1 placeholder:text-text-3 w-11 [appearance:textfield] bg-transparent text-center text-[12px] outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                          />
                          <span className="text-text-3 text-[12px]">分钟</span>
                          <button
                            type="submit"
                            className="press bg-accent text-on-accent focus-visible:focus-ring rounded-full px-2.5 py-1 text-[12px] font-medium"
                          >
                            开始
                          </button>
                        </form>
                      </div>
                    </div>
                    <p className="text-text-3 text-[12px] leading-relaxed">
                      {sleep === null ? (
                        "到点自动停止朗读，适合睡前听。"
                      ) : sleep.kind === "chapter" ? (
                        "读完当前章节后停止。"
                      ) : (
                        <>
                          还剩 <Countdown endsAt={sleep.endsAt} /> 停止朗读。
                        </>
                      )}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
