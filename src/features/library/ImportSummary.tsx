import { X } from "@phosphor-icons/react";

import { OverlayPortal } from "@/components/glass/overlay";
import { failedMessage, summarizeOutcomes } from "@/features/library/format";
import type { ImportOutcome } from "@/types/ipc";

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
          <ul className="mt-2 space-y-1">
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
