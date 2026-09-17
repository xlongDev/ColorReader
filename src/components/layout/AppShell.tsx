import { Suspense, useEffect, useMemo, type CSSProperties } from "react";
import { useLocation, useOutlet } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CaretRight } from "@phosphor-icons/react";

import { TitleBar } from "@/components/layout/TitleBar";
import { NavList } from "@/components/layout/NavList";
import { CommandPalette } from "@/components/command/CommandPalette";
import { GlassSidebar } from "@/components/glass/sidebar";
import { GlassPanel } from "@/components/glass/panel";
import { GlassIconButton } from "@/components/glass/button";
import { Wordmark } from "@/components/brand/Wordmark";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { BookCoverFlight } from "@/components/motion/BookCoverFlight";
import { fontFaceCss, readerGlassVars, resolveSurface } from "@/features/reader/theme";
import { useCommandPalette } from "@/stores/command-palette";
import { useBookHandoff } from "@/stores/book-handoff";
import { useSettings } from "@/stores/settings";
import { useReaderSettings } from "@/stores/reader";
import { useChrome } from "@/stores/chrome";
import { useResolvedTheme } from "@/hooks/useTheme";
import { useDeepLink } from "@/hooks/useDeepLink";
import { useFonts } from "@/hooks/useFonts";
import { useHotkeys } from "@/hooks/useHotkeys";
import { registerCoreCommands, useNavigationBridge } from "@/features/command/registerCoreCommands";
import { DURATION, EASE_OUT, RISE } from "@/lib/motion";

// Sidebar content, shared verbatim by the docked pane and the fullscreen edge
// overlay — the overlay is the same sidebar the user already has, just
// summoned over the reading area.
function sidebarBody(collapsed: boolean) {
  return (
    <>
      {/* px-3 lands the mark's centre on the nav icons' centre line
          (12 pane + 12 row + 11 = 35), collapsed and expanded alike. */}
      <div className="flex items-center px-3 pt-1" data-tauri-drag-region>
        <Wordmark compact={collapsed} />
      </div>
      <NavList />
      <div className="mt-auto px-1">
        <NavList.Footer />
      </div>
    </>
  );
}

export function AppShell() {
  useHotkeys();
  useNavigationBridge();
  // Lives here rather than on the reader route: a link opens a book from
  // wherever the reader is, and /reader is not where it arrives.
  useDeepLink();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const sidebarHidden = useSettings((s) => s.sidebarHidden);
  const showSidebar = useSettings((s) => s.setSidebarHidden);
  const readerFullscreen = useChrome((s) => s.readerFullscreen);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const reduce = useReducedMotion();

  // While a book is open the whole window wears the reading surface: the
  // chrome palette (data-theme) pairs with the surface's light/dark mode and
  // the glass tokens re-root on its ink with the paper colour as the window
  // backdrop, so title bar, sidebar and panels read as one material with the
  // page. A manually picked night surface darkens the chrome even in a light
  // app theme, and vice versa.
  const { pathname } = useLocation();
  const reading = pathname.startsWith("/reader");

  /**
   * Whether a cover is in the air between the two pages right now.
   *
   * The arriving page then gives up its travel and only cross-fades. A cover in
   * flight is a shared element: the page it is flying to is moving while the
   * flight is trying to land on it, and a CSS transition whose target moves is
   * a transition that restarts — so the flight ends up chasing the page a frame
   * at a time instead of running its 420ms curve, and finishes wherever it was
   * when the chasing stopped. Opacity moves nothing, so the cross-fade stays.
   */
  const coverFlying = useBookHandoff((s) => s.id !== null);

  /**
   * The route element, resolved here rather than by an `<Outlet/>` in the tree.
   *
   * `AnimatePresence` keeps rendering the child it is sending out long after the
   * route has changed, and it renders *that element* again — so a nested
   * `<Outlet/>` re-resolves against the route that just arrived and the page on
   * its way out becomes a second copy of the page coming in. Measured: entering
   * the reader mounted two `ReaderPage`s in one commit, the spare unmounting
   * 229 ms later when the exit ended; the shelf did the same on the way back,
   * which is why a cover looked redrawn just after a flight landed — two copies
   * of the tile were cross-fading ten pixels apart.
   *
   * `useOutlet()` hands back the element already resolved, so the child
   * AnimatePresence holds on to keeps showing the page it is leaving.
   */
  const outlet = useOutlet();
  const appTheme = useResolvedTheme();
  const daySurface = useReaderSettings((s) => s.surface);
  const customSurface = useReaderSettings((s) => s.customSurface);
  const nightSurface = useReaderSettings((s) => s.nightSurface);
  const surface = resolveSurface(appTheme === "dark" ? nightSurface : daySurface, customSurface);
  const shellStyle = reading
    ? ({ ...readerGlassVars(surface), "--app-bg": surface.tint } as CSSProperties)
    : undefined;

  useEffect(() => {
    return registerCoreCommands({ openPalette: () => setOpen(true) });
  }, [setOpen]);

  const sidebarGone = sidebarHidden || readerFullscreen;

  // `@font-face` for the fonts the reader imported, declared once for the app
  // document. A book section is a document of its own and gets its own copy
  // with the injected sheet, but everything rendered *here* — the prose path,
  // the settings picker, the popup — needs this one. The empty list is inside
  // the memo so it cannot re-create the sheet on every render.
  const fonts = useFonts();
  const fontFaces = useMemo(() => fontFaceCss(fonts.data ?? []), [fonts.data]);

  // Navigating out of the reader ends the immersive chrome even if the OS
  // window is still fullscreen — the shell must never be left chrome-less.
  const setReaderFullscreen = useChrome((s) => s.setReaderFullscreen);
  useEffect(() => {
    if (!reading && readerFullscreen) setReaderFullscreen(false);
  }, [reading, readerFullscreen, setReaderFullscreen]);

  return (
    <div
      className="relative flex h-[100dvh] flex-col"
      data-theme={reading ? surface.mode : undefined}
      style={shellStyle}
    >
      <style>{fontFaces}</style>
      <div className="app-backdrop" />
      <div className="app-grain" />
      {!readerFullscreen && <TitleBar />}
      <div
        className={readerFullscreen ? "flex min-h-0 flex-1" : "flex min-h-0 flex-1 gap-3 px-3 pb-3"}
      >
        <GlassSidebar hidden={sidebarGone}>{sidebarBody(collapsed)}</GlassSidebar>
        {readerFullscreen && !sidebarHidden && (
          // Fullscreen: the sidebar docks off-canvas and slides in while the
          // pointer rests on the top or bottom strip of the left edge — the
          // middle band stays dead so the flip arrows keep working. It floats
          // with the same rounded corners as the docked pane, in the opaque
          // overlay material so it stays readable over bright pages on dark
          // surfaces. Honours 隐藏侧边栏: hidden means hidden here too.
          <div className="group/edge pointer-events-none absolute inset-y-0 left-0 z-50">
            {/* Explicit width: an absolutely positioned container with only
                absolute children is zero-width, and inset-x-0 strips inside it
                would be zero-width too — the regression that killed the
                summon gesture. */}
            <div className="pointer-events-auto absolute top-0 left-0 h-[30%] w-1.5" aria-hidden />
            <div
              className="pointer-events-auto absolute bottom-0 left-0 h-[30%] w-1.5"
              aria-hidden
            />
            <div className="pointer-events-auto absolute inset-y-0 left-0 my-3 flex -translate-x-full opacity-0 transition-all duration-200 ease-out group-hover/edge:translate-x-0 group-hover/edge:opacity-100 motion-reduce:transition-none">
              <GlassSidebar overlay hidden={false}>
                {sidebarBody(collapsed)}
              </GlassSidebar>
            </div>
          </div>
        )}
        {sidebarHidden && !readerFullscreen && (
          <GlassIconButton
            label="显示侧边栏"
            size="sm"
            onClick={() => showSidebar(false)}
            className="self-center"
          >
            <CaretRight size={16} />
          </GlassIconButton>
        )}
        {sidebarHidden && readerFullscreen && (
          // Fullscreen re-summon: the docked caret would sit mid-edge where
          // the flip arrow lives, so it docks into the quiet bottom-left
          // corner instead, clear of the footer hud and the flip arrows.
          <GlassIconButton
            label="显示侧边栏"
            size="sm"
            onClick={() => showSidebar(false)}
            className="glass-solid absolute bottom-10 left-3 z-30"
          >
            <CaretRight size={16} />
          </GlassIconButton>
        )}
        <GlassPanel
          className={
            readerFullscreen
              ? "min-w-0 flex-1 overflow-hidden rounded-none"
              : "min-w-0 flex-1 overflow-hidden"
          }
        >
          {/* Per-route boundary: a crashing feature page keeps the sidebar and
              the command palette alive so the user can navigate away. */}
          <ErrorBoundary scope="页面" bare>
            {/* Lazy route chunks resolve on first navigation; local disk,
                so a plain fallback is enough. */}
            <Suspense fallback={null}>
              {/* Cross-fade between pages: the outgoing view lifts away while
                  the incoming one rises into place, keyed on pathname so the
                  reader route stays stable across chapter navigations
                  (query-only changes). `popLayout` takes the leaving page out
                  of flow, so the arriving one is laid out at its final place
                  on the first frame rather than being pushed around by a page
                  that is already on its way out.

                  What this must not animate is anything that changes the
                  resolution of the page's raster, and both alternatives did:

                  1. It used to animate `filter: blur(6px)`, which re-rasterises
                     the whole layer every frame — the most expensive thing this
                     shell could animate, on every navigation. A `filter` — even
                     `blur(0px)` — also makes its element the containing block
                     for `position: fixed` descendants, and that resting value
                     is what put the reader's selection toolbar 273 px off and
                     sliced it at the pane edge.
                  2. It then carried the depth with `scale`, which has the same
                     cost for the same reason: a scaled subtree is rasterised at
                     the new resolution each frame. A reader page (composited
                     section iframes) and a shelf (a few hundred covers) are the
                     worst cases for it, and the reader -> shelf direction pays
                     it twice, on both pages at once.

                  A translate moves an already-rasterised layer, and 10px is the
                  vocabulary's own entrance travel (`RISE`), so the rise reads
                  as the same gesture as everything else that enters. At rest
                  motion normalises the offset away, so the wrapper is neither a
                  filter nor a transform and fixed overlays inside a page keep
                  the viewport as their containing block.

                  The one exception is a page arriving under a cover that is
                  already in the air: then the rise is dropped and only the
                  fade is kept, because that 10px of travel is exactly what
                  makes the flight miss (see `coverFlying`). */}
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={pathname}
                  initial={reduce ? false : coverFlying ? { opacity: 0 } : { opacity: 0, y: RISE }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={
                    reduce
                      ? undefined
                      : {
                          opacity: 0,
                          y: -RISE,
                          transition: { duration: DURATION.fast, ease: EASE_OUT },
                        }
                  }
                  // Leaving is quicker than arriving. Both pages are mounted for
                  // as long as the exit runs, and the page being left is the
                  // expensive one — the reader holds the whole book and its
                  // section iframes while the shelf mounts underneath it. A
                  // short exit cuts that overlap window roughly in half and
                  // reads as the new page taking over rather than two pages
                  // trading places; the arriving page keeps the house duration.
                  transition={{ duration: reduce ? 0 : DURATION.base, ease: EASE_OUT }}
                  className="h-full"
                >
                  {outlet}
                </motion.div>
              </AnimatePresence>
            </Suspense>
          </ErrorBoundary>
        </GlassPanel>
      </div>
      {/* Where the reader's floating overlays are portalled: the selection
          toolbar and the 词典/翻译 popup.

          A `backdrop-filter` makes its element the containing block for
          `position: fixed` descendants (as does a `filter` or a `transform`).
          The pane above carries one for the glass, and it also has
          `overflow: hidden` — so an overlay rendered inside it was positioned
          from the pane's own origin and then sliced by the pane's edge. The
          selection toolbar landed 273px right and 37px low, and lost its right
          end to the page edge.

          This host sits inside the shell, so the reading surface's tokens and
          `data-theme` still reach the overlays; everything portalled into it
          is `position: fixed`, so it takes no room in the column. */}
      <div data-overlay-host>
        {/* The cover carried from the shelf into the reader lives here, not in
            the reader: a route change blurs and scales the page it leaves, and
            an element inside that page would be dragged along with it. */}
        <BookCoverFlight />
      </div>
      <CommandPalette />
    </div>
  );
}
