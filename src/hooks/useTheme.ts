import { useEffect, useState } from "react";

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
