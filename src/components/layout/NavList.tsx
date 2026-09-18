import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import type { Icon } from "@phosphor-icons/react";
import {
  Books,
  ClockCounterClockwise,
  ChartLine,
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
  Notebook,
  Sun,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { useSettings, type ThemeMode } from "@/stores/settings";
import { GlassIconButton } from "@/components/glass/button";
import { useCommandPalette } from "@/stores/command-palette";
import { DURATION, SPRING } from "@/lib/motion";

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
  { to: "/notes", label: "笔记", icon: Notebook },
  { to: "/stats", label: "统计", icon: ChartLine },
  { to: "/search", label: "搜索", icon: MagnifyingGlass },
];

/**
 * Which way a click moves down this list, for the page transition to travel in.
 *
 * It is carried on the navigation itself (`state`) rather than remembered by the
 * shell, because "which way did we come from" is the one thing a route change
 * cannot tell you about itself — and the alternative, holding the previous route
 * in a ref or state, means either reading a ref while rendering or paying a
 * second full render of a heavy page on every navigation.
 *
 * `Link` ignores `state` it does not use, and navigations that are not this
 * list (the command palette, a deep link, the reader) simply do not set it —
 * which reads as 0, a plain cross-fade.
 */
function stepFrom(from: string, to: string): number {
  const here = ITEMS.findIndex((item) => item.to === from);
  const there = ITEMS.findIndex((item) => item.to === to);
  return here < 0 || there < 0 ? 0 : Math.sign(there - here);
}

const ROW = cn(
  // `relative` so the shared-layout pill can absolutely fill the row
  // underneath the icon and label — it is the row that owns the position,
  // not the pill, so it is the row that must establish a containing block.
  "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px]",
  // Active and inactive are both transparent (the active row's fill is the
  // sliding pill underneath), so the only thing the row itself animates is
  // the text colour — a longer curve keeps the icon and label reading as
  // part of the same gesture as the pill.
  "border border-transparent transition-colors duration-200 ease-[cubic-bezier(0.33,1,0.68,1)]",
  "press focus-visible:focus-ring",
);

/** Pill — text colour only. Background is the shared-layout indicator that
 *  springs between rows; the row itself stays transparent in both states
 *  so a row that has never been hovered never paints a stale fill under the
 *  pill as it lands. */
function rowState(isActive: boolean): string {
  return isActive ? "text-text-1" : "text-text-2 hover:bg-surface-1 hover:text-text-1";
}

export function NavList() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const reduce = useReducedMotion();
  const { pathname } = useLocation();
  // Remounting on activation gives the fill/outline swap a soft pop. `tap`
  // (stiffness 560) used to feel like a button press; `enter` is the same
  // settle without the urgency — a sidebar selection is unhurried, and the
  // icon should land with the rest of the page rather than outrun it.
  const iconSpring = {
    initial: reduce ? false : { scale: 0.6, opacity: 0.4 },
    animate: { scale: 1, opacity: 1 },
    transition: SPRING.enter,
  } as const;
  return (
    <nav className="flex flex-col gap-0.5 px-1" aria-label="主导航">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          state={{ step: stepFrom(pathname, item.to) }}
          // Collapsed rail keeps the label for assistive tech and as a native
          // tooltip; dropping the node entirely left the icon with no name.
          title={collapsed ? item.label : undefined}
          className={({ isActive }) => cn(ROW, rowState(isActive))}
        >
          {({ isActive }) => (
            <>
              {/* Shared-layout pill: a single accent-soft stadium that lives
                  on every active row, slides between them on activation, and
                  unmounts when the row is no longer active. Mounting it on
                  the active row only is the trick — every other row's
                  "absent pill" is what lets motion see a single shared
                  `layoutId` and FLIP it across rows. `SPRING.layout`
                  (stiffness 400, damping 34) is the same spring the shelf
                  uses for card reflow, so an active swap and a shelf
                  reorder read as the same kind of motion. */}
              {isActive && (
                <motion.span
                  layoutId="nav-pill"
                  className="bg-accent-soft absolute inset-0 rounded-md"
                  transition={reduce ? { duration: 0 } : SPRING.layout}
                />
              )}
              {/* shrink-0: the always-in-layout nowrap label no longer fits
                  the collapsed rail, and flex would otherwise squeeze the
                  icon (svg min-width:auto = 0) down to nothing. `relative`
                  keeps the icon (and the label) above the pill's stacking
                  context — the pill is `absolute inset-0`, so without the
                  `relative` the icon would paint *under* the pill's
                  accent-soft fill. */}
              <motion.span
                key={String(isActive)}
                className="relative flex shrink-0"
                {...iconSpring}
              >
                <item.icon size={18} weight={isActive ? "fill" : "regular"} />
              </motion.span>
              {/* Always in layout, fading with the pane transition; nowrap so
                  the label overflows instead of re-wrapping mid-animation.
                  `relative` mirrors the icon: above the pill, not under it. */}
              <motion.span
                initial={false}
                animate={{ opacity: collapsed ? 0 : 1 }}
                transition={{
                  duration: collapsed ? DURATION.fast : DURATION.base,
                  delay: collapsed ? 0 : 0.15,
                }}
                className="relative whitespace-nowrap"
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

/**
 * Stable ids that let motion FLIP the footer's icons between the collapsed
 * rail and the expanded two-row layout.
 *
 * The two states share only some icons — `hide` and `palette` only exist when
 * the rail is open — so the shared ones carry a stable `layoutId` and the
 * ones that come and go mount inside `AnimatePresence`. `LayoutGroup` in
 * `Footer` makes the id a global scope inside the footer, so a `layoutId`
 * can sit in the column in one render and the row in the next and still
 * animate between them.
 */
const ID = {
  settings: "footer-settings",
  themeIcon: "footer-theme-icon",
  toggle: "chrome-toggle",
  github: "chrome-github",
} as const;

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
          {/* The active theme icon also carries the shared theme-icon
              layoutId, so when the rail expands it glides from the centre
              of this button to the centre of its radio cell in the pill. */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={current.value}
              layoutId={ID.themeIcon}
              initial={reduce ? false : { opacity: 0, scale: 0.5, rotate: -30 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={reduce ? undefined : { opacity: 0, scale: 0.5, rotate: 30 }}
              transition={SPRING.tap}
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
        {/* Settings gear carries the shared settings layoutId, so when the
            rail collapses it glides from this pill cell down to the column
            slot it occupies below. The cell is a button (not a link) on
            purpose: clicking it never moves focus away from where the
            reader is. */}
        <motion.div
          layoutId={ID.settings}
          transition={reduce ? { duration: 0 } : SPRING.layout}
          className="flex h-7 flex-1 items-center justify-center"
        >
          <button
            type="button"
            title="设置"
            aria-label="设置"
            onClick={() => navigate("/settings")}
            className="text-text-3 hover:text-text-1 flex h-7 items-center justify-center rounded-full px-2.5 transition-colors duration-200"
          >
            <GearSix size={15} />
          </button>
        </motion.div>
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
                  transition={reduce ? { duration: 0 } : SPRING.layout}
                />
              )}
              {/* Only the *active* theme icon carries the theme-icon
                  layoutId — the other two are decorative and stay put.
                  Collapsed, the single button renders the same icon under
                  this id, so a rail ⇄ pill toggle glides it between the
                  centre of the button and the centre of its radio cell. */}
              {active ? (
                <motion.span
                  layoutId={ID.themeIcon}
                  transition={reduce ? { duration: 0 } : SPRING.layout}
                  className="relative flex"
                >
                  <Icon size={15} weight="fill" />
                </motion.span>
              ) : (
                <Icon size={15} weight="regular" className="relative" />
              )}
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
 * sense at zero width.
 *
 * The shared `LayoutGroup` lets the icons that exist in both layouts —
 * settings gear, theme icon, toggle, GitHub — keep a stable `layoutId`
 * across the toggle and FLIP between their column and row positions,
 * while `hide` and `palette` (expanded-only) fade in and out. */
function Footer({ compact }: { compact?: boolean } = {}) {
  const storeCollapsed = useSettings((s) => s.sidebarCollapsed);
  const collapsed = compact ?? storeCollapsed;
  const toggle = useSettings((s) => s.toggleSidebar);
  const hide = useSettings((s) => s.setSidebarHidden);
  const openPalette = useCommandPalette((s) => s.setOpen);
  const navigate = useNavigate();
  const reduce = useReducedMotion();

  /**
   * The toggle's glyph, animated in the direction the rail is about to move.
   *
   * A rotation said "this icon changed"; a slide says "the panel went that
   * way", which is what the button actually does. The glyph itself is a single
   * caret — a double chevron reads as "jump to the end" (or, at this size, as
   * a typographic « that says nothing at all), and the button neither jumps
   * nor goes anywhere but sideways.
   *
   * Both directions fall out of one expression. `initial` is read from the
   * render that *mounts* a glyph and `exit` from the render that unmounts it,
   * so with `collapsed` on both sides the arriving caret enters from the side
   * the rail is leaving and the departing one follows it out.
   */
  const toggleIcon = (
    <span className="relative flex h-4 w-4 items-center justify-center">
      <AnimatePresence initial={false}>
        <motion.span
          key={String(collapsed)}
          initial={reduce ? false : { x: collapsed ? 7 : -7, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={reduce ? undefined : { x: collapsed ? 7 : -7, opacity: 0 }}
          transition={reduce ? { duration: 0 } : SPRING.tap}
          className="absolute flex"
        >
          {collapsed ? <CaretRight size={16} /> : <CaretLeft size={16} />}
        </motion.span>
      </AnimatePresence>
    </span>
  );

  const chromeActions: FooterAction[] = [
    {
      key: "toggle",
      label: collapsed ? "展开侧边栏" : "折叠侧边栏",
      icon: toggleIcon,
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

  // Wraps a chrome button so it FLIPs between its collapsed column slot
  // and its expanded row slot. `layoutId` makes motion see one element that
  // changed parents rather than two unrelated renders. The helpers are
  // defined at module scope so React keeps the same component identity
  // across renders — defining them inside `Footer` would re-create them
  // every render and make oxlint flag the file.
  const chrome = (
    <>
      <ChromeButton
        id={ID.toggle}
        button={chromeActions[0]!}
        collapsed={collapsed}
        reduce={reduce}
      />
      {collapsed ? (
        <>
          {/* Settings lives in the rail when collapsed and inside the pill
              when expanded — the ThemeSwitch owns the latter. */}
          <motion.div
            layoutId={ID.settings}
            transition={reduce ? { duration: 0 } : SPRING.layout}
            className="flex"
          >
            <GlassIconButton
              label="设置"
              size="sm"
              onClick={() => navigate("/settings")}
              title="设置"
            >
              <GearSix size={16} />
            </GlassIconButton>
          </motion.div>
          <ChromeButton
            id={ID.github}
            button={chromeActions[3]!}
            collapsed={collapsed}
            reduce={reduce}
          />
        </>
      ) : (
        <>
          {/* Hide + palette only exist when expanded. AnimatePresence lets
              each fade and scale in/out without holding the layout back. */}
          <AnimatePresence initial={false}>
            <ChromeEphemeral key="hide" button={chromeActions[1]!} reduce={reduce} />
            <ChromeEphemeral key="palette" button={chromeActions[2]!} reduce={reduce} />
          </AnimatePresence>
          <ChromeButton
            id={ID.github}
            button={chromeActions[3]!}
            collapsed={collapsed}
            reduce={reduce}
          />
        </>
      )}
    </>
  );

  return (
    // `LayoutGroup` is what makes the layoutIds above a shared scope:
    // without it, a `layoutId` only animates inside one parent, and a
    // column→row move would just snap because the parents are different.
    <LayoutGroup id="sidebar-footer">
      <motion.div
        layout
        transition={reduce ? { duration: 0 } : SPRING.layout}
        className={cn(collapsed ? "flex flex-col items-center gap-1" : "flex flex-col gap-1.5")}
      >
        <ThemeSwitch collapsed={collapsed} />
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">{chrome}</div>
        ) : (
          <div className="flex items-center gap-1.5">{chrome}</div>
        )}
      </motion.div>
    </LayoutGroup>
  );
}

/** Wraps a chrome button so it FLIPs between its collapsed column slot and
 *  its expanded row slot. Stable identity at module scope — see `Footer`.
 *
 *  `flex-1` on the wrapper is what makes the row's four buttons equal width.
 *  It used to sit on the button itself, which did nothing once the wrapper
 *  became the flex item: the two wrapped buttons then measured 32px while the
 *  two `ChromeEphemeral`s grew, and the row read as unevenly spaced
 *  (measured: gaps of 6 / 41 / 41px against the theme pill's four even
 *  cells above it). Column layout gets no `flex-1` — there it would stretch
 *  the button vertically instead. */
function ChromeButton({
  id,
  button,
  collapsed,
  reduce,
}: {
  id: string;
  button: FooterAction;
  collapsed: boolean;
  reduce: boolean | null;
}) {
  return (
    <motion.div
      layoutId={id}
      transition={reduce ? { duration: 0 } : SPRING.layout}
      className={cn("flex", !collapsed && "flex-1")}
    >
      <GlassIconButton
        label={button.label}
        size="sm"
        onClick={button.on}
        title={button.label}
        className={collapsed ? undefined : "flex-1"}
      >
        {button.icon}
      </GlassIconButton>
    </motion.div>
  );
}

/** Wraps an expanded-only chrome button so it fades in/out instead of
 *  snapping on the layout flip. Lives inside AnimatePresence so motion can
 *  play the exit before tearing it out.
 *
 *  The button fills its wrapper for the same reason `ChromeButton`'s does:
 *  the row's four buttons share the width evenly, and a `flex-1` wrapper
 *  around a fixed 32px button only moves the unevenness inside it. */
function ChromeEphemeral({ button, reduce }: { button: FooterAction; reduce: boolean | null }) {
  return (
    <motion.div
      layout
      initial={reduce ? false : { opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.85 }}
      transition={reduce ? { duration: 0 } : SPRING.layout}
      className="flex flex-1"
    >
      <GlassIconButton
        label={button.label}
        size="sm"
        onClick={button.on}
        title={button.label}
        className="flex-1"
      >
        {button.icon}
      </GlassIconButton>
    </motion.div>
  );
}

NavList.Footer = Footer;
