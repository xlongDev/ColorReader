import { shortcutMatches, type KeyStroke, type Shortcut } from "@/lib/commands";
import { rulerStepForKey } from "@/features/reader/ReadingRuler";

/**
 * The reader's own keys, as one table.
 *
 * These are not global hotkeys and are deliberately not registered as such:
 * what a key means here depends on what the reader is showing — the arrows turn
 * pages in a paged layout and step chapters in the scrolled one, Left/Right
 * belong to the band while the reading ruler is on, and the lightbox takes the
 * keyboard away entirely while it is up. The command registry's `shortcut`
 * means "this key, anywhere", so binding them there would both fire them
 * outside the reader and make their meaning depend on registration order.
 *
 * What the registry would give them is an id and a title, and those are here:
 * `id` is the handle a rebind panel will write against, and every entry in
 * `READER_KEYS` is one of them.
 *
 * This file is pure — no React, no DOM — because the handler it replaced was
 * 105 lines of branching inside a 2,700-line component with no test of its own.
 * `ReaderPage` now builds a context, resolves a press, and turns the id into a
 * call; everything about *which* key does *what* is asserted in
 * `readerKeys.test.ts`.
 */

/** Stable ids for the reader's keys. */
export type ReaderKeyId =
  | "reader.lightbox.close"
  | "reader.lightbox.next"
  | "reader.lightbox.prev"
  | "reader.dismiss"
  | "reader.ruler.forward"
  | "reader.ruler.back"
  | "reader.page.next"
  | "reader.page.prev"
  | "reader.turn.right"
  | "reader.turn.left"
  | "reader.chapter.next"
  | "reader.chapter.prev";

/** Everything the reader's key gates read — all of it live render state. */
export interface ReaderKeyContext {
  /** The image lightbox is up, so it owns the keyboard. */
  readonly lightboxOpen: boolean;
  /** The reading ruler is on, so the arrows step the band. */
  readonly rulerOn: boolean;
  /** Paged layout, as opposed to a continuous scroll. */
  readonly paged: boolean;
  /** Vertical type, where the page turns run the other way. */
  readonly readsLeftward: boolean;
}

export interface ReaderKeyBinding {
  readonly id: ReaderKeyId;
  /** What the key does — for the palette and, later, the rebind panel. */
  readonly title: string;
  /** The keys that can reach this action, in the order they are offered. */
  readonly keys: readonly Shortcut[];
  /** Whether the press is this binding's, given what the reader is showing.
   *  Absent means always. */
  readonly when?: (ctx: ReaderKeyContext, stroke: KeyStroke) => boolean;
  /** Runs even with the caret in a text field.
   *
   *  Only the floating surfaces and Escape: a lookup closes on Escape, and the
   *  search drawer's own input is where the reader is when they press it. */
  readonly inEditable?: boolean;
  /** Leaves the key's own action alone as well.
   *
   *  Escape is the only one, and it has to be: the browser build asks for the
   *  real Fullscreen API, so Esc leaving fullscreen is the browser doing it —
   *  stopping the key would strand the reader in a fullscreen page with no way
   *  out but the header button. */
  readonly keepDefault?: boolean;
}

const ESC: Shortcut = { key: "Escape" };
const LEFT: Shortcut = { key: "ArrowLeft" };
const RIGHT: Shortcut = { key: "ArrowRight" };
const UP: Shortcut = { key: "ArrowUp" };
const DOWN: Shortcut = { key: "ArrowDown" };
const PAGE_UP: Shortcut = { key: "PageUp" };
const PAGE_DOWN: Shortcut = { key: "PageDown" };
/** A pedal that presents as a clicker, or as a remote. */
const NEXT_TRACK: Shortcut = { key: "MediaTrackNext" };
const PREV_TRACK: Shortcut = { key: "MediaTrackPrevious" };
const SPACE: Shortcut = { key: " " };

/** The image lightbox is modal: while it is up it owns the keyboard.
 *
 *  That used to be an early return in the handler; here it is a second table,
 *  so "nothing else may claim a key" cannot be forgotten one binding at a time.
 */
const LIGHTBOX_KEYS: readonly ReaderKeyBinding[] = [
  {
    id: "reader.lightbox.close",
    title: "关闭图片",
    keys: [ESC],
    inEditable: true,
  },
  {
    id: "reader.lightbox.next",
    title: "下一张图",
    keys: [RIGHT],
    inEditable: true,
  },
  {
    id: "reader.lightbox.prev",
    title: "上一张图",
    keys: [LEFT],
    inEditable: true,
  },
];

/** Everything the reader answers while no modal surface is up.
 *
 *  Order is the whole of the precedence rule: the first binding whose keys
 *  match and whose gate passes takes the press, so a narrower gate has to come
 *  first. `reader.dismiss` is the clearest case — Escape is always its key, so
 *  it has to sit above nothing that also wants Escape (nothing does), and the
 *  ruler has to sit above the page turns it shares Left/Right with.
 */
const READING_KEYS: readonly ReaderKeyBinding[] = [
  {
    id: "reader.dismiss",
    title: "关闭浮层",
    keys: [ESC],
    inEditable: true,
    keepDefault: true,
  },
  {
    id: "reader.ruler.forward",
    title: "标尺前进一行",
    keys: [DOWN, RIGHT],
    // `rulerStepForKey` already owns the whole question of which key steps the
    // band and which way: it answers 0 for Left/Right in vertical type, where
    // those keys are the page turns the reader already knows, and the turn
    // binding below then takes them.
    when: (ctx, stroke) =>
      ctx.rulerOn && rulerStepForKey(stroke.key, ctx.readsLeftward || !ctx.paged) === 1,
  },
  {
    id: "reader.ruler.back",
    title: "标尺后退一行",
    keys: [UP, LEFT],
    when: (ctx, stroke) =>
      ctx.rulerOn && rulerStepForKey(stroke.key, ctx.readsLeftward || !ctx.paged) === -1,
  },
  {
    id: "reader.page.next",
    title: "下一页",
    keys: [PAGE_DOWN, NEXT_TRACK, SPACE],
    // Space and the media keys are claimed only where they do nothing else: in
    // the scrolled layout the browser's own Space and PageDown are right.
    when: (ctx) => ctx.paged,
  },
  {
    id: "reader.page.prev",
    title: "上一页",
    keys: [PAGE_UP, PREV_TRACK],
    when: (ctx) => ctx.paged,
  },
  // The two arrow turns are named after the key, not after the direction: in
  // vertical type the same key turns the other way (that is the dispatcher's
  // business, not the table's), and the key is the thing a rebind panel edits.
  {
    id: "reader.turn.right",
    title: "向右翻页",
    keys: [RIGHT],
    when: (ctx) => ctx.paged,
  },
  {
    id: "reader.turn.left",
    title: "向左翻页",
    keys: [LEFT],
    when: (ctx) => ctx.paged,
  },
  {
    id: "reader.chapter.next",
    title: "下一章",
    keys: [RIGHT],
    when: (ctx) => !ctx.paged,
  },
  {
    id: "reader.chapter.prev",
    title: "上一章",
    keys: [LEFT],
    when: (ctx) => !ctx.paged,
  },
];

/** Every binding, for the panel that will list them. */
export const READER_KEYS: readonly ReaderKeyBinding[] = [...LIGHTBOX_KEYS, ...READING_KEYS];

/** Which of the reader's keys a press is, or `null` when it is nobody's. */
export function resolveReaderKey(
  stroke: KeyStroke,
  ctx: ReaderKeyContext,
): ReaderKeyBinding | null {
  for (const binding of ctx.lightboxOpen ? LIGHTBOX_KEYS : READING_KEYS) {
    if (!binding.keys.some((key) => shortcutMatches(stroke, key))) continue;
    if (binding.when && !binding.when(ctx, stroke)) continue;
    return binding;
  }
  return null;
}
