import { forwardRef, type ReactNode } from "react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "subtle";
type Size = "sm" | "md" | "lg";

// `motion` overrides a few DOM events (`onAnimationStart`, `onDrag*`), so the
// props come from `HTMLMotionProps` instead of `ButtonHTMLAttributes`.
interface GlassButtonProps extends Omit<HTMLMotionProps<"button">, "ref" | "children"> {
  variant?: Variant;
  size?: Size;
  leading?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-on-accent border-transparent shadow-glass",
  ghost: "bg-surface-1 text-text-1 border-hairline hover:bg-surface-2",
  subtle: "bg-transparent text-text-2 border-transparent hover:bg-surface-1 hover:text-text-1",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] rounded-md",
  md: "h-9 px-4 text-sm rounded-md",
  lg: "h-11 px-5 text-[15px] rounded-lg",
};

/** Pill-shaped glass button. Use `motion` for tap feedback, gated by reduced motion. */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton(
  {
    variant = "ghost",
    size = "md",
    leading,
    trailing,
    className,
    children,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      whileTap={reduce || disabled ? undefined : { scale: 0.98 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
      className={cn(
        "inline-flex items-center justify-center gap-2 border font-medium",
        "focus-visible:focus-ring transition-colors disabled:pointer-events-none disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </motion.button>
  );
});

interface GlassIconButtonProps extends Omit<HTMLMotionProps<"button">, "ref" | "children"> {
  /** Required for a11y; the visible content is decorative. */
  label: string;
  size?: Size;
  children?: ReactNode;
}

const ICON_SIZE: Record<Size, string> = {
  sm: "h-8 w-8 rounded-md",
  md: "h-9 w-9 rounded-md",
  lg: "h-11 w-11 rounded-lg",
};

/** Square glass button for icon glyphs. Always provides an `aria-label`. */
export const GlassIconButton = forwardRef<HTMLButtonElement, GlassIconButtonProps>(
  function GlassIconButton(
    { label, size = "md", className, children, type = "button", ...rest },
    ref,
  ) {
    return (
      <GlassButton
        ref={ref}
        type={type}
        variant="ghost"
        aria-label={label}
        className={cn(ICON_SIZE[size], "px-0", className)}
        {...rest}
      >
        {children}
      </GlassButton>
    );
  },
);
