import { useEffect, useState } from "react";

import { GlassButton } from "@/components/glass/button";
import { GlassDialog } from "@/components/glass/overlay";
import { ipc } from "@/lib/ipc";
import { useOcrRun } from "@/stores/ocrRun";
import type { OcrScan } from "@/types/ipc";

/**
 * The gate in front of a whole-book recognition run.
 *
 * A run is hundreds of requests and can take a quarter of an hour, so it does
 * not start on a press — it starts on an answer to "how much of this book is
 * actually a scan". The count is the whole point of the dialog: 210 pages is a
 * decision, 3 is a formality, and only the reader knows which of those they are
 * looking at.
 *
 * The count is asked for when the dialog opens, not when it is rendered, and it
 * can take a moment: the answer comes from the corpus, and a book whose text was
 * never extracted pays that debt to produce it (see `ocr::scanned_pages`).
 */
export function OcrRunDialog({
  bookId,
  open,
  onOpenChange,
}: {
  bookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const start = useOcrRun((state) => state.start);
  const [scan, setScan] = useState<OcrScan | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The previous answer is dropped as the dialog opens, during render rather
  // than in the effect below — the same render-time adjust the reader's layout
  // switch uses. Resetting it inside the effect would render one frame of the
  // *last* book's counts under this book's title, and it is the kind of
  // setState-in-an-effect that starts a second render for no reason.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setScan(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let alive = true;
    ipc
      .ocrScannedPages(bookId)
      .then((found) => {
        if (alive) setScan(found);
      })
      .catch((failure: unknown) => {
        if (alive) setError(String(failure instanceof Error ? failure.message : failure));
      });
    return () => {
      alive = false;
    };
  }, [bookId, open]);

  const pages = scan?.pages.length ?? 0;

  const begin = () => {
    if (!scan || scan.pages.length === 0) return;
    // Not awaited: the run outlives this dialog, and closing on the same tick
    // the work starts is what lets the reader go and read something else.
    void start(bookId, scan.pages);
    onOpenChange(false);
  };

  return (
    <GlassDialog
      open={open}
      onOpenChange={onOpenChange}
      title="识别全书"
      widthClass="w-[min(92vw,480px)]"
    >
      {error ? (
        <p className="text-danger text-[13px] leading-relaxed">{error}</p>
      ) : !scan ? (
        <p className="text-text-2 text-[13px] leading-relaxed">正在数这本书有多少页没有文字层…</p>
      ) : pages === 0 ? (
        <p className="text-text-2 text-[13px] leading-relaxed">
          这本书的每一页都已经有文字了，不需要识别。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-text-2 text-[13px] leading-relaxed">
            全书 {scan.total} 页里有 <span className="text-text-1 font-medium">{pages} 页</span>
            没有文字层，将依次发出 {pages} 次识别请求。可以随时停止，已经识别的不会白做。
          </p>
          <p className="text-text-3 text-[12px] leading-relaxed">
            识别给的是文字，不是每个字的位置：全书检索、朗读与助手能覆盖这些页，划词仍然不行。
          </p>
        </div>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <GlassButton variant="subtle" onClick={() => onOpenChange(false)}>
          {error || pages === 0 ? "知道了" : "取消"}
        </GlassButton>
        {!error && scan && pages > 0 && (
          <GlassButton variant="primary" onClick={begin}>
            开始识别
          </GlassButton>
        )}
      </div>
    </GlassDialog>
  );
}
