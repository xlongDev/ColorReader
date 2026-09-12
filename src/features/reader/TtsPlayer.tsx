import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  BookOpen,
  CaretLeft,
  CaretRight,
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
      className="text-text-2 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-8 place-items-center rounded-full transition-colors"
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
        "focus-visible:focus-ring shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
        active ? "bg-accent text-on-accent" : "text-text-2 hover:text-text-1 bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

/** One of the three rows at the foot of the card. */
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
      className="hover:bg-surface-2 focus-visible:focus-ring flex flex-1 flex-col items-center gap-1 rounded-sm py-2 transition-colors"
    >
      <span className="text-text-2">{icon}</span>
      <span className="text-text-1 max-w-full truncate text-[11.5px] font-medium">{label}</span>
      <span className="text-text-3 text-[10px]">{caption}</span>
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
  const current = index === null ? undefined : units[index];
  const scrolled = percent > 0 && percent < 100;

  // The row of dim text the reference player puts above and below the line
  // being read — the same three-line window, clamped to its neighbours.
  const neighbours = useMemo(() => {
    if (index === null) return { before: "", after: "" };
    return {
      before: units[index - 1]?.text ?? "",
      after: units[index + 1]?.text ?? "",
    };
  }, [units, index]);

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
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
          >
            <div className="glass-solid pointer-events-auto relative flex w-[min(92vw,380px)] items-center gap-2.5 overflow-hidden rounded-full py-1.5 pr-2 pl-1.5">
              <Cover url={coverUrl} className="size-8 shrink-0 rounded-xs" />
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
                <p className="text-text-3 truncate text-[10.5px] tabular-nums">
                  {error ?? (
                    <>
                      {status === "paused" ? "已暂停 · " : ""}
                      {formatClock(elapsed)} · -{formatClock(remaining)}
                    </>
                  )}
                </p>
              </button>
              <Transport label="上一句" onClick={() => onStep(-1)}>
                <CaretLeft size={14} weight="bold" />
              </Transport>
              <button
                type="button"
                aria-label={status === "playing" ? "暂停" : "继续"}
                onClick={onToggle}
                className="bg-accent text-on-accent focus-visible:focus-ring grid size-8 shrink-0 place-items-center rounded-full transition-opacity hover:opacity-90"
              >
                {status === "playing" ? (
                  <Pause size={13} weight="fill" />
                ) : (
                  <Play size={13} weight="fill" />
                )}
              </button>
              <Transport label="下一句" onClick={() => onStep(1)}>
                <CaretRight size={14} weight="bold" />
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
            transition={{ type: "spring", stiffness: 360, damping: 34 }}
          >
            {/* `max-h-full` against a bounded wrapper: the voice list grows
                with the platform's catalogue, and a card taller than the
                reading viewport used to have its last rows cut off. */}
            <div className="glass-solid pointer-events-auto flex max-h-full w-[min(92vw,420px)] flex-col overflow-hidden rounded-lg p-4">
              <header className="flex items-start gap-3">
                {view === "main" ? (
                  <Cover url={coverUrl} className="size-11 shrink-0 rounded-sm" />
                ) : (
                  <button
                    type="button"
                    aria-label="返回"
                    onClick={() => setView("main")}
                    className="text-text-2 hover:text-text-1 hover:bg-surface-2 focus-visible:focus-ring grid size-11 shrink-0 place-items-center rounded-sm transition-colors"
                  >
                    <CaretLeft size={16} weight="bold" />
                  </button>
                )}
                <div className="min-w-0 flex-1 pt-0.5">
                  <p className="text-text-1 truncate text-[13px] font-medium">{title}</p>
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

              {view === "main" ? (
                <>
                  {error !== null && (
                    <p className="text-text-2 mt-3 text-[11.5px] leading-relaxed">{error}</p>
                  )}
                  <div className="mt-3.5 space-y-1.5" aria-live="polite">
                    {neighbours.before !== "" && (
                      <p className="text-text-3 line-clamp-1 text-[12px] leading-relaxed">
                        {neighbours.before}
                      </p>
                    )}
                    <p className="text-text-1 line-clamp-3 text-[13.5px] leading-relaxed font-medium">
                      {current?.text ?? "选一段开始朗读"}
                    </p>
                    {neighbours.after !== "" && (
                      <p className="text-text-3 line-clamp-1 text-[12px] leading-relaxed">
                        {neighbours.after}
                      </p>
                    )}
                  </div>

                  <div className="text-text-3 mt-3.5 flex items-center gap-3 text-[11px] tabular-nums">
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

                  <div className="mt-2.5 flex items-center justify-center gap-1.5">
                    <Transport label="上一段" onClick={() => onSkip(-1)}>
                      <SkipBack size={15} weight="fill" />
                    </Transport>
                    <Transport label="上一句" onClick={() => onStep(-1)}>
                      <CaretLeft size={16} weight="bold" />
                    </Transport>
                    <button
                      type="button"
                      aria-label={status === "playing" ? "暂停" : "播放"}
                      onClick={onToggle}
                      className="bg-accent text-on-accent focus-visible:focus-ring mx-1 grid size-11 place-items-center rounded-full transition-opacity hover:opacity-90"
                    >
                      {status === "playing" ? (
                        <Pause size={17} weight="fill" />
                      ) : (
                        <Play size={17} weight="fill" />
                      )}
                    </button>
                    <Transport label="下一句" onClick={() => onStep(1)}>
                      <CaretRight size={16} weight="bold" />
                    </Transport>
                    <Transport label="下一段" onClick={() => onSkip(1)}>
                      <SkipForward size={15} weight="fill" />
                    </Transport>
                  </div>

                  <div className="border-hairline mt-3 flex gap-1 border-t pt-2">
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
                  </div>
                </>
              ) : view === "speed" ? (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {SPEECH_RATES.map((value) => (
                    <Chip key={value} active={value === rate} onClick={() => onRate(value)}>
                      {value}×
                    </Chip>
                  ))}
                </div>
              ) : view === "voice" ? (
                <div className="mt-3 flex min-h-0 flex-col">
                  {edgeError !== null ? (
                    <p className="text-text-3 mb-2 text-[11.5px] leading-relaxed">
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
                      <p className="text-text-3 mb-2 text-[11.5px] leading-relaxed">
                        没有找到 {DEFAULT_VOICE_NAME}，朗读会用下面选中的语音；连上网络即可使用 Edge
                        在线语音里的 {DEFAULT_VOICE_NAME}。
                      </p>
                    )
                  )}
                  {/* The book's language against the whole catalogue. Only
                      rendered when the book carries a language the catalogue
                      can speak — otherwise there is nothing to switch. */}
                  {bookVoices !== null && (
                    <div className="mb-2 flex gap-1.5">
                      <Chip active={!allLangs} onClick={() => setAllLangs(false)}>
                        {languageName(bookLanguage ?? "")}
                      </Chip>
                      <Chip active={allLangs} onClick={() => setAllLangs(true)}>
                        全部语言
                      </Chip>
                    </div>
                  )}
                  {/* One scroll, two headings deep: the engine, then the language.
                      The engine is the one thing the two sources cannot be merged
                      on — only the service needs a connection — and the language
                      has to stay visible while its own voices scroll, which a
                      horizontal strip of chips cannot do (it scrolls the language
                      you are on out of sight while its voices stay put). Both
                      headings are one fixed row tall, so the second can stick
                      directly beneath the first. */}
                  <div className="border-hairline min-h-0 flex-1 overflow-y-auto border-t">
                    {groups.map((group) => (
                      <div key={group.engine}>
                        <p className="bg-surface-2 text-text-2 sticky top-0 flex h-6 items-center px-2 text-[10.5px] font-medium">
                          {group.label}
                        </p>
                        {group.sections.map((section) => (
                          <div key={section.lang}>
                            <p className="bg-surface-3 text-text-3 sticky top-6 flex h-6 items-center px-2 text-[10.5px]">
                              {section.label}
                            </p>
                            {section.voices.map((voice) => (
                              <button
                                key={voice.uri}
                                type="button"
                                onClick={() => onVoice(voice.uri)}
                                className={cn(
                                  "focus-visible:focus-ring hover:bg-surface-2 flex w-full items-center gap-2 rounded-xs px-2 py-2 text-left transition-colors",
                                  voice.uri === active?.uri && "text-accent",
                                )}
                              >
                                <span className="text-text-1 flex-1 truncate text-[12.5px]">
                                  {voice.name}
                                </span>
                                {/* The service tags nearly every voice
                                    "General"; the label only earns its row
                                    when it actually tells voices apart. */}
                                {voice.categories !== "" && voice.categories !== "General" && (
                                  <span className="text-text-3 shrink-0 text-[10.5px]">
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
                  </div>
                </div>
              ) : (
                <div className="mt-4">
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
                    <Chip active={sleep?.kind === "chapter"} onClick={() => onSleep("chapter")}>
                      本章结束
                    </Chip>
                  </div>
                  <p className="text-text-3 mt-3 text-[11.5px] leading-relaxed">
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
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
