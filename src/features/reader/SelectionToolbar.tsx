import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  BookOpenText,
  Check,
  CopySimple,
  GlobeHemisphereWest,
  GlobeSimple,
  Highlighter,
  MagnifyingGlass,
  Sparkle,
  SpeakerHigh,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useAiChat, useAiConfig } from "@/hooks/useAi";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import type { Annotation, AnnotationStyle } from "@/types/ipc";
import { HIGHLIGHT_COLORS } from "@/stores/reader";
import { inkWash } from "./selection";

/**
 * The floating toolbar a text selection opens (readest-style): the top row
 * acts on the selected text, the bottom row paints a highlight — one of three
 * styles in one of five inks. Tapping a style or a colour applies it at once,
 * so the reader can try combinations without re-selecting.
 *
 * With `annotation` set the toolbar edits an existing highlight instead: the
 * same bottom row restyles it in place and the top row gains a delete.
 */

type Props = {
  x: number;
  y: number;
  /** The highlight the reader tapped; set = edit mode. */
  annotation?: Annotation | null;
  /** Reader's last-used ink, so a fresh selection paints predictably. */
  defaultColor: string;
  defaultStyle: AnnotationStyle;
  onCopy: () => void;
  onSearch: () => void;
  onSpeak: () => void;
  onAsk: () => void;
  onLookup: (kind: LookupKind) => void;
  onHighlight: (color: string, style: AnnotationStyle) => void;
  onRestyle: (color: string, style: AnnotationStyle) => void;
  onDelete: () => void;
  onClose: () => void;
};

/** Viewport insets that keep the toolbar on screen (px). */
const EDGE = 12;
/** Approximate half-width, for clamping the centred anchor. */
const HALF = 190;
/** Approximate toolbar height (two rows), for the above/below flip. */
const HEIGHT = 92;

const STYLES: { key: AnnotationStyle; label: string }[] = [
  { key: "highlight", label: "背景高亮" },
  { key: "underline", label: "直线" },
  { key: "squiggly", label: "波浪线" },
];

export function SelectionToolbar({
  x,
  y,
  annotation,
  defaultColor,
  defaultStyle,
  onCopy,
  onSearch,
  onSpeak,
  onAsk,
  onLookup,
  onHighlight,
  onRestyle,
  onDelete,
  onClose,
}: Props) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);
  // The draft ink: what the next apply paints. Edit mode starts from the
  // highlight's own values, a fresh selection from the reader's last pick.
  const [color, setColor] = useState(annotation?.color ?? defaultColor);
  const [style, setStyle] = useState<AnnotationStyle>(annotation?.style ?? defaultStyle);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const apply = (nextColor: string, nextStyle: AnnotationStyle) => {
    if (annotation) onRestyle(nextColor, nextStyle);
    else onHighlight(nextColor, nextStyle);
  };

  const copy = () => {
    onCopy();
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  // Clamp: keep the panel over the page even near the edges, and flip below
  // the selection when there is no room above.
  const left = Math.min(Math.max(x, EDGE + HALF), window.innerWidth - EDGE - HALF);
  const above = y >= HEIGHT + EDGE + 8;
  const top = above ? y - HEIGHT - 8 : y + 24;

  const iconBtn =
    "text-text-1 hover:text-accent hover:bg-(--glass-btn) flex h-9 w-9 items-center justify-center rounded-xl transition-colors";

  return (
    <motion.div
      // Fixed like the old pill: the selection can sit inside a foliate
      // iframe's coordinate space, and the host window is the only frame both
      // rendering paths agree on.
      className="glass-solid shadow-panel fixed z-40 flex flex-col gap-1 rounded-2xl p-1.5"
      style={{ left, top, width: HALF * 2 }}
      initial={reduce ? false : { opacity: 0, scale: 0.92, y: above ? 6 : -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.95, y: 4 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
    >
      <div className="flex items-center justify-between gap-0.5">
        <button type="button" aria-label="复制" className={iconBtn} onClick={copy}>
          {copied ? <Check size={16} className="text-accent" /> : <CopySimple size={16} />}
        </button>
        <button
          type="button"
          aria-label="词典查询"
          className={iconBtn}
          onClick={() => onLookup("dict")}
        >
          <BookOpenText size={16} />
        </button>
        <button
          type="button"
          aria-label="翻译"
          className={iconBtn}
          onClick={() => onLookup("translate")}
        >
          <GlobeSimple size={16} />
        </button>
        <button
          type="button"
          aria-label="维基百科"
          className={iconBtn}
          onClick={() => onLookup("wiki")}
        >
          <GlobeHemisphereWest size={16} />
        </button>
        <button type="button" aria-label="在本书中搜索" className={iconBtn} onClick={onSearch}>
          <MagnifyingGlass size={16} />
        </button>
        <button
          type="button"
          aria-label="应用当前高亮"
          className={iconBtn}
          onClick={() => apply(color, style)}
        >
          <Highlighter size={16} />
        </button>
        <button type="button" aria-label="朗读此处" className={iconBtn} onClick={onSpeak}>
          <SpeakerHigh size={16} />
        </button>
        <button type="button" aria-label="问 AI" className={iconBtn} onClick={onAsk}>
          <Sparkle size={16} />
        </button>
        {annotation && (
          <button
            type="button"
            aria-label="取消标注"
            className={cn(iconBtn, "hover:text-red-400")}
            onClick={onDelete}
          >
            <Trash size={16} />
          </button>
        )}
        <button
          type="button"
          aria-label="关闭"
          className={cn(iconBtn, "text-text-3 h-7 w-7")}
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>

      {/* Ink row: styles left, colours right, mirroring the readest layout —
          the two axes of one choice, never stacked in each other's way. */}
      <div className="border-hairline flex items-center justify-between gap-2 border-t px-1 pt-1.5 pb-0.5">
        <div className="flex items-center gap-1">
          {STYLES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-label={label}
              onClick={() => {
                setStyle(key);
                apply(color, key);
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                style === key ? "text-text-1 bg-(--glass-btn)" : "text-text-3 hover:text-text-1",
              )}
            >
              <StyleSwatch style={key} color={color} />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          {HIGHLIGHT_COLORS.map(({ hex, label }) => (
            <button
              key={hex}
              type="button"
              aria-label={label}
              onClick={() => {
                setColor(hex);
                apply(hex, style);
              }}
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full transition-transform",
                color === hex ? "scale-110" : "hover:scale-105",
              )}
              style={
                color === hex
                  ? { boxShadow: `0 0 0 2px var(--glass-btn), 0 0 0 3.5px ${hex}` }
                  : undefined
              }
            >
              <span
                aria-hidden
                className="block h-3.5 w-3.5 rounded-full"
                style={{ backgroundColor: hex }}
              />
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

/** The style preview inside its button: a wash, a line, a wave — drawn at the
 *  ink's own colour so the swatch previews the combination, not just the shape. */
function StyleSwatch({ style: kind, color }: { style: AnnotationStyle; color: string }) {
  if (kind === "highlight") {
    return (
      <span
        aria-hidden
        className="block h-3.5 w-4 rounded-[4px]"
        style={{ backgroundColor: inkWash(color, 0.55) }}
      />
    );
  }
  if (kind === "underline") {
    return <span aria-hidden className="block w-4 border-t-2" style={{ borderColor: color }} />;
  }
  return (
    <svg aria-hidden viewBox="0 0 16 4" className="block h-1 w-4">
      <path d="M0 2 Q 2 0, 4 2 T 8 2 T 12 2 T 16 2" fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

/**
 * 词典 / 翻译 / 维基百科 popup, anchored where the toolbar was. 词典 streams
 * one AI answer; 翻译 uses DeepL when a key is configured (one fast round
 * trip) and the same AI stream otherwise; 维基百科 renders the article
 * summary from the REST API, no key needed.
 */

export type LookupKind = "dict" | "translate" | "wiki";

const DICT_PROMPT = (text: string) =>
  `解释下面的词或短语。若是外语，用简体中文给出音标、词性和释义，并附一个例句；若是中文，解释含义和常见用法。直接输出解释：\n\n${text}`;
const TRANSLATE_PROMPT = (text: string) =>
  `把下面的文本翻译成简体中文（若原文已是中文，则翻译成英文）。只输出译文：\n\n${text}`;

/** Renders the backend error the way a reader can act on it. */
function friendlyAiError(error: string): string {
  return error.includes("API") || error.length > 80
    ? "查询失败：请先在设置中配置 AI 服务。"
    : error;
}

export function QuickLookup({
  kind,
  text,
  x,
  y,
  onClose,
}: {
  kind: LookupKind;
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  if (kind === "wiki") return <WikiLookup text={text} x={x} y={y} onClose={onClose} />;
  if (kind === "translate") return <TranslateLookup text={text} x={x} y={y} onClose={onClose} />;
  return <AiLookup title="词典" prompt={DICT_PROMPT(text)} x={x} y={y} onClose={onClose} />;
}

/** Shared popup frame: title bar, scrollable body, anchored motion. */
function LookupPanel({
  title,
  x,
  y,
  onClose,
  children,
}: {
  title: string;
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotion();
  // Keep the panel over the page even near the edges.
  const PANEL_HALF = 190;
  const left = Math.min(Math.max(x, EDGE + PANEL_HALF), window.innerWidth - EDGE - PANEL_HALF);
  return (
    <motion.div
      className="glass-solid shadow-panel fixed z-40 flex max-h-80 w-[380px] flex-col overflow-hidden rounded-2xl"
      style={{ left, top: Math.max(y + 16, EDGE) }}
      initial={reduce ? false : { opacity: 0, scale: 0.95, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
    >
      <div className="border-hairline flex items-center justify-between border-b px-4 py-2">
        <p className="text-text-1 text-xs font-medium">{title}</p>
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="text-text-3 hover:text-text-1 transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      <div className="text-text-2 overflow-y-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
        {children}
      </div>
    </motion.div>
  );
}

/** One streamed AI answer; shared by 词典 and the AI fallback of 翻译. */
function AiLookup({
  title,
  prompt,
  x,
  y,
  onClose,
}: {
  title: string;
  prompt: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { text: answer, streaming, error, send, reset } = useAiChat();
  useEffect(() => {
    // Send on mount, reset on unmount — no "already started" guard: the first
    // run's cleanup clears the active request id, so the remount's second run
    // must re-send for the stream events to match anything.
    send([{ role: "user", content: prompt }]);
    return () => reset();
  }, [prompt, send, reset]);

  return (
    <LookupPanel title={title} x={x} y={y} onClose={onClose}>
      {error ? (
        <p className="text-text-3">{friendlyAiError(error)}</p>
      ) : (
        <>
          {answer}
          {streaming && <span className="text-accent animate-pulse">▍</span>}
          {!answer && !error && <span className="text-text-3">正在查询…</span>}
        </>
      )}
    </LookupPanel>
  );
}

/** 翻译 with a DeepL key: one fast round trip through the backend, no
 * streaming. Without a key the panel falls back to the AI path. */
function TranslateLookup({
  text,
  x,
  y,
  onClose,
}: {
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const { data: config, isPending } = useAiConfig();
  const hasDeepl = (config?.deeplKey ?? "").trim() !== "";
  const deepl = useQuery({
    queryKey: ["deepl", text],
    queryFn: () => ipc.lookupTranslate(text),
    enabled: !isPending && hasDeepl,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (isPending || hasDeepl) {
    return (
      <LookupPanel title="翻译" x={x} y={y} onClose={onClose}>
        {deepl.error ? (
          <p className="text-text-3">{String(deepl.error)}</p>
        ) : deepl.data ? (
          <>
            {deepl.data.text}
            {deepl.data.detectedLang && (
              <p className="text-text-3 mt-2 text-xs">检测语言：{deepl.data.detectedLang}</p>
            )}
          </>
        ) : (
          <span className="text-text-3">正在翻译…</span>
        )}
      </LookupPanel>
    );
  }
  return <AiLookup title="翻译" prompt={TRANSLATE_PROMPT(text)} x={x} y={y} onClose={onClose} />;
}

/** 维基百科: the article summary for the selected term. */
function WikiLookup({
  text,
  x,
  y,
  onClose,
}: {
  text: string;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["wikipedia", text],
    queryFn: () => ipc.wikipediaSummary(text),
    staleTime: 5 * 60_000,
    retry: false,
  });

  return (
    <LookupPanel title="维基百科" x={x} y={y} onClose={onClose}>
      {query.isPending ? (
        <span className="text-text-3">正在查阅…</span>
      ) : query.error ? (
        <p className="text-text-3">{String(query.error)}</p>
      ) : (
        query.data && (
          <div className="flex gap-3">
            {query.data.thumbnail && (
              <img
                src={query.data.thumbnail}
                alt=""
                className="h-20 w-20 shrink-0 rounded-xl object-cover"
              />
            )}
            <div className="min-w-0">
              <p className="text-text-1 text-sm font-semibold">{query.data.title}</p>
              <p className="mt-1 line-clamp-6">{query.data.extract}</p>
              <button
                type="button"
                className="text-accent mt-2 inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-80"
                onClick={() => void openUrl(query.data!.pageUrl)}
              >
                阅读完整词条 <ArrowSquareOut size={12} />
              </button>
            </div>
          </div>
        )
      )}
    </LookupPanel>
  );
}

/** Mount point shared by ReaderPage: toolbar or lookup, never both. */
export function SelectionOverlay(props: {
  toolbar: Props | null;
  lookup: { kind: LookupKind; text: string; x: number; y: number } | null;
  onLookupClose: () => void;
}) {
  return (
    <AnimatePresence>
      {props.toolbar && <SelectionToolbar key="toolbar" {...props.toolbar} />}
      {props.lookup && <QuickLookup key="lookup" {...props.lookup} onClose={props.onLookupClose} />}
    </AnimatePresence>
  );
}
