import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "@/lib/cn";
import { GlassSurface } from "@/components/glass/surface";

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Controls tone; defaults to the softest glass layer. */
  elevation?: 1 | 2 | 3;
}

/** A primary glass container: large radius, soft surface, supports nested children. */
export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  { className, elevation = 2, children, ...rest },
  ref,
) {
  return (
    <GlassSurface
      ref={ref}
      elevation={elevation}
      className={cn("rounded-2xl", className)}
      {...rest}
    >
      {children}
    </GlassSurface>
  );
});

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
}

/** A small, paper-like glass card for library tiles and settings rows. */
export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(function GlassCard(
  { interactive = false, className, children, ...rest },
  ref,
) {
  return (
    <GlassSurface
      ref={ref}
      elevation={1}
      className={cn(
        "rounded-lg p-4",
        interactive &&
          "hover:bg-surface-2 focus-visible:focus-ring cursor-default transition-colors",
        className,
      )}
      tabIndex={interactive ? 0 : undefined}
      {...rest}
    >
      {children}
    </GlassSurface>
  );
});
