/**
 * Captured page-turn orchestration — 「仿真」on the desktop build.
 *
 * A turn cannot move the live page as a layer: the page is a slice of one big
 * multi-column iframe. Instead the native webview snapshots the reading pane,
 * the live view turns instantly underneath, and the captured sheet is animated
 * over the page that is already there:
 *
 *   snapshot the pane → mount the flat capture over it → turn the live view
 *   instantly (hidden by the capture) → play the curl out → park the sheet.
 *
 * Reversal is the same picture mirrored: the current page curls away from the
 * spine edge and the previous page is underneath.
 *
 * A tap should not wait for a snapshot, so the pane is also captured **while
 * the reader is idle**, once a turn has settled, and that sheet is spent on the
 * next turn: the page it holds is the one about to leave. The WebGL renderer
 * outlives the turn for the same reason — its context, shaders and mesh are
 * built during the idle pass, and a warm sheet is uploaded into it, so a tap
 * that lands on a parked sheet starts moving on the frame after it is answered.
 * The sheet is only good while the pane still shows it, which `host.key()`
 * decides (carrying the geometry too, since it is the controller that knows
 * the rect).
 *
 * A turn that arrives while another is still playing **supersedes** it rather
 * than being refused. Refusing was the earlier behaviour — the caller then ran
 * the paginator's own animation, so a burst of taps flipped between a curl and
 * a card flip. Superseding costs a fresh capture (the parked sheet is about the
 * page before the one on screen by then) and gives a burst one animation.
 *
 * The controller only orchestrates DOM + rendering; the host callbacks supply
 * the platform pieces (native capture, instant navigation, geometry), which
 * keeps it testable without a webview. `turn` reports whether it owned the
 * navigation — a failure *after* the instant turn must not be retried by the
 * caller, or the page turns twice.
 */

import { PageCurlRenderer } from "./pageCurl";

/** Region of the webview to snapshot, in viewport CSS px. */
export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TurnOutcome =
  /** The page moved: the caller must not turn again. */
  | "turned"
  /** Nothing was touched: the caller runs its own animated turn. */
  | "skipped";

export interface CapturedTurnHost {
  /** Reading pane: what the overlay covers, and the region captured. */
  pane: () => HTMLElement | null;
  /** Native snapshot of `region`, as encoded image bytes. */
  capture: (region: CaptureRegion) => Promise<ArrayBuffer>;
  /** Instant (animation-less) turn of the live view. */
  navigate: (forward: boolean) => Promise<void>;
  /** Page columns on screen; 2 turns one leaf hinged at the spine. */
  columns: () => number;
  /** Whether the book reads right to left. */
  rtl: () => boolean;
  /** Colour of the paper on the back of the sheet, or `null` for the default. */
  paper: () => string | null;
  /**
   * Identity of what the pane shows: the page, and the typography it is laid
   * out in. Anything else the sheet would have to be taken again for is the
   * controller's business (it appends the pane's size and the display scale).
   * An empty string means "unknown" — then nothing is prepared or reused. A
   * stale sheet would curl the *wrong* page away, so this is the one thing
   * standing between the warm path and a visible bug.
   */
  key: () => string;
  /**
   * Hides chrome the native snapshot would otherwise bake into the sheet (the
   * page-turn arrows hover *over* the pane, so they are inside the region).
   * Returns the restore, or `null` when there was nothing to hide — the null
   * also means a capture costs no paint wait, which is what lets the idle
   * prepare run without making anything blink.
   */
  maskChrome?: () => (() => void) | null;
}

// readest's desktop runs 450ms of plain ease-in-out and this read a touch
// quicker at the same shape, so the curl is longer. On top of that the first
// third of the curve is eased out: a pure ease-in-out spends its opening
// ~100ms barely moving, and a sheet that has not visibly started reads as a
// slow tap however long the whole turn is. The blend keeps the opening
// velocity at the settle's average, so the page is moving on the first frame
// the capture allows.
const DURATION_MS = 750;
const RELEASE_BLEND = 1 / 3;
// The instant-navigate and the browser's own relocate reporting both land
// after the animation's last frame; preparing on the spot would photograph a
// page that is still settling (and the key check below would throw it away).
const PREPARE_DELAY_MS = 250;
// A prepare that finds the flip arrows up gives up rather than blink them — but
// the arrows themselves linger two seconds after the last pointer event, and a
// reader who turns pages with them re-reveals them with every click. Retrying
// past that window is what makes their *next* tap warm.
const PREPARE_RETRY_MS = 2000;
const PREPARE_ATTEMPTS = 4;

const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const turnEase = (t: number) =>
  easeInOutQuad(t) * (1 - RELEASE_BLEND) + easeOutCubic(t) * RELEASE_BLEND;

const waitForPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

/**
 * A 1x1 texture of `color`: the curl's back face samples it across the whole
 * page, and a single texel with LINEAR/CLAMP_TO_EDGE is a flat fill.
 */
const paperTexture = (color: string | null): HTMLCanvasElement | null => {
  if (!color) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return canvas;
};

export class CapturedPageTurn {
  #host: CapturedTurnHost;
  /** Long-lived, parked hidden over the pane between turns. */
  #renderer: PageCurlRenderer | null = null;
  #rendererOn: HTMLElement | null = null;
  #rendererShape = "";
  #token = 0;
  #inFlight = false;
  #disposed = false;
  #broken = false;
  #enabled = true;
  /** Whether the in-flight turn has already moved the live page. */
  #pageTurned = false;
  /**
   * Pages a burst asked for that no turn has moved yet.
   *
   * A tap that lands while the previous one is still capturing supersedes it
   * before it ever navigated. Dropping that tap would silently lose a page —
   * three taps, one page — so it rides along in the turn that takes over and
   * is paid off in instant jumps *under the sheet*, which still shows the page
   * they were all asked from. The reader sees one curl and lands on the page
   * they tapped for.
   */
  #owed = 0;
  /** The idle snapshot of the page the next turn will turn away, if any. */
  #warm: { bitmap: ImageBitmap; key: string } | null = null;
  #warmTimer: number | null = null;
  #warmAttempts = 0;
  #preparing = false;

  constructor(host: CapturedTurnHost) {
    this.#host = host;
  }

  async turn(forward: boolean): Promise<TurnOutcome> {
    if (this.#disposed || this.#broken || !this.#enabled) return "skipped";
    const pane = this.#host.pane();
    if (!pane) return "skipped";
    const rect = pane.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return "skipped";

    const superseded = this.#inFlight;
    // A superseded turn that never navigated leaves one page owed: the reader
    // asked for it, and it is not the page this turn is about to turn.
    const carried = this.#owed;
    const owed = superseded && !this.#pageTurned ? carried + 1 : carried;
    this.#owed = owed;
    const token = ++this.#token;
    // Park the sheet on the way in, whether it was mid-curl or parked already.
    this.#renderer?.setVisible(false);
    this.#inFlight = true;
    this.#pageTurned = false;
    let navigated = false;
    try {
      if (superseded) {
        // A turn still playing is superseded, not refused: refusing dropped
        // the page onto the paginator's own animation, so a burst of taps
        // flipped between a curl and a card flip. What that costs is the
        // parked sheet — both it and foliate's own anchor, which lags a
        // relocate, are about the page *before* the one on screen now — so
        // this turn captures after the live view has painted the superseded
        // turn's page.
        this.#dropWarm();
        await waitForPaint();
      }
      const key = this.#key(rect);
      const warm = this.#warm;
      this.#warm = null;
      let bitmap = warm && warm.key === key ? warm.bitmap : null;
      if (warm && !bitmap) warm.bitmap.close();
      if (!bitmap) {
        const image = await this.#snapshot(rect);
        // Losing the token means a newer turn is already running this page's
        // turn, so this one reports "turned" on every exit below: saying
        // "skipped" would send the caller down its own animated turn as well.
        if (token !== this.#token) return "turned";
        if (!image) return "skipped";
        // No mime: the command returns PNG today, but the decoder sniffs bytes.
        bitmap = await createImageBitmap(new Blob([image]));
      }
      try {
        if (token !== this.#token) return "turned";
        const renderer = this.#ensureRenderer(pane, rect);
        renderer.setColumns(this.#host.columns());
        renderer.setTexture(bitmap);
        const paper = paperTexture(this.#host.paper());
        if (paper) renderer.setBackdrop(paper);
        const rtl = this.#host.rtl();
        renderer.render(0, rtl);
        renderer.setVisible(true);
        // The flat capture has to be painted before the live page changes
        // underneath it, or the incoming page flashes through for a frame.
        await waitForPaint();
        if (token !== this.#token) return "turned";
        await this.#host.navigate(forward);
        navigated = true;
        this.#pageTurned = true;
        // The pages the taps before this one asked for. Instant, and under the
        // sheet, so they are over before the curl's first frame: what the
        // reader sees is one turn that lands where they tapped to. Sequential,
        // not gathered — each jump starts from where the last one landed — and
        // written as recursion because the linter (rightly) dislikes a loop
        // that awaits.
        const payOwed = async (left: number): Promise<void> => {
          if (left <= 0 || token !== this.#token) return;
          await this.#host.navigate(forward);
          this.#owed = left - 1;
          return payOwed(left - 1);
        };
        await payOwed(owed);
        if (token !== this.#token) return "turned";
        await this.#play(token, rtl);
        // A superseded turn leaves the sheet to whoever took over from it.
        if (token !== this.#token) return "turned";
        this.#renderer?.setVisible(false);
        this.#schedulePrepare();
        return "turned";
      } finally {
        // Free the decoded page immediately: a full-pane retina bitmap is
        // several megabytes, and the next turn captures its own.
        bitmap.close();
      }
    } catch (cause) {
      // A superseded turn leaves its failure to the one that took over: it is
      // the owner of the sheet now, and it is mid-capture for a page this one
      // never touched.
      if (token !== this.#token) return "turned";
      // One failure retires the effect for the session, the way readest does:
      // on a platform without the command (Windows, Linux) every turn would
      // otherwise pay an IPC round trip and a console warning forever, and on
      // macOS a failure here means WebKit, not a hiccup.
      this.#broken = true;
      this.#disposeRenderer();
      this.#dropWarm();
      console.warn("仿真翻页不可用，回到渲染器自己的动画", cause);
      return navigated ? "turned" : "skipped";
    } finally {
      if (token === this.#token) this.#inFlight = false;
    }
  }

  /**
   * Arm the idle snapshot without waiting for a turn: a reader who has just
   * opened a book is as idle as one who has finished turning, and their first
   * tap would otherwise pay the full capture.
   */
  warm() {
    if (this.#enabled) this.#schedulePrepare();
  }

  /**
   * Whether 「仿真」 is the transition in force. Turning it off parks the GPU
   * surface for good; turning it on only re-arms the idle pass, which is where
   * the renderer gets built.
   */
  setEnabled(enabled: boolean) {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    if (enabled) return;
    if (this.#warmTimer !== null) window.clearTimeout(this.#warmTimer);
    this.#warmTimer = null;
    this.#dropWarm();
    this.#disposeRenderer();
  }

  /** Cancels an in-flight turn and drops the overlay; the view is left where
   *  the turn got to, which is what a book close mid-animation has anyway. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#token += 1;
    if (this.#warmTimer !== null) window.clearTimeout(this.#warmTimer);
    this.#warmTimer = null;
    this.#disposeRenderer();
    this.#dropWarm();
  }

  #disposeRenderer() {
    this.#renderer?.dispose();
    this.#renderer = null;
    this.#rendererOn = null;
    this.#rendererShape = "";
  }

  /**
   * Throw the prepared sheet away. A method rather than two lines inline: the
   * field is narrowed to `null` by the first assignment in both callers, so
   * reading it there does not type-check.
   */
  #dropWarm() {
    const warm = this.#warm;
    this.#warm = null;
    warm?.bitmap.close();
  }

  /** Page identity plus everything the snapshot's pixels depend on. */
  #key(rect: DOMRect): string {
    const page = this.#host.key();
    if (!page) return "";
    const size = `${Math.round(rect.width)}x${Math.round(rect.height)}@${window.devicePixelRatio}`;
    return `${page}|${size}|${this.#host.columns()}`;
  }

  /**
   * The renderer attached to this pane, built once and kept.
   *
   * Attaching is the half of a cold turn that no mask can be avoided for —
   * a WebGL context, two shader compiles, a 64x64 mesh and a texture upload —
   * so it happens during the idle pass and survives every turn after it. A
   * pane that moved or resized gets a fresh one: the canvas is sized in CSS px
   * at attach time and does not follow.
   */
  #ensureRenderer(pane: HTMLElement, rect: DOMRect): PageCurlRenderer {
    const shape = `${Math.round(rect.width)}x${Math.round(rect.height)}@${window.devicePixelRatio}`;
    const existing = this.#renderer;
    if (existing && this.#rendererOn === pane && this.#rendererShape === shape) return existing;
    existing?.dispose();
    const renderer = new PageCurlRenderer();
    renderer.attach(pane, rect.width, rect.height);
    renderer.setVisible(false);
    this.#renderer = renderer;
    this.#rendererOn = pane;
    this.#rendererShape = shape;
    return renderer;
  }

  #schedulePrepare(retry = false) {
    if (this.#disposed || this.#broken || !this.#enabled || this.#warmTimer !== null) return;
    if (retry) {
      // Bounded: a pointer that keeps moving keeps the arrows up, and there is
      // nothing to gain from photographing the pane behind them for ever.
      if (++this.#warmAttempts > PREPARE_ATTEMPTS) return;
    } else {
      this.#warmAttempts = 0;
    }
    this.#warmTimer = window.setTimeout(
      () => {
        this.#warmTimer = null;
        void this.#prepare();
      },
      retry ? PREPARE_RETRY_MS : PREPARE_DELAY_MS,
    );
  }

  /**
   * Snapshot the pane for the *next* turn, while nothing is waiting on it.
   *
   * The renderer is built either way — including when the sheet below cannot be
   * taken — because that is the half of a cold tap the reader would otherwise
   * pay for even though nothing was on screen to hide.
   *
   * The sheet itself is given up rather than forced when something needs
   * masking: hiding the flip arrows costs a painted frame, and — unlike a turn,
   * where the reader is already looking at the animation — the blink would
   * happen out of nowhere, with the cursor parked on the arrow that just
   * vanished. Such a turn captures cold instead, which is exactly what it did
   * before there was a warm path.
   */
  async #prepare(): Promise<void> {
    if (
      this.#disposed ||
      this.#broken ||
      !this.#enabled ||
      this.#inFlight ||
      this.#preparing ||
      this.#warm
    ) {
      return;
    }
    const pane = this.#host.pane();
    if (!pane) return;
    const rect = pane.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const key = this.#key(rect);
    if (!key) return;
    try {
      this.#ensureRenderer(pane, rect);
    } catch (cause) {
      this.#broken = true;
      console.warn("仿真翻页不可用，回到渲染器自己的动画", cause);
      return;
    }
    const restore = this.#host.maskChrome?.() ?? null;
    if (restore) {
      restore();
      this.#schedulePrepare(true);
      return;
    }
    this.#preparing = true;
    try {
      const image = await this.#host.capture({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      const bitmap = await createImageBitmap(new Blob([image]));
      // The pane moved on while this was in flight (a jump, a new size, a turn
      // that arrived first) — the sheet is of something that is no longer
      // there, so it is worth nothing.
      if (this.#disposed || this.#inFlight || !this.#enabled || this.#key(rect) !== key) {
        bitmap.close();
        return;
      }
      this.#dropWarm();
      this.#warm = { bitmap, key };
      this.#warmAttempts = 0;
    } catch (cause) {
      this.#broken = true;
      console.warn("仿真翻页预备截屏失败，后面的翻页走渲染器自己的动画", cause);
    } finally {
      this.#preparing = false;
    }
  }

  async #snapshot(rect: DOMRect): Promise<ArrayBuffer | null> {
    const restore = this.#host.maskChrome?.() ?? null;
    try {
      // The mask is only worth a paint wait when it hid something.
      if (restore) await waitForPaint();
      return await this.#host.capture({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    } finally {
      restore?.();
    }
  }

  #play(token: number, rtl: boolean): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        const renderer = this.#renderer;
        if (!renderer || token !== this.#token) return resolve();
        const t = Math.min(1, (now - start) / DURATION_MS);
        renderer.render(turnEase(t), rtl);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
}
