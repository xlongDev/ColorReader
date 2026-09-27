import { createCurl, startCurl, type CurlShot, type CurlTurn } from "./pdfCurl";
import type { PageTransition } from "./theme";

/**
 * The page-turn animation for a paged PDF.
 *
 * A PDF page is one canvas that pdf.js keeps drawing into, so the page the
 * reader leaves is destroyed by the very render that brings the next one in —
 * there is no outgoing element left to animate. A turn has to copy the bitmap
 * out first and animate the copy: an overlay that rides over the page
 * arriving and is dropped once it has gone.
 *
 * This is the shape readest's captured turn takes — snapshot, navigate,
 * animate the snapshot out — with the expensive half removed. readest has to
 * ask the native webview for a screenshot (and pre-bake it, and budget for
 * it) because its page is live DOM; ours is already pixels, so the snapshot
 * is a synchronous `drawImage` and none of that orchestration exists.
 */
/** `--ease-out` from globals.css. WAAPI cannot read a custom property, so the
    curve is spelled out here; keep the two in step. */
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** How far the sheet swings before it retires. Past ~90° its back would show,
    and a flat bitmap has none — it fades out on the way there instead. */
const FOLD_DEG = 88;

/** The soft edge under a sliding sheet, so it reads as paper leaving the
    window rather than a picture scrolling away. */
const SHEET_SHADOW = "0 0 24px rgba(0, 0, 0, 0.28)";

/** How long the mesh curl takes, matching foliate's own curl keyframes. */
const CURL_MS = 420;

export interface PdfTurn {
  frames: Keyframe[];
  duration: number;
  /** Slide the sheet out under a shadow; a fold or a fade needs none. */
  shadow: boolean;
  /** The spine the sheet swings about. Absent when the turn does not fold. */
  origin?: string;
}

/**
 * The animation for one turn of the outgoing page, or `null` when the setting
 * asks for none. `dir` is the direction of travel: 1 forward, -1 back.
 *
 * `pan` and `slide` are one effect here on purpose: the native smooth scroll
 * `pan` stands for on the foliate path needs a column strip to scroll, and a
 * paged PDF has none — both slide the sheet the reader is leaving off screen.
 */
export function pdfTurn(mode: PageTransition, dir: 1 | -1): PdfTurn | null {
  switch (mode) {
    case "pan":
    case "slide":
      return {
        frames: [
          { transform: "none" },
          { transform: `translateX(${dir === 1 ? "-100%" : "100%"})` },
        ],
        duration: 300,
        shadow: true,
      };
    case "fade":
      return { frames: [{ opacity: 1 }, { opacity: 0 }], duration: 300, shadow: false };
    case "flip":
    case "paper": {
      // The flat fold: the sheet lifts by its outer edge and swings away from
      // the reader about the spine on the left. Backward is the mirror.
      //
      // "仿真" prefers `pdfCurl.ts` and only reaches this when WebGL is
      // unavailable; "翻牌" is this fold by design.
      const away = dir === 1 ? -1 : 1;
      return {
        frames: [
          { opacity: 1, transform: "perspective(1400px) rotateY(0deg)" },
          { opacity: 0.9, offset: 0.6, transform: `perspective(1400px) rotateY(${away * 55}deg)` },
          { opacity: 0, transform: `perspective(1400px) rotateY(${away * FOLD_DEG}deg)` },
        ],
        duration: 400,
        shadow: false,
        origin: dir === 1 ? "left center" : "right center",
      };
    }
  }
  // "none": nothing to play.
  return null;
}

/**
 * Copies the PDF page(s) on screen into an overlay over `host` and animates
 * them out. Call this *before* the page number changes — the canvas it copies
 * is the one pdf.js is about to redraw.
 *
 * `host` is the reading viewport: the overlay is laid over the whole of it so
 * a spread of two pages leaves as one sheet.
 */
export function snapshotPdfTurn(
  host: HTMLElement | null,
  dir: 1 | -1,
  mode: PageTransition,
  /** `null` while the motion preference is undetermined; treated as motion. */
  reduced: boolean | null,
): CurlTurn | null {
  if (!host || reduced || mode === "none") return null;
  // A held arrow key turns faster than the animation lasts, and two overlays
  // of page-sized bitmaps is memory the reader never gets to see. The older
  // one goes first.
  host.querySelector("[data-pdf-turn]")?.remove();

  const hostBox = host.getBoundingClientRect();
  const shots: { copy: HTMLCanvasElement; shot: CurlShot }[] = [];
  for (const src of host.querySelectorAll<HTMLCanvasElement>("[data-pdf-page] canvas")) {
    if (src.width === 0 || src.height === 0) continue;
    const box = src.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    const copy = document.createElement("canvas");
    copy.width = src.width;
    copy.height = src.height;
    const context = copy.getContext("2d");
    if (!context) continue;
    context.drawImage(src, 0, 0);
    // The real page's own border and corner radius: a bare bitmap sliding over
    // a rounded page reads as a second, wrong page underneath it.
    copy.className = src.className;
    shots.push({
      copy,
      shot: {
        canvas: copy,
        x: box.left - hostBox.left,
        y: box.top - hostBox.top,
        w: box.width,
        h: box.height,
      },
    });
  }
  if (shots.length === 0) return null;

  const layer = document.createElement("div");
  layer.dataset.pdfTurn = "";
  // Clipped to the viewport: the sheet is on its way out of the window, and an
  // unclipped overlay would carry it over the sidebar on the way.
  layer.className = "pointer-events-none absolute inset-0 overflow-hidden";

  // "仿真" bends the sheet on the GPU. Where WebGL is refused — a headless
  // WebKit, a blocked GPU — the flat fold below is what the reader gets
  // instead: half a turn is worse than a plainer one.
  if (mode === "paper") {
    const curl = createCurl(
      host,
      shots.map((entry) => entry.shot),
      dir,
    );
    if (curl) {
      layer.append(curl.canvas);
      host.append(layer);
      // Handed back unfinished: a gesture holds it with `set` and lets go with
      // `finish`, and a turn with no gesture behind it just finishes at once.
      return startCurl(layer, curl, CURL_MS);
    }
  }

  const turn = pdfTurn(mode, dir);
  if (!turn) {
    layer.remove();
    return null;
  }
  for (const { copy, shot } of shots) {
    copy.style.position = "absolute";
    copy.style.left = `${shot.x}px`;
    copy.style.top = `${shot.y}px`;
    copy.style.width = `${shot.w}px`;
    copy.style.height = `${shot.h}px`;
    if (turn.shadow) copy.style.boxShadow = SHEET_SHADOW;
  }
  if (turn.origin) layer.style.transformOrigin = turn.origin;
  layer.append(...shots.map((entry) => entry.copy));
  host.append(layer);

  const animation = layer.animate(turn.frames, {
    duration: turn.duration,
    easing: EASE_OUT,
    // Held until the overlay is gone: without it the sheet snaps back to its
    // start for the frame between the animation ending and `remove` running.
    fill: "forwards",
  });
  const drop = () => layer.remove();
  animation.addEventListener("finish", drop);
  animation.addEventListener("cancel", drop);
  // The flat fold is a fixed animation: there is nothing for a gesture to hold.
  return null;
}
