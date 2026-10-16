import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Scan, TextTSlash } from "@phosphor-icons/react";

import { GlassButton } from "@/components/glass/button";
import { pageImageDataUrl } from "@/features/reader/pdfOcr";
import { ipc, isDesktopRuntime } from "@/lib/ipc";
import { useOcrRun } from "@/stores/ocrRun";
import { scanKey, useScanPages } from "@/stores/scanPages";
import { showToast } from "@/stores/toasts";

import { OcrRunDialog } from "./OcrRunDialog";

/**
 * The recognise affordance, in the reader's footer rather than on the page.
 *
 * It used to be a bar floating over the bottom of the paper. Both halves of
 * that were wrong, and only the first was cosmetic: it covered the page it was
 * talking about, and it was drawn *per page slot* — a spread drew the same
 * notice twice, and each copy carried its own copy of the run's progress. The
 * footer is outside the paper in every layout (paged, spread, scroll, any
 * zoom, any format), and there is exactly one of it.
 *
 * The move fixes what the bar could never say: a run now has somewhere to be
 * seen from *any* page of the book, instead of only from a page that happens
 * to be a scan — and somewhere to be stopped from, which is the half that
 * matters when the reader has walked off to read something else.
 *
 * Three faces, mutually exclusive, in this order:
 *
 * - **A run on this book** — the progress and the way to stop it. It outranks
 *   the page: the run is a job of a quarter of an hour, and the page the reader
 *   is looking at is not the page it is working on.
 * - **This page has no text layer** — the notice and the two scales of the
 *   fix, this page or the whole book.
 * - **Nothing** — a page with text, or one whose text layer is still being
 *   built (see `stores/scanPages`: absence is "nothing to say", not "no text").
 *
 * The chip is desktop-only, like everything behind it: the browser build has
 * no OCR command to call, and a button that cannot work is worse than no
 * button.
 */
export function ScanChip({
  bookId,
  page,
}: {
  bookId: string;
  /** 1-based, as the reader counts. */ page: number;
}) {
  const run = useOcrRun((state) => state.run);
  const stop = useOcrRun((state) => state.stop);
  const empty = useScanPages((state) => state.empty.has(scanKey(bookId, page)));
  const recognised = useScanPages((state) => state.recognised.has(scanKey(bookId, page)));
  const markRecognised = useScanPages((state) => state.markRecognised);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [recognising, setRecognising] = useState(false);

  if (!isDesktopRuntime) return null;

  // A run belongs to one book: another book's run is not this reader's business.
  const mine = run?.bookId === bookId ? run : null;

  if (mine && mine.status !== "done") {
    const stopping = mine.status === "stopping";
    return (
      // Wrapped in one flex unit on purpose: the footer is a single flex row
      // that wraps (`flex-wrap`, see the footer in `ReaderPage`), and a chip
      // split across two lines would put its counter on one and its stop
      // button on the other.
      <span className="flex items-center gap-3">
        {/* The pulse is the only thing here that says the job is still moving:
            the counter advances every few seconds, and a static line reads as
            frozen. Reduced motion keeps the colour and loses the breathing. */}
        <Scan size={14} className="text-accent animate-pulse motion-reduce:animate-none" />
        <span className="text-text-2 text-xs">
          {stopping ? "正在停止…" : `正在识别全书 第 ${mine.index} / ${mine.total} 页`}
        </span>
        <GlassButton variant="subtle" size="sm" disabled={stopping} onClick={stop}>
          停止
        </GlassButton>
      </span>
    );
  }

  // Recognised by the run: 0-based there, 1-based here. This page has text
  // now, so the notice has nothing left to say — and leaving it would draw
  // "这一页已经有文字了" from the backend, a refusal the reader would read as
  // the run having failed.
  if (mine?.stored.includes(page - 1)) return null;
  if (!empty || recognised) return null;

  const failed = mine?.failed.includes(page - 1) ?? false;

  const recognise = async () => {
    if (recognising) return;
    setRecognising(true);
    try {
      const image = await pageImageDataUrl(bookId, page);
      const done = await ipc.ocrPage(bookId, page - 1, image);
      // The page just gained text: the chapter index carries its character
      // count, and the page counter and read-aloud both read from it.
      await queryClient.invalidateQueries({ queryKey: ["reader", "toc", bookId] });
      // Recorded against the book and the page, not against this component —
      // the reader navigates away and back, and a page that has text must not
      // be offered a second recognition.
      markRecognised(bookId, page);
      showToast(
        "success",
        `第 ${done.page} 页已识别（${done.chars} 字）。全书检索与朗读现在能覆盖这一页；划词仍然不可用——识别给的是文字，不是每个字的位置。`,
      );
    } catch (error) {
      showToast("error", String(error instanceof Error ? error.message : error));
    } finally {
      setRecognising(false);
    }
  };

  return (
    // One flex unit, like the run face: the footer wraps, and this face is the
    // widest thing that can ever sit on it.
    <span className="flex items-center gap-3">
      <span className="text-text-3 flex items-center gap-1.5 text-xs">
        <TextTSlash size={14} />
        {failed ? `第 ${page} 页上次没识别成功` : `第 ${page} 页没有文字层`}
      </span>
      <GlassButton
        variant="subtle"
        size="sm"
        disabled={recognising}
        onClick={() => void recognise()}
      >
        {recognising ? "正在识别…" : "识别这一页"}
      </GlassButton>
      <GlassButton variant="subtle" size="sm" onClick={() => setConfirmOpen(true)}>
        识别全书
      </GlassButton>
      <OcrRunDialog bookId={bookId} open={confirmOpen} onOpenChange={setConfirmOpen} />
    </span>
  );
}
