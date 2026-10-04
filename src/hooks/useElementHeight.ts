import { useEffect, type RefObject } from "react";

/**
 * Reports an element's height, and keeps reporting it while it changes.
 *
 * Built for one caller, and the reason is a bug this replaced. The read-aloud
 * pill is anchored to the content pane's bottom edge, and the reader's footer
 * sits *inside* that pane — so the pill has to be lifted by however much the
 * footer takes, or it lands on the reader's own controls. That number used to be
 * a constant measured once by hand, 58px, carrying a `ponytail:` note that it
 * would drift. It did: a CI runner with no CJK font grew the footer from 57px to
 * 78px and took the pill's clearance with it, from 20px to 8. Measured where the
 * footer already is, it is the same number on every platform.
 *
 * `active` is not bookkeeping. The footer is rendered conditionally — fullscreen
 * swaps it for a dock that lives past the bottom edge — and an effect whose
 * dependencies did not change does not re-run when the element its ref points at
 * is swapped underneath it, which would leave the observer watching a detached
 * node forever. Passing whatever decides the element's presence re-attaches at
 * the right moment, and reports `0` while there is nothing to measure.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  onChange: (height: number) => void,
  active: boolean,
): void {
  useEffect(() => {
    const element = active ? ref.current : null;
    if (!element) {
      onChange(0);
      return;
    }
    const report = () => onChange(Math.round(element.getBoundingClientRect().height));
    report();
    // Size and not position, which is all this needs: the footer cannot move
    // without the pane's own layout changing, and the pill is anchored to that.
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, onChange, active]);
}
