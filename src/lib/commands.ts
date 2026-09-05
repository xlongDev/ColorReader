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
  /** The action itself. May return a promise; errors are surfaced to the user. */
  readonly run: () => void | Promise<void>;
}

export type Shortcut = {
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly key: string;
};

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
