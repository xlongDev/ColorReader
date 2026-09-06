import { NavLink } from "react-router-dom";
import { motion } from "motion/react";
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
              {/* shrink-0: the always-in-layout nowrap label no longer fits
                  the collapsed rail, and flex would otherwise squeeze the
                  icon (svg min-width:auto = 0) down to nothing. */}
              <item.icon size={18} weight={isActive ? "fill" : "regular"} className="shrink-0" />
              {/* Always in layout, fading with the pane transition; nowrap so
                  the label overflows instead of re-wrapping mid-animation. */}
              <motion.span
                initial={false}
                animate={{ opacity: collapsed ? 0 : 1 }}
                transition={{ duration: collapsed ? 0.1 : 0.18, delay: collapsed ? 0 : 0.15 }}
                className="whitespace-nowrap"
              >
                {item.label}
              </motion.span>
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
            <GearSix size={18} weight={isActive ? "fill" : "regular"} className="shrink-0" />
            <motion.span
              initial={false}
              animate={{ opacity: collapsed ? 0 : 1 }}
              transition={{ duration: collapsed ? 0.1 : 0.18, delay: collapsed ? 0 : 0.15 }}
              className="whitespace-nowrap"
            >
              设置
            </motion.span>
          </>
        )}
      </NavLink>
      <div className="mt-1 flex items-center gap-1">
        <GlassIconButton label="切换侧边栏" size="sm" onClick={toggle} className="flex-1">
          {collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}
        </GlassIconButton>
        {/* Width+opacity so the extra actions ebb with the pane instead of
            popping; inert keeps the zero-width buttons out of tab order. */}
        <motion.div
          initial={false}
          inert={collapsed}
          className="flex min-w-0 gap-1 overflow-hidden"
          animate={{ width: collapsed ? 0 : "auto", opacity: collapsed ? 0 : 1 }}
          transition={{
            width: { duration: collapsed ? 0.1 : 0.2, delay: collapsed ? 0 : 0.15 },
            opacity: { duration: collapsed ? 0.1 : 0.15, delay: collapsed ? 0 : 0.15 },
          }}
        >
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
        </motion.div>
      </div>
    </div>
  );
}

NavList.Footer = Footer;
