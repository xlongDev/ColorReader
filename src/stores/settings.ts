import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ShelfGroup } from "@/features/library/group";
import type { LibraryFilter } from "@/features/library/shelfQuery";
import type { LibrarySort } from "@/types/ipc";

export type ThemeMode = "system" | "light" | "dark";
export type TransparencyMode = "full" | "reduced";
export type ShelfLayout = "grid" | "list";

/**
 * How one shelf is arranged — the search, order, direction, grouping and label
 * its controls are standing on.
 *
 * One record per filter rather than one set of controls for the whole shelf:
 * the four shelves are four ways of looking at the same library, and sorting
 * 最近 by 最近阅读 should not silently re-order 书库 behind the reader.
 *
 * `descending` is the effective direction, not a flip of the order's own. The
 * backend returns each order in its own direction — 最近添加 descending, 书名
 * ascending — and the button has to say which way the list on screen actually
 * reads, so the flip is derived from it instead of stored (see `LibraryPage`).
 */
export interface ShelfView {
  search: string;
  sort: LibrarySort;
  descending: boolean;
  group: ShelfGroup;
  /** The label the 标签 shelf is narrowed to; `null` for the whole shelf. */
  tag: string | null;
}

export type ShelfViews = Record<LibraryFilter, ShelfView>;

/** The note list's own two controls: what it is narrowed to, and how. */
export interface NotesView {
  query: string;
  /** `noted` keeps only the highlights that carry a note of their own. */
  filter: "all" | "noted";
}

/**
 * Which sources the 词典 popup asks at once. The local chain — the platform
 * dictionary and the imported bundles — is one switch because one command
 * answers for both; the web sources and the AI fallback are their own.
 * 维基词典 and 维基百科 ship on (key-free and instant), Urban Dictionary off —
 * it is a network source of a very particular flavour, and readest ships its
 * network sources off too.
 */
export interface LookupSources {
  local: boolean;
  wiktionary: boolean;
  wikipedia: boolean;
  urban: boolean;
  ai: boolean;
}

interface SettingsState {
  theme: ThemeMode;
  transparency: TransparencyMode;
  sidebarCollapsed: boolean;
  sidebarHidden: boolean;
  /** Per-reader shelf density; `grid` is the cover-on-top tiles the app
   *  shipped with, `list` is a single-column row per book. */
  shelfLayout: ShelfLayout;
  /** Each shelf's arrangement, kept across a trip into the reader — which
   *  unmounts the shelf — and across a restart. */
  shelfViews: ShelfViews;
  /** The same for the notes page, which is unmounted just the same way when a
   *  highlight is followed back into its book. */
  notesView: NotesView;
  /** 词典 popup: which sources answer, at what size, and whether the term is
   *  spoken when the panel opens. */
  lookupSources: LookupSources;
  dictFontSize: number;
  dictAutoSpeak: boolean;
  setTheme: (mode: ThemeMode) => void;
  setTransparency: (mode: TransparencyMode) => void;
  toggleSidebar: () => void;
  setSidebarHidden: (hidden: boolean) => void;
  setShelfLayout: (layout: ShelfLayout) => void;
  setShelfView: (filter: LibraryFilter, patch: Partial<ShelfView>) => void;
  setNotesView: (patch: Partial<NotesView>) => void;
  setLookupSources: (patch: Partial<LookupSources>) => void;
  setDictFontSize: (size: number) => void;
  setDictAutoSpeak: (on: boolean) => void;
}

const shelfView = (sort: LibrarySort): ShelfView => ({
  search: "",
  sort,
  // Both shipping orders come back from the backend descending, so an
  // untouched shelf reads newest-first.
  descending: true,
  group: "none",
  tag: null,
});

/**
 * Every app preference at its shipping value, for the same reason the reader
 * store has one — `resetAllSettings` writes this back rather than keeping a
 * parallel list of defaults.
 */
export const DEFAULT_SETTINGS = {
  theme: "system",
  transparency: "full",
  sidebarCollapsed: false,
  sidebarHidden: false,
  shelfLayout: "grid",
  // 最近 is the shelf a reader opens to *carry on*, so its order is the one
  // that answers that: the book opened last is first. Everywhere else the
  // shelf is a library, and a library reads newest-added first.
  shelfViews: {
    all: shelfView("recentlyAdded"),
    recent: shelfView("recentlyRead"),
    favorites: shelfView("recentlyAdded"),
    tags: shelfView("recentlyAdded"),
  },
  notesView: { query: "", filter: "all" },
  lookupSources: { local: true, wiktionary: true, wikipedia: true, urban: false, ai: true },
  dictFontSize: 14,
  dictAutoSpeak: false,
} satisfies Partial<SettingsState>;

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setTheme: (theme) => set({ theme }),
      setTransparency: (transparency) => set({ transparency }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarHidden: (sidebarHidden) => set({ sidebarHidden }),
      setShelfLayout: (shelfLayout) => set({ shelfLayout }),
      setShelfView: (filter, patch) =>
        set((state) => ({
          shelfViews: {
            ...state.shelfViews,
            [filter]: { ...state.shelfViews[filter], ...patch },
          },
        })),
      setNotesView: (patch) => set((state) => ({ notesView: { ...state.notesView, ...patch } })),
      setLookupSources: (patch) =>
        set((state) => ({ lookupSources: { ...state.lookupSources, ...patch } })),
      setDictFontSize: (dictFontSize) =>
        set({ dictFontSize: Math.min(Math.max(Math.round(dictFontSize), 12), 20) }),
      setDictAutoSpeak: (dictAutoSpeak) => set({ dictAutoSpeak }),
    }),
    {
      name: "colorreader.settings",
      // Not bumped: the merge is shallow, so a payload written before
      // `shelfViews` existed simply keeps the default above. Bumping without a
      // `migrate` would instead throw every stored preference away.
      version: 1,
    },
  ),
);
