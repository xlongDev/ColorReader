import { useLayoutEffect, useRef, type RefObject } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Star, Tag } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog, OverlayPortal } from "@/components/glass/overlay";
import { SPRING, useMotion } from "@/lib/motion";
import type { ShelfSelection } from "@/features/library/useShelfSelection";

/**
 * The batch bar, and the confirmation it asks for.
 *
 * `anchorRef` is the shelf's scroller: the bar is `position: fixed` in the
 * shell's overlay host, and that host is the *window* — so a plain `left: 50%`
 * is the window's middle while the shelf sits ~130px right of it (the
 * sidebar). The placement is therefore written as the pane's gutters (padding
 * on a full-width wrapper) rather than as a `left` on the bar.
 */
export function ShelfBatchBar({
  anchorRef,
  selection,
  busy,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  selection: ShelfSelection;
  busy: { favorite: boolean; delete: boolean };
}) {
  const m = useMotion();
  const barRef = useRef<HTMLDivElement>(null);

  /**
   * Where the bar belongs, horizontally.
   *
   * Not a style preference: an absolutely positioned box with a `left` and no
   * `right` is shrink-to-fit against the space between that `left` and the
   * viewport edge, so a bar told to sit at the pane's centre was silently
   * capped at (viewport − centre) wide. At 1280 that is 765px and the bar
   * needed 510, so nothing showed; at the ~1080 window in the bug report it is
   * ~416px, and every label in the bar wrapped to one character per line —
   * 已选 0 本 and 取消收藏 stacked vertically. Padding on a full-width wrapper
   * has no such ceiling, and `justify-center` inside it centres on the pane.
   *
   * Written straight onto the element instead of into state: the sidebar
   * animates its own width over ~340ms, so this tracks the spring frame by
   * frame, and a re-render per frame is the one thing the shelf's windowed
   * grid cannot afford.
   *
   * `anchorRef.parentElement` is the page's own root, which is the pane's
   * content box — the pane carries no padding of its own.
   */
  useLayoutEffect(() => {
    if (!selection.managing) return;
    const pane = anchorRef.current?.parentElement;
    const bar = barRef.current;
    if (!pane || !bar) return;
    const place = () => {
      const box = pane.getBoundingClientRect();
      bar.style.paddingLeft = `${box.left}px`;
      bar.style.paddingRight = `${window.innerWidth - box.right}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [selection.managing, anchorRef]);

  return (
    <>
      <OverlayPortal>
        {/* No scrim behind the bar.
            One used to sit here — a `fixed inset-0 z-30` button whose job was
            "click outside to exit". It also covered the shelf, and the shelf
            is the thing this mode is *for*: every click on a card landed on
            the scrim instead, so the mode exited and nothing was ever
            selected (measured in both engines: the topmost element at a
            card's centre was the scrim, not the card). A selection mode whose
            selection surface is behind a dismiss layer is not a mode.
            The way out is 完成, or Escape — see the key handler in
            `useShelfSelection`.

            The wrapper is always mounted, with the bar itself inside
            `AnimatePresence`: the placement effect writes the pane's gutters
            onto it as padding, and a `fixed inset-x-0` box has no width
            ceiling for those gutters to run into. Empty it is zero-height and
            `pointer-events-none`, so it costs nothing between uses. */}
        <div
          ref={barRef}
          className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center"
        >
          <AnimatePresence>
            {selection.managing && (
              <motion.div
                initial={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: m.reduce ? 0 : 16, scale: m.reduce ? 1 : 0.96 }}
                transition={m.panel}
                // Centred by the wrapper's flex, not by a `-translate-x-1/2`:
                // motion writes `transform` for the spring, and the half-width
                // nudge is only safe in a property it does not touch. The
                // `whitespace-nowrap` is the last line of defence — a label
                // that wrapped to one character per line is what this bug
                // looked like from the outside.
                className="glass-2 shadow-panel pointer-events-auto flex items-center gap-1.5 rounded-2xl p-2 pl-4 whitespace-nowrap"
                data-batch-bar
              >
                <span className="text-text-2 mr-1 text-sm whitespace-nowrap">
                  已选{" "}
                  <motion.span
                    key={selection.count}
                    initial={{ y: 8, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={SPRING.tap}
                    className="text-text-1 inline-block font-semibold tabular-nums"
                  >
                    {selection.count}
                  </motion.span>{" "}
                  本
                </span>
                <GlassButton size="sm" variant="subtle" onClick={selection.toggleAll}>
                  {selection.allSelected ? "取消全选" : "全选"}
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={selection.count === 0}
                  onClick={selection.requestTags}
                >
                  <Tag size={13} /> 打标签
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={selection.count === 0 || busy.favorite}
                  onClick={() => selection.favorite(true)}
                >
                  <Star size={13} /> 收藏
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="subtle"
                  disabled={selection.count === 0 || busy.favorite}
                  onClick={() => selection.favorite(false)}
                >
                  取消收藏
                </GlassButton>
                <GlassButton
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  disabled={selection.count === 0 || busy.delete}
                  onClick={selection.openDelete}
                >
                  删除
                </GlassButton>
                <GlassButton size="sm" variant="primary" onClick={selection.exit}>
                  完成
                </GlassButton>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </OverlayPortal>

      <GlassDialog
        open={selection.deleteOpen}
        onOpenChange={(next) => {
          if (!next) selection.closeDelete();
        }}
        title={`删除选中的 ${selection.count} 本书？`}
        description="选中的书籍会从书库中移除，对应的书籍文件和封面也会一并删除，此操作无法撤销。"
        widthClass="w-[min(92vw,420px)]"
      >
        <div className="flex justify-end gap-2">
          <GlassButton variant="subtle" onClick={selection.closeDelete} disabled={busy.delete}>
            取消
          </GlassButton>
          <GlassButton
            variant="ghost"
            className="text-danger"
            onClick={selection.confirmDelete}
            disabled={busy.delete}
          >
            删除
          </GlassButton>
        </div>
      </GlassDialog>
    </>
  );
}
