import { Suspense, useEffect, type CSSProperties } from "react";
import { Outlet, useLocation } from "react-router-dom";
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
import { readerGlassVars, resolveSurface } from "@/features/reader/theme";
import { useCommandPalette } from "@/stores/command-palette";
import { useSettings } from "@/stores/settings";
import { useReaderSettings } from "@/stores/reader";
import { useChrome } from "@/stores/chrome";
import { useResolvedTheme } from "@/hooks/useTheme";
import { useHotkeys } from "@/hooks/useHotkeys";
import { registerCoreCommands, useNavigationBridge } from "@/features/command/registerCoreCommands";

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
              {/* Cross-fade between pages: the outgoing view holds its ground
                  while the incoming one resolves from a soft blur — a depth
                  cue that suits pane-style navigation more than vertical
                  motion. pathname keys keep the reader route stable across
                  chapter navigations (query-only changes). */}
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={pathname}
                  initial={reduce ? false : { opacity: 0, scale: 0.985, filter: "blur(6px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={reduce ? undefined : { opacity: 0, scale: 0.99, filter: "blur(4px)" }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="h-full"
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </Suspense>
          </ErrorBoundary>
        </GlassPanel>
      </div>
      <CommandPalette />
    </div>
  );
}
