import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  Books,
  ClockCounterClockwise,
  Star,
  Tag,
  GearSix,
  MagnifyingGlass,
  Moon,
  Sun,
  Monitor,
  SidebarSimple,
  Command as CommandIcon,
} from "@phosphor-icons/react";

import type { Command } from "@/lib/commands";
import { useCommandStore } from "@/stores/commands";
import { useSettings, type ThemeMode } from "@/stores/settings";
import { createLogger, describeError } from "@/lib/log";
import { desktopQuery, ipc } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";
import type { BookSummary } from "@/types/ipc";

const log = createLogger("commands");

interface Deps {
  openPalette: () => void;
}

const PALETTE = { mod: true, key: "k" } as const;
const SIDEBAR = { mod: true, key: "b" } as const;
const PREFERENCES = { mod: true, key: "," } as const;

export function registerCoreCommands({ openPalette }: Deps): () => void {
  const commands: Command[] = [
    paletteCommand(openPalette),
    continueReadingCommand(),
    searchCommand(),
    sidebarCommand(),
    ...themeCommands(),
    ...navigationCommands(),
    settingsCommand(),
  ];
  useCommandStore.getState().register(commands);
  log.debug("core commands registered", { count: commands.length });
  return () => useCommandStore.getState().unregister(commands.map((c) => c.id));
}

function paletteCommand(open: () => void): Command {
  return {
    id: "app.palette",
    title: "打开命令面板",
    description: "搜索动作或跳转视图",
    group: "应用",
    icon: <CommandIcon size={16} />,
    shortcut: [PALETTE],
    run: open,
  };
}

/**
 * Opens the book the reader last had open.
 *
 * "Recent" is the backend's own filter (`last_read_at IS NOT NULL`) sorted by
 * the same timestamp, so the first row is the one to resume — no progress
 * heuristics on this side.
 */
function continueReadingCommand(): Command {
  return {
    id: "book.continue",
    title: "继续阅读",
    description: "打开最近在读的那本书",
    group: "书籍",
    icon: <BookOpen size={16} />,
    keywords: ["continue", "resume", "继续", "接着读", "最近阅读"],
    run: async () => {
      try {
        const recent = await desktopQuery<BookSummary[]>([], () =>
          ipc.bookList({ filter: "recent", sort: "recentlyRead" }),
        )();
        const next = recent[0];
        if (!next) {
          showToast("error", "还没有在读的书");
          return;
        }
        navigateTo(`/reader?book=${next.id}`);
      } catch (error) {
        showToast("error", describeError(error).message);
      }
    },
  };
}

function searchCommand(): Command {
  return {
    ...navCommand("/search", "全文检索", "search", <MagnifyingGlass size={16} />),
    description: "在所有已导入的书籍正文里查找",
    keywords: ["search", "find", "搜索", "检索", "全文"],
  };
}

function sidebarCommand(): Command {
  return {
    id: "view.toggleSidebar",
    title: "切换侧边栏",
    description: "收起或展开左侧导航",
    group: "视图",
    icon: <SidebarSimple size={16} />,
    shortcut: [SIDEBAR],
    run: () => useSettings.getState().toggleSidebar(),
  };
}

function themeCommand(mode: ThemeMode, title: string, icon: ReactNode): Command {
  return {
    id: `theme.${mode}`,
    title,
    description: "立刻切换应用外观",
    group: "外观",
    icon,
    run: () => useSettings.getState().setTheme(mode),
  };
}

function themeCommands(): Command[] {
  return [
    themeCommand("light", "切换到浅色", <Sun size={16} />),
    themeCommand("dark", "切换到深色", <Moon size={16} />),
    themeCommand("system", "跟随系统", <Monitor size={16} />),
  ];
}

function navigationCommands(): Command[] {
  return [
    navCommand("/", "书库", "home", <Books size={16} />),
    navCommand("/recent", "最近", "recent", <ClockCounterClockwise size={16} />),
    navCommand("/favorites", "收藏", "favorites", <Star size={16} />),
    navCommand("/tags", "标签", "tags", <Tag size={16} />),
  ];
}

function settingsCommand(): Command {
  return {
    ...navCommand("/settings", "打开设置", "settings", <GearSix size={16} />),
    description: "外观、界面行为与运行环境信息",
    keywords: ["settings", "preferences", "设置", "偏好"],
    shortcut: [PREFERENCES],
  };
}

function navCommand(to: string, title: string, id: string, icon: ReactNode): Command {
  return {
    id: `nav.${id}`,
    title,
    group: "导航",
    icon,
    run: () => navigateTo(to),
  };
}

/** The event a command dispatches to reach the router. Commands live outside
    React (the registry is a plain store), so navigation goes through the
    window rather than through a hook. */
const NAVIGATE_EVENT = "colorreader:navigate";

/** Sends the shell to a route from anywhere, including outside React. */
export function navigateTo(to: string): void {
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: to }));
}

/** Bridge between the command registry and React Router. Mount once near the root. */
export function useNavigationBridge(): void {
  const navigate = useNavigate();
  useEffect(() => {
    function onNav(event: Event) {
      const target = event as CustomEvent<string>;
      if (typeof target.detail === "string") navigate(target.detail);
    }
    window.addEventListener(NAVIGATE_EVENT, onNav as EventListener);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNav as EventListener);
  }, [navigate]);
}
