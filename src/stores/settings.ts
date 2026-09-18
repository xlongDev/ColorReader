import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "system" | "light" | "dark";
export type TransparencyMode = "full" | "reduced";
export type ShelfLayout = "grid" | "list";

interface SettingsState {
  theme: ThemeMode;
  transparency: TransparencyMode;
  sidebarCollapsed: boolean;
  sidebarHidden: boolean;
  /** Per-reader shelf density; `grid` is the cover-on-top tiles the app
   *  shipped with, `list` is a single-column row per book. */
  shelfLayout: ShelfLayout;
  setTheme: (mode: ThemeMode) => void;
  setTransparency: (mode: TransparencyMode) => void;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  setShelfLayout: (layout: ShelfLayout) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      transparency: "full",
      sidebarCollapsed: false,
      sidebarHidden: false,
      shelfLayout: "grid",
      setTheme: (theme) => set({ theme }),
      setTransparency: (transparency) => set({ transparency }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarHidden: (sidebarHidden) => set({ sidebarHidden }),
      setShelfLayout: (shelfLayout) => set({ shelfLayout }),
    }),
    {
      name: "colorreader.settings",
      version: 1,
    },
  ),
);
