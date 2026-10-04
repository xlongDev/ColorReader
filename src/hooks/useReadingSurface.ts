import { useMemo } from "react";

import { pageIsNight, useReaderSettings } from "@/stores/reader";

import { resolveSurface, type ReadingSurface } from "@/features/reader/theme";
import { useResolvedTheme } from "./useTheme";

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
export function useReadingSurface(): ReadingSurface {
  const pageTheme = useReaderSettings((state) => state.pageTheme);
  const nightSurface = useReaderSettings((state) => state.nightSurface);
  const daySurface = useReaderSettings((state) => state.surface);
  const customSurface = useReaderSettings((state) => state.customSurface);
  const appTheme = useResolvedTheme();
  return useMemo(
    () =>
      resolveSurface(
        // The page palette is the reader's own choice, not the app theme's: see
        // `pageTheme` in the reader store. `null` keeps the old coupling.
        pageIsNight(pageTheme, appTheme === "dark") ? nightSurface : daySurface,
        customSurface,
      ),
    [pageTheme, nightSurface, daySurface, customSurface, appTheme],
  );
}
