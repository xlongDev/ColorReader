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
