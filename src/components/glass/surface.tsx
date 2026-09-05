import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Elevation = 1 | 2 | 3;

interface GlassSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * 1 = nested material (tint + rim, no blur, for cards inside a panel)
   * 2 = top level material (adds backdrop blur, for panels / sidebar / dialogs)
   * 3 = opaque material (no blur, for popovers that float over content)
   */
  elevation?: Elevation;
}

const ELEVATION: Record<Elevation, string> = {
  1: "glass",
  2: "glass-2",
  3: "glass-solid",
};

/**
 * The single building block for every translucent surface in the app. Composing
 * multiple surfaces is cheaper than reaching for additional component variants.
 */
export const GlassSurface = forwardRef<HTMLDivElement, GlassSurfaceProps>(function GlassSurface(
  { elevation = 1, className, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn(ELEVATION[elevation], "rounded-xl", className)} {...rest}>
      {children}
    </div>
  );
});
