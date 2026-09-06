import { Suspense, useEffect, type CSSProperties } from "react";
import { Outlet, useLocation } from "react-router-dom";
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

export function AppShell() {
  useHotkeys();
  useNavigationBridge();
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const sidebarHidden = useSettings((s) => s.sidebarHidden);
  const showSidebar = useSettings((s) => s.setSidebarHidden);
  const readerFullscreen = useChrome((s) => s.readerFullscreen);
  const setOpen = useCommandPalette((s) => s.setOpen);

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
        <GlassSidebar hidden={sidebarGone}>
          {/* px-3 lands the mark's centre on the nav icons' centre line
              (12 pane + 12 row + 11 = 35), collapsed and expanded alike. */}
          <div className="flex items-center px-3 pt-1" data-tauri-drag-region>
            <Wordmark compact={collapsed} />
          </div>
          <NavList />
          <div className="mt-auto px-1">
            <NavList.Footer />
          </div>
        </GlassSidebar>
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
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </GlassPanel>
      </div>
      <CommandPalette />
    </div>
  );
}
