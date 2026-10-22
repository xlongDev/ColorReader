import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";

import { OverlayPortal } from "@/components/glass/overlay";
import { failedMessage, summarizeOutcomes } from "@/features/library/format";
import type { ImportOutcome } from "@/types/ipc";

/** The toasts store's own budget for "long enough to read a sentence". */
const AUTO_DISMISS_MS = 6_000;

/** What the last import did, in the corner the progress card sat in. */
export function ImportSummary({
  outcomes,
  onClose,
}: {
  outcomes: ImportOutcome[];
  onClose: () => void;
}) {
  const failures = outcomes.filter(
    (o): o is Extract<ImportOutcome, { kind: "failed" }> => o.kind === "failed",
  );

  /**
   * A batch that landed everything is a receipt: it says its piece and goes.
   * Failures stay until dismissed — the list of files that did not make it is
   * the one thing on this card the reader has to act on, and a timer that
   * hides it would be a timer racing the reader.
   *
   * The handler is read through a ref because the caller passes an inline
   * arrow: depending on it directly would restart the timer on every render
   * of the page behind (the import progress card re-renders it once per
   * book), and the summary would never leave. `outcomes` is state at the call
   * site, so a new batch is a new array and does restart it.
   */
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // `outcomes` is state at the call site, so a new batch is a new array even
  // when its shape matches the last one — depending on it restarts the clock
  // per batch, which `failures.length` alone cannot do (two one-book imports
  // would share one timer). The rule flags it as unused because the body only
  // needs the count; the dependency is the point.
  useEffect(() => {
    if (failures.length > 0) return;
    const timer = setTimeout(() => close.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [outcomes, failures.length]);

  return (
    <OverlayPortal>
      <div className="glass-2 shadow-panel fixed right-6 bottom-6 z-40 w-80 rounded-2xl p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-text-1 text-sm font-medium">{summarizeOutcomes(outcomes)}</p>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="text-text-3 hover:text-text-1"
          >
            <X size={13} />
          </button>
        </div>
        {failures.length > 0 && (
          <ul className="mt-2 space-y-2">
            {failures.slice(0, 3).map((outcome) => (
              <li key={outcome.path} className="text-text-3 text-xs break-all">
                {failedMessage(outcome)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </OverlayPortal>
  );
}
