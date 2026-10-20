/**
 * The reading viewport of the book being read.
 *
 * A 对照阅读 pair mounts two readers, each with its own `[data-reading-viewport]`
 * and `[data-reading-content]`. Anything that anchors to "the reading area" —
 * the drawer, the selection toolbar, the image lightbox — has to anchor to the
 * one in the *active* pane: a bare `document.querySelector` returns the left
 * book's every time, which is how a panel opened from the right book used to
 * appear over the left one.
 *
 * Readers that already know their own viewport should pass it directly; this
 * is for the components that only have the window to go on.
 */
export function activeReadingViewport(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>(
      "[data-pair-pane][data-pair-active] [data-reading-viewport]",
    ) ?? document.querySelector<HTMLElement>("[data-reading-viewport]")
  );
}
