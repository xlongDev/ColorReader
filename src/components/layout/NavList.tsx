import { NavLink } from "react-router-dom";
import type { Icon } from "@phosphor-icons/react";
import {
  Books,
  ClockCounterClockwise,
  MagnifyingGlass,
  Star,
  Tag,
  GearSix,
  CaretLeft,
  CaretRight,
  ArrowLineLeft,
} from "@phosphor-icons/react";

import { cn } from "@/lib/cn";
import { useSettings } from "@/stores/settings";
import { GlassIconButton } from "@/components/glass/button";
import { useCommandPalette } from "@/stores/command-palette";

interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
}

const ITEMS: NavItem[] = [
  { to: "/", label: "书库", icon: Books, end: true },
  { to: "/recent", label: "最近", icon: ClockCounterClockwise },
  { to: "/favorites", label: "收藏", icon: Star },
  { to: "/tags", label: "标签", icon: Tag },
  { to: "/search", label: "搜索", icon: MagnifyingGlass },
];

const ROW = cn(
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px]",
  "border border-transparent transition-colors",
  "focus-visible:focus-ring",
);

function rowState(isActive: boolean): string {
  return isActive
    ? "bg-accent-soft text-text-1"
    : "text-text-2 hover:bg-surface-1 hover:text-text-1";
}

export function NavList() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  return (
    <nav className="flex flex-col gap-0.5 px-1" aria-label="主导航">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          // Collapsed rail keeps the label for assistive tech and as a native
          // tooltip; dropping the node entirely left the icon with no name.
          title={collapsed ? item.label : undefined}
          className={({ isActive }) => cn(ROW, rowState(isActive))}
        >
          {({ isActive }) => (
            <>
              <item.icon size={18} weight={isActive ? "fill" : "regular"} />
              <span className={collapsed ? "sr-only" : undefined}>{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function Footer() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const toggle = useSettings((s) => s.toggleSidebar);
  const hide = useSettings((s) => s.setSidebarHidden);
  const openPalette = useCommandPalette((s) => s.setOpen);
  return (
    <div className="flex flex-col gap-1">
      <NavLink
        to="/settings"
        title={collapsed ? "设置" : undefined}
        className={({ isActive }) => cn(ROW, rowState(isActive))}
      >
        {({ isActive }) => (
          <>
            <GearSix size={18} weight={isActive ? "fill" : "regular"} />
            <span className={collapsed ? "sr-only" : undefined}>设置</span>
          </>
        )}
      </NavLink>
      <div className="mt-1 flex items-center gap-1">
        <GlassIconButton label="切换侧边栏" size="sm" onClick={toggle} className="flex-1">
          {collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}
        </GlassIconButton>
        {!collapsed && (
          <>
            <GlassIconButton
              label="隐藏侧边栏"
              size="sm"
              onClick={() => hide(true)}
              className="flex-1"
            >
              <ArrowLineLeft size={16} />
            </GlassIconButton>
            <GlassIconButton
              label="打开命令面板"
              size="sm"
              onClick={() => openPalette(true)}
              className="flex-1"
            >
              <span className="font-mono text-[11px]">⌘K</span>
            </GlassIconButton>
          </>
        )}
      </div>
    </div>
  );
}

NavList.Footer = Footer;
