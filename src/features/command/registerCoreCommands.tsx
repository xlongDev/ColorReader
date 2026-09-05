import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
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
import { createLogger } from "@/lib/log";

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
    run: () => {
      // imperative navigation requires the router; use a runtime-side dispatch
      window.dispatchEvent(new CustomEvent("colorreader:navigate", { detail: to }));
    },
  };
}

/** Bridge between the command registry and React Router. Mount once near the root. */
export function useNavigationBridge(): void {
  const navigate = useNavigate();
  useEffect(() => {
    function onNav(event: Event) {
      const target = event as CustomEvent<string>;
      if (typeof target.detail === "string") navigate(target.detail);
    }
    window.addEventListener("colorreader:navigate", onNav as EventListener);
    return () => window.removeEventListener("colorreader:navigate", onNav as EventListener);
  }, [navigate]);
}
