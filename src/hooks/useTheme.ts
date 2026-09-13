import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { isDesktopRuntime } from "@/lib/ipc";
import { useSettings, type ThemeMode, type TransparencyMode } from "@/stores/settings";

const THEME_MEDIA = "(prefers-color-scheme: light)";

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia(THEME_MEDIA).matches ? "light" : "dark";
}

function applyTransparency(mode: TransparencyMode): void {
  document.documentElement.setAttribute("data-transparency", mode);
}

function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(mode));
}

/** Sync the settings store to the document, including live system changes. */
export function useTheme(): void {
  const theme = useSettings((state) => state.theme);
  const transparency = useSettings((state) => state.transparency);

  useEffect(() => {
    applyTheme(theme);
    const onSystem = () => {
      if (useSettings.getState().theme === "system") applyTheme("system");
    };
    const mql = window.matchMedia(THEME_MEDIA);
    mql.addEventListener("change", onSystem);
    return () => mql.removeEventListener("change", onSystem);
  }, [theme]);

  useEffect(() => {
    applyTransparency(transparency);
  }, [transparency]);

  // The webview's own appearance must follow the app theme, not the OS. A book
  // can ship `@media (prefers-color-scheme: dark)` rules — the one that started
  // this set a dark callout background — and that media query follows the window
  // appearance, which on desktop defaults to the OS. CSS cannot retarget it, so
  // with macOS in dark mode and the app in light a light-theme read still got
  // the book's night styles. `null` hands it back to the OS, so `system` still
  // tracks; a no-op in the browser build.
  useEffect(() => {
    if (!isDesktopRuntime) return;
    void getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch((cause: unknown) => console.warn("窗口外观同步失败", cause));
  }, [theme]);
}

/** The resolved light/dark appearance, reactive to both setting and system. */
export function useResolvedTheme(): "light" | "dark" {
  const mode = useSettings((state) => state.theme);
  const [sysLight, setSysLight] = useState(
    () => typeof window !== "undefined" && window.matchMedia(THEME_MEDIA).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(THEME_MEDIA);
    const onSystem = () => setSysLight(mql.matches);
    mql.addEventListener("change", onSystem);
    return () => mql.removeEventListener("change", onSystem);
  }, []);
  if (mode === "light" || mode === "dark") return mode;
  return sysLight ? "light" : "dark";
}
