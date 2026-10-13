import type { ReactNode } from "react";

/** A user visible action exposed through the keyboard, command palette and context menus. */
export interface Command {
  /** Stable identifier (used by tests and analytics). */
  readonly id: string;
  /** Heading shown in the palette list. */
  readonly title: string;
  /** Subtitle / hint shown beneath the title. */
  readonly description?: string;
  /** Logical bucket used for visual grouping in the palette. */
  readonly group: string;
  /** Extra search tokens, e.g. localized aliases. */
  readonly keywords?: readonly string[];
  /** Optional icon for the palette. */
  readonly icon?: ReactNode;
  /**
   * `mod` matches Ctrl on Win/Linux and Cmd on macOS.
   * Use lower case letters for key names (`k`, `f`, `p`).
   */
  readonly shortcut?: readonly Shortcut[];
  /** Returns `false` (and is hidden) when the action cannot run right now. */
  readonly isEnabled?: () => boolean;
  /**
   * Registered and bound, but not listed.
   *
   * For the command that opens the palette itself. `useHotkeys` discovers
   * shortcuts by walking this registry, so dropping the command would take ⌘K
   * with it — but listing it puts a command to open the palette in the first
   * row of the palette, which is the one thing nobody looking at it needs.
   */
  readonly hidden?: boolean;
  /** The action itself. May return a promise; errors are surfaced to the user. */
  readonly run: () => void | Promise<void>;
}

export type Shortcut = {
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly key: string;
};

/**
 * The reader's own bindings, keyed by command id.
 *
 * One flat record for both the registry's commands and the reader's key table,
 * because the two id spaces do not overlap (`app.*` / `nav.*` / `reader.*`) and
 * two records would mean two things to reset and two places for the settings
 * page to write.
 *
 * An id that is absent keeps its own default; there is no way to bind *nothing*
 * to an action, which is deliberate — a key with no default is a key the panel
 * would have to render as an empty slot.
 */
export type KeyOverrides = Readonly<Record<string, readonly Shortcut[]>>;

/** The keys something answers to, overrides included. */
export function effectiveKeys(
  id: string,
  fallback: readonly Shortcut[] | undefined,
  overrides: KeyOverrides,
): readonly Shortcut[] | undefined {
  return overrides[id] ?? fallback;
}

/**
 * `⌘ ⇧ K` — the one spelling of a shortcut.
 *
 * Shared so the palette and the settings panel cannot disagree about what is
 * bound; the panel's recorder writes through the same shape the matcher reads.
 * The named keys are spelled the way a keyboard prints them rather than as the
 * DOM names them, which is the whole reason this is not a blanket
 * `key.toUpperCase()`: `ARROWRIGHT` is not a key.
 */
export function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.mod) parts.push("⌘");
  if (shortcut.shift) parts.push("⇧");
  if (shortcut.alt) parts.push("⌥");
  parts.push(KEY_LABELS[shortcut.key.toLowerCase()] ?? keycap(shortcut.key));
  return parts.join(" ");
}

/** How a keycap prints the key.
 *
 *  A single character is a letter or a digit as the keyboard prints it —
 *  capitals — while a name of several characters is left as the DOM spells it
 *  rather than shouted (`F5`, not `F5`; `MediaTrackNext` was the old bug, and
 *  it has a label of its own anyway). */
function keycap(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** How a key is written on a keycap, for the ones a keycap cannot show. */
const KEY_LABELS: Record<string, string> = {
  " ": "空格",
  escape: "Esc",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  pageup: "PgUp",
  pagedown: "PgDn",
  mediatracknext: "媒体下一曲",
  mediatrackprevious: "媒体上一曲",
};

/**
 * The keys a recorder must not bind.
 *
 * A bare modifier is a key being *held* on the way to another one, so binding
 * it would make the next press ambiguous; `Dead` and `Unidentified` are what
 * an IME or an unmapped key reports, and neither names a key a reader could
 * press on purpose. Escape is not here — the recorder is what refuses it, so
 * that Escape can stay the way out of the recorder itself.
 */
const UNBINDABLE = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "AltGraph",
  "Dead",
  "Unidentified",
]);

/** The shortcut a press would bind, or `null` for a press that is not a key. */
export function shortcutFromStroke(stroke: KeyStroke): Shortcut | null {
  if (UNBINDABLE.has(stroke.key)) return null;
  const mod = stroke.metaKey || stroke.ctrlKey;
  // Modifiers are written only when they are on, so a recorded binding reads
  // like the hand-written defaults and survives a round trip through JSON.
  return {
    key: stroke.key,
    ...(mod ? { mod: true } : {}),
    ...(stroke.shiftKey ? { shift: true } : {}),
    ...(stroke.altKey ? { alt: true } : {}),
  };
}

/** One spelling per combination, so two bindings written differently still
 *  compare equal (`K` and `k`, `mod` and `meta`). */
function combinationId(shortcut: Shortcut): string {
  return [
    shortcut.mod ? "mod" : "",
    shortcut.shift ? "shift" : "",
    shortcut.alt ? "alt" : "",
    shortcut.key.toLowerCase(),
  ].join("+");
}

/** A combination more than one entry answers to. */
export interface SharedShortcut {
  /** The first spelling seen, for display. */
  readonly shortcut: Shortcut;
  readonly ids: readonly string[];
  readonly titles: readonly string[];
}

/**
 * The combinations that more than one entry answers to.
 *
 * Not a judgement — the reader's table has `ArrowRight` on two bindings on
 * purpose, and its gates are what sort them. It is here because a *global*
 * command has no gate to lose to, so a combination it shares with anything is
 * two actions on one press; the caller decides which of these it cares about.
 */
export function sharedShortcuts(
  entries: readonly { id: string; title: string; keys: readonly Shortcut[] }[],
): readonly SharedShortcut[] {
  // Keyed by id inside each combination: the question is "how many *entries*
  // answer to this", so one entry that happens to list a key twice is not a
  // clash with itself.
  const byCombination = new Map<string, { shortcut: Shortcut; titles: Map<string, string> }>();
  for (const entry of entries) {
    for (const key of entry.keys) {
      const id = combinationId(key);
      const found = byCombination.get(id) ?? { shortcut: key, titles: new Map<string, string>() };
      found.titles.set(entry.id, entry.title);
      byCombination.set(id, found);
    }
  }
  return [...byCombination.values()]
    .filter((entry) => entry.titles.size > 1)
    .map((entry) => ({
      shortcut: entry.shortcut,
      ids: [...entry.titles.keys()],
      titles: [...entry.titles.values()],
    }));
}

/** The parts of a keyboard event a shortcut can care about.
 *
 * Structural rather than `KeyboardEvent` so the matching can be exercised
 * without a DOM — the reader's key table is asserted against it directly. */
export interface KeyStroke {
  readonly key: string;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Whether a press is the shortcut.
 *
 * The modifier test is an equality, not a subset: a shortcut that says nothing
 * about Shift means "without Shift", so Shift+Space is not Space. Key names
 * compare case-insensitively, which is what makes `{ key: " " }` and the
 * `MediaTrack*` names work unchanged.
 */
export function shortcutMatches(stroke: KeyStroke, shortcut: Shortcut): boolean {
  if (stroke.altKey !== !!shortcut.alt) return false;
  if (stroke.shiftKey !== !!shortcut.shift) return false;
  if ((stroke.metaKey || stroke.ctrlKey) !== !!shortcut.mod) return false;
  return stroke.key.toLowerCase() === shortcut.key.toLowerCase();
}

/**
 * Whether the press landed in a field that owns its own keys.
 *
 * A key arriving from inside the book's iframe carries a `null` target, which
 * is not an element and therefore not a field — the reader's keys keep working
 * over the page.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Subsequence + start bonus scoring. Returns `null` when nothing matched. */
export function scoreCommand(query: string, command: Command): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const haystack = [command.title, ...(command.keywords ?? [])].join(" ").toLowerCase();

  let qi = 0;
  let score = 0;
  let lastHit = -2;
  for (let i = 0; i < haystack.length && qi < q.length; i += 1) {
    if (haystack[i] !== q[qi]) continue;
    score += i === 0 ? 6 : i - lastHit === 1 ? 3 : 1;
    if (i === 0 || lastHit === i - 1) score += 2; // contiguous boost
    lastHit = i;
    qi += 1;
  }
  return qi === q.length ? score : null;
}
