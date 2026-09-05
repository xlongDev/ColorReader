import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "system" | "light" | "dark";
export type TransparencyMode = "full" | "reduced";

interface SettingsState {
  theme: ThemeMode;
  transparency: TransparencyMode;
  sidebarCollapsed: boolean;
  sidebarHidden: boolean;
  setTheme: (mode: ThemeMode) => void;
  setTransparency: (mode: TransparencyMode) => void;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: "system",
      transparency: "full",
      sidebarCollapsed: false,
      sidebarHidden: false,
      setTheme: (theme) => set({ theme }),
      setTransparency: (transparency) => set({ transparency }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarHidden: (sidebarHidden) => set({ sidebarHidden }),
    }),
    {
      name: "colorreader.settings",
      version: 1,
    },
  ),
);
