import { useMemo } from "react";

import { pageIsNight, useReaderSettings } from "@/stores/reader";

import { resolveSurface, type ReadingSurface } from "@/features/reader/theme";
import { useResolvedTheme } from "./useTheme";

/**
 * Whether the page is on its night axis right now — the reader's own 书页配色
 * against the app theme, resolved the one way.
 *
 * Extracted rather than re-derived at each call site because two questions
 * hang off it and they must never disagree: which paper to paint (`useReading-
 * Surface` below) and which axis a PDF renders on. A second copy of
 * `pageIsNight(pageTheme, appTheme === "dark")` written out by hand is the same
 * mistake the paper resolution already made once — see `QuoteCardDialog`'s
 * note. Follows `useReadingSurface`'s rule for a book's own value: `null` is a
 * real choice (跟随), so it is tested for rather than coalesced away.
 */
export function usePageIsNight(bookId?: string | null): boolean {
  const own = useReaderSettings((state) => (bookId ? state.byBook[bookId] : undefined));
  const globalPageTheme = useReaderSettings((state) => state.pageTheme);
  const pageTheme = own && "pageTheme" in own ? own.pageTheme! : globalPageTheme;
  const appTheme = useResolvedTheme();
  return pageIsNight(pageTheme, appTheme === "dark");
}

/**
 * The paper the reader is painting, resolved from the reader's own settings and
 * the app theme.
 *
 * A hook rather than an inline expression in `ReaderPage`, because the reader is
 * no longer the only thing that has to match the paper: the read-aloud pill is
 * chrome floating on the same page but mounted by the shell (see `TtsHost`), and
 * a second resolution written out by hand would eventually be a second answer.
 *
 * Safe to call from outside the reader — it reads settings, and settings exist
 * whether or not a page is on screen. What callers must *not* do is apply the
 * result away from the reader: this is the paper of a page that is not there.
 */
export function useReadingSurface(bookId?: string | null): ReadingSurface {
  const own = useReaderSettings((state) => (bookId ? state.byBook[bookId] : undefined));
  const globalNightSurface = useReaderSettings((state) => state.nightSurface);
  const globalDaySurface = useReaderSettings((state) => state.surface);
  const globalCustomSurface = useReaderSettings((state) => state.customSurface);
  // A book's own paper wins when it has one.
  const nightSurface = own?.nightSurface ?? globalNightSurface;
  const daySurface = own?.surface ?? globalDaySurface;
  const customSurface = own && "customSurface" in own ? own.customSurface! : globalCustomSurface;
  const night = usePageIsNight(bookId);
  return useMemo(
    () =>
      resolveSurface(
        // The page palette is the reader's own choice: `null` (跟随主题) is the
        // default and tracks the app theme, a pinned day/night overrides it —
        // see `pageTheme` in the reader store.
        night ? nightSurface : daySurface,
        customSurface,
      ),
    [night, nightSurface, daySurface, customSurface],
  );
}

/**
 * The paper of the book on screen, for chrome that has no book of its own —
 * the window's background and the read-aloud pill. Falls back to the app-wide
 * resolution when no reader is publishing (the shelf, the settings page).
 */
export function useActiveReadingSurface(): ReadingSurface {
  const published = useReaderSettings((state) => state.activeSurface);
  const fallback = useReadingSurface();
  return published ?? fallback;
}
