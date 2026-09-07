import { NavLink, useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
  GithubLogo,
  Monitor,
  Moon,
  Sun,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { useSettings, type ThemeMode } from "@/stores/settings";
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
  const reduce = useReducedMotion();
  // Remounting on activation gives the fill/outline swap a springy pop.
  const iconSpring = {
    initial: reduce ? false : { scale: 0.6, opacity: 0.4 },
    animate: { scale: 1, opacity: 1 },
    transition: { type: "spring", stiffness: 360, damping: 24 },
  } as const;
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
              <motion.span key={String(isActive)} className="flex shrink-0" {...iconSpring}>
                <item.icon size={18} weight={isActive ? "fill" : "regular"} />
              </motion.span>
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

const THEME_OPTIONS: readonly { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

/** Quick appearance switcher for the sidebar footer.
 *
 * Expanded: a pill that leads with the settings glyph behind a hairline,
 * then three theme segments whose circular highlight springs between them
 * (shared layoutId). Collapsed: the rail is too narrow for the pill, so a
 * single button cycles the modes with an icon crossfade instead. */
function ThemeSwitch({ collapsed }: { collapsed: boolean }) {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const reduce = useReducedMotion();
  const navigate = useNavigate();

  if (collapsed) {
    const current = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0]!;
    const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(current) + 1) % THEME_OPTIONS.length]!;
    return (
      <div className="flex justify-center">
        <button
          type="button"
          title={`主题：${current.label}（点击切换为${next.label}）`}
          aria-label={`主题：${current.label}，点击切换为${next.label}`}
          onClick={() => setTheme(next.value)}
          className="text-text-3 hover:text-text-1 hover:bg-surface-1 flex h-8 w-8 items-center justify-center rounded-full transition-colors"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={current.value}
              initial={reduce ? false : { opacity: 0, scale: 0.5, rotate: -30 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.5, rotate: 30 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className="flex"
            >
              <current.icon size={16} />
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      {/* Full-width pill, p-0.5 + h-7 segments = h-8 total, matching the
          chrome row beneath; four flex-1 cells line up with its four buttons. */}
      <div className="glass flex w-full items-center rounded-full p-0.5">
        <button
          type="button"
          title="设置"
          aria-label="设置"
          onClick={() => navigate("/settings")}
          className="text-text-3 hover:text-text-1 flex h-7 flex-1 items-center justify-center rounded-full transition-colors duration-200"
        >
          <GearSix size={15} />
        </button>
        {/* Hairline separates the settings glyph from the theme segments. */}
        <div className="bg-hairline h-4 w-px shrink-0" aria-hidden="true" />
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme === value;
          return (
            <label
              key={value}
              title={label}
              className={cn(
                "relative flex h-7 flex-1 cursor-pointer items-center justify-center rounded-full transition-colors duration-200",
                "focus-within:focus-ring",
                active ? "text-text-1" : "text-text-3 hover:text-text-2",
              )}
            >
              <input
                type="radio"
                name="sidebar-theme"
                value={value}
                checked={active}
                onChange={() => setTheme(value)}
                className="sr-only"
              />
              {/* Shared-layout highlight: one stadium springs between the
                  three theme cells instead of each rendering its own. */}
              {active && (
                <motion.span
                  layoutId="sidebar-theme-pill"
                  className="bg-surface-3 shadow-glass absolute inset-0 rounded-full"
                  transition={
                    reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 35 }
                  }
                />
              )}
              <Icon size={15} weight={active ? "fill" : "regular"} className="relative" />
            </label>
          );
        })}
      </div>
    </div>
  );
}

/** Where the GitHub action points; the opener capability whitelists this URL. */
const REPO_URL = "https://github.com/xlongDev/ColorReader";

interface FooterAction {
  key: string;
  label: string;
  icon: ReactNode;
  on: () => void;
}

/** Sidebar footer, two rows with distinct jobs:
 *
 * 1. 设置 (navigation) + the theme pill (appearance).
 * 2. 折叠/隐藏/⌘K/GitHub (chrome actions), equal-width.
 * Collapsed rail: centered vertical stack of the actions that still make
 * sense at zero width. */
function Footer({ compact }: { compact?: boolean } = {}) {
  const storeCollapsed = useSettings((s) => s.sidebarCollapsed);
  const collapsed = compact ?? storeCollapsed;
  const toggle = useSettings((s) => s.toggleSidebar);
  const hide = useSettings((s) => s.setSidebarHidden);
  const openPalette = useCommandPalette((s) => s.setOpen);
  const navigate = useNavigate();

  const chromeActions: FooterAction[] = [
    {
      key: "toggle",
      label: collapsed ? "展开侧边栏" : "折叠侧边栏",
      icon: collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />,
      on: toggle,
    },
    {
      key: "hide",
      label: "隐藏侧边栏",
      icon: <ArrowLineLeft size={16} />,
      on: () => hide(true),
    },
    {
      key: "palette",
      label: "打开命令面板",
      icon: <span className="font-mono text-[11px]">⌘K</span>,
      on: () => openPalette(true),
    },
    {
      key: "github",
      label: "GitHub 仓库",
      icon: <GithubLogo size={16} />,
      on: () => void openUrl(REPO_URL).catch(() => {}),
    },
  ];

  if (collapsed) {
    const railActions: FooterAction[] = [
      {
        key: "settings",
        label: "设置",
        icon: <GearSix size={16} />,
        on: () => navigate("/settings"),
      },
      chromeActions[3]!, // GitHub
      chromeActions[0]!, // 折叠/展开
    ];
    return (
      <div className="flex flex-col items-center gap-1">
        <ThemeSwitch collapsed />
        {railActions.map((action) => (
          <GlassIconButton
            key={action.key}
            label={action.label}
            size="sm"
            onClick={action.on}
            title={action.label}
          >
            {action.icon}
          </GlassIconButton>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <ThemeSwitch collapsed={false} />
      <div className="flex items-center gap-1.5">
        {chromeActions.map((action) => (
          <GlassIconButton
            key={action.key}
            label={action.label}
            size="sm"
            onClick={action.on}
            title={action.label}
            className="flex-1"
          >
            {action.icon}
          </GlassIconButton>
        ))}
      </div>
    </div>
  );
}

NavList.Footer = Footer;
