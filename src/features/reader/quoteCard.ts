/**
 * The golden-quote share card, drawn on a canvas.
 *
 * A page torn out of the reader's own book: the paper is the surface they are
 * reading on right now, the words sit in their reading font, and their own
 * highlight ink paints behind them like a real marker. The QR bottom-right
 * carries the deep link back to the exact highlight (`colorreader://book/<id>
 * ?annotation=<id>`, the link the notes export already writes — mirrored here
 * as one line, pinned by a test against the Rust side's own).
 *
 * Why canvas and not DOM: the card is a still image at a fixed 1080x1440, and
 * a DOM tree rasterised through an offscreen render would need the whole
 * reading surface's CSS re-hosting inside a hidden document. Drawing it is
 * fewer moving parts, and every measurement the layout makes is a
 * `measureText` call the same engine will honour when it paints.
 *
 * Three deliberate limits, all with a named ceiling:
 *
 * - The paper is a flat colour. Two surfaces (纸纹, 亚麻) paint a repeating
 *   line texture over it and one (自定义) paints a user image; a canvas
 *   `fillStyle` takes neither. The texture stays on screen where CSS can
 *   draw it; the card carries the colour, which is what reads across a
 *   share anyway.
 * - The quote is fitted by stepping a fixed size scale down until the wrapped
 *   block fits its zone. Below the smallest step the card is refused rather
 *   than shrunk into unreadable mush — the caller says so and offers nothing
 *   else to press.
 * - CJK line breaking is greedy at character boundaries with Latin words kept
 *   whole. It is not a full UAX #14 implementation, and it does not need to
 *   be: highlights are short, and the failure mode of the greedy pass (a
 *   slightly early break) is invisible next to the failure mode of a
 *   misplaced kinsoku rule (a line that starts with punctuation).
 * The cover, when the book has one, turns the top band into a title page: the
 * thumbnail left, the book's name beside it, the quote zone dropping below
 * them. It is contained — a rounded box with one hairline, never a full-bleed
 * backdrop — because the paper is still the reader's and the quote is still
 * the point. A book with no cover draws exactly the card it drew before.
 */

import QRCode from "qrcode";

export interface QuoteCardInput {
  /** The highlighted words, as the corpus holds them. */
  quote: string;
  title: string;
  authors: string[];
  /** 0..1, the book's own progress. `null` when it was never opened. */
  progress: number | null;
  /** 0-based, as the annotation stores it. */
  chapterIdx: number;
  /** The highlight's ink (e.g. "#ffd12e"); `null` is the legacy yellow. */
  ink: string | null;
  /** The reading surface's paper colour, flat. */
  paper: string;
  /** The reading surface's ink, contrast-checked against the paper. */
  foreground: string;
  /** A CSS font stack — the reader's reading font. */
  font: string;
  /** The deep link the QR carries. */
  link: string;
  /**
   * The book's cover, decoded. `null` — or an `<img>` that never finished
   * loading — draws the card without one; the caller does not have to wait
   * for the bytes to let the reader see their page.
   */
  cover: HTMLImageElement | null;
}

/** The slice of a 2D context the layout maths needs — small enough to fake. */
export interface TextMeasure {
  measureText(text: string): { width: number };
}

/** 3:4, the shape every share surface asks for. */
const CARD_W = 1080;
const CARD_H = 1440;
/** One generous margin; the card is mostly air. */
const MARGIN = 88;

/** The cover thumbnail, top-left, when the book has one. */
const COVER_W = 168;
const COVER_H = 236;
const COVER_R = 14;
/** Cover → the book's name beside it. */
const COVER_GAP = 40;

/** Where the quote may live. The bottom never moves — progress, wordmark and
 *  plate keep the rhythm they have always had — and the top drops below the
 *  cover band when the card carries one. */
const QUOTE_ZONE_BOTTOM = 996;
const QUOTE_ZONE_TOP = 296;
const QUOTE_ZONE_TOP_WITH_COVER = 380;
/** Stepped down until the wrapped block fits; 30px is the floor. */
const QUOTE_SIZES = [76, 64, 54, 46, 40, 36, 32, 30] as const;
const LINE_HEIGHT = 1.55;

/** The book's name, set beside the cover rather than above it. */
const TITLE_SIZE = 36;
const AUTHORS_SIZE = 26;

/** The ink a highlight with no colour of its own had before colours existed. */
const LEGACY_INK = "#ffd12e";
/** How hard the marker presses: visible on day paper and on night alike. */
const WASH_ALPHA = 0.26;

/** The QR sits on a white plate on every paper — scannability outranks
 *  surface fidelity, and a night surface's own ink is too pale to scan. */
const QR_PLATE = 224;
const QR_INK = "#20242a";
const QR_MAX_CELL = 8;

/**
 * The link the notes export writes, mirrored for the card.
 *
 * `export.rs::link` is the other end of this contract (it also *parses* the
 * scheme in `AppShell`); this one line is pinned by a test against the same
 * literal the Rust test asserts, so the two cannot drift apart silently.
 */
export const annotationLink = (bookId: string, annotationId: string): string =>
  `colorreader://book/${bookId}?annotation=${annotationId}`;

/** `resolveFont` can hand back a CSS variable (`var(--font-sans)` for the
 *  book and system keys), and a canvas cannot resolve one — the variable's
 *  literal value is read out of the document instead. */
export function canvasFont(stack: string): string {
  const variable = /var\((--[\w-]+)\)/.exec(stack);
  if (!variable) return stack;
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable[1]!).trim();
  return value || stack;
}

/** The first family of a stack — what `document.fonts.load` is asked for. */
function firstFamily(stack: string): string {
  const first = stack.split(",")[0]!.trim();
  return first.replace(/^["']|["']$/g, "");
}

/**
 * The face has to be in the document before the canvas can draw it: a
 * catalogue font's subsets are fetched on demand, and drawing before they
 * land gives a card set in whatever the stack falls through to. A shorthand
 * no face in the document matches resolves without loading anything, which
 * is the system-font case and needs no wait.
 */
async function awaitFont(font: string, size: number): Promise<void> {
  const faces = document.fonts;
  if (!faces?.load) return;
  try {
    await faces.load(`400 ${size}px ${firstFamily(font)}`);
    await faces.ready;
  } catch {
    // No matching face: the stack's next entry is already installed.
  }
}

/** Wide (CJK) characters may break on either side; Latin ones may not split
 *  a word. The property escapes match what the corpus actually holds. */
function isWide(char: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char);
}

/**
 * Greedy wrap that keeps Latin words whole.
 *
 * `maxWidth` is in the current font's pixels, so the caller sets the font
 * before measuring. A line that is a single word longer than the whole
 * measure breaks mid-word: that is the only case where the alternative
 * (overflowing) is worse.
 */
export function wrapLines(measure: TextMeasure, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  // A run of whitespace is one space, and a highlight with newlines in it
  // wraps like prose rather than keeping the corpus's line structure.
  for (const char of text.replace(/\s+/g, " ").trim()) {
    if (line !== "" && measure.measureText(line + char).width > maxWidth) {
      const lastSpace = line.lastIndexOf(" ");
      if (!isWide(char) && lastSpace > 0) {
        // Mid-word: back up to the last space and carry the rest down.
        lines.push(line.slice(0, lastSpace));
        line = `${line.slice(lastSpace + 1)}${char}`;
      } else {
        lines.push(line);
        line = char === " " ? "" : char;
      }
    } else {
      line += char;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * The largest quote size whose wrapped block fits the zone, or `null` when
 * even the floor overflows — the card's one refusal.
 */
export function fitQuote(
  withFont: (size: number) => TextMeasure,
  quote: string,
  maxWidth: number,
  maxHeight: number,
): { size: number; lines: string[] } | null {
  for (const size of QUOTE_SIZES) {
    const lines = wrapLines(withFont(size), quote, maxWidth);
    if (lines.length * size * LINE_HEIGHT <= maxHeight) return { size, lines };
  }
  return null;
}

/** Cut to fit with an ellipsis, for the metadata line. */
export function ellipsize(measure: TextMeasure, text: string, maxWidth: number): string {
  if (measure.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && measure.measureText(`${cut}…`).width > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** "读到 37% · 第 5 章", or just the chapter for a book never opened. */
export function progressLine(progress: number | null, chapterIdx: number): string {
  const chapter = `第 ${chapterIdx + 1} 章`;
  return progress === null ? chapter : `读到 ${Math.round(progress * 100)}% · ${chapter}`;
}

/**
 * The source rectangle that centre-crops `natural` into `box`'s aspect.
 *
 * The canvas spelling of `object-fit: cover`, which is how every cover in the
 * app is already shown — a cover is drawn at whatever ratio its publisher
 * chose, and the card's box is fixed. Wider than the box loses the sides,
 * taller loses the top and bottom, square loses a little of both; a cover
 * already at the box's ratio passes through untouched.
 */
export function coverCrop(
  natural: { width: number; height: number },
  box: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number } {
  const boxRatio = box.width / box.height;
  const wider = natural.width / natural.height > boxRatio;
  const sw = wider ? natural.height * boxRatio : natural.width;
  const sh = wider ? natural.height : natural.width / boxRatio;
  return { sx: (natural.width - sw) / 2, sy: (natural.height - sh) / 2, sw, sh };
}

/** A rounded path without `roundRect` — the app ships on WKWebView versions
 *  older than Safari 16, and one helper keeps every corner the same. */
function roundedPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draws the card onto `canvas`.
 *
 * Returns `false` when the quote does not fit even at the smallest size —
 * nothing is drawn, and the caller is expected to say so rather than offer a
 * broken save. The canvas is sized to the card's own pixels either way, so a
 * caller that skips the return value gets a correctly-sized blank.
 */
export async function renderQuoteCard(
  canvas: HTMLCanvasElement,
  input: QuoteCardInput,
): Promise<boolean> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  canvas.width = CARD_W;
  canvas.height = CARD_H;

  const font = canvasFont(input.font);
  await awaitFont(font, QUOTE_SIZES[0]);
  const withFont = (size: number): TextMeasure => {
    ctx.font = `${size}px ${font}`;
    return ctx;
  };

  const quoteWidth = CARD_W - 2 * MARGIN;
  // An `<img>` that never decoded has no size to crop, and the card it
  // belongs to is the coverless one.
  const cover =
    input.cover && input.cover.naturalWidth > 0 && input.cover.naturalHeight > 0
      ? input.cover
      : null;
  const zoneTop = cover ? QUOTE_ZONE_TOP_WITH_COVER : QUOTE_ZONE_TOP;
  const zoneH = QUOTE_ZONE_BOTTOM - zoneTop;
  const fit = fitQuote(withFont, input.quote, quoteWidth, zoneH);
  if (!fit) return false;

  // Paper.
  ctx.fillStyle = input.paper;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // The top band. With a cover it is a title page — the thumbnail at the
  // margin, the book's name beside it, the two set as one block against the
  // cover's own height. Without one it is the single muted line the card has
  // always opened with, unchanged.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  if (cover) {
    drawCover(ctx, cover, input.foreground);
    const nameX = MARGIN + COVER_W + COVER_GAP;
    const nameW = CARD_W - MARGIN - nameX;
    const blockH = TITLE_SIZE * 1.25 + AUTHORS_SIZE * 1.25;
    const top = MARGIN + (COVER_H - blockH) / 2;
    const title = ellipsize(withFont(TITLE_SIZE), input.title, nameW);
    const authors = input.authors.length
      ? ellipsize(withFont(AUTHORS_SIZE), input.authors.join(" · "), nameW)
      : "";
    ctx.fillStyle = input.foreground;
    ctx.font = `${TITLE_SIZE}px ${font}`;
    ctx.globalAlpha = 0.9;
    ctx.fillText(title, nameX, top + TITLE_SIZE * 0.8);
    if (authors) {
      ctx.font = `${AUTHORS_SIZE}px ${font}`;
      ctx.globalAlpha = 0.55;
      ctx.fillText(authors, nameX, top + TITLE_SIZE * 1.25 + AUTHORS_SIZE * 0.8);
    }
  } else {
    const meta = ellipsize(withFont(30), [input.title, ...input.authors].join(" · "), quoteWidth);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = input.foreground;
    ctx.fillText(meta, MARGIN, MARGIN + 22);
  }

  // The quote, centred in its zone, with the marker behind it.
  const lineAdvance = fit.size * LINE_HEIGHT;
  const blockHeight = fit.lines.length * lineAdvance;
  const firstBaseline = zoneTop + (zoneH - blockHeight) / 2 + fit.size * 0.82;
  const ink = input.ink ?? LEGACY_INK;

  ctx.globalAlpha = WASH_ALPHA;
  ctx.fillStyle = ink;
  fit.lines.forEach((line, index) => {
    const width = ctx.measureText(line).width;
    const x = (CARD_W - width) / 2;
    const top = firstBaseline + index * lineAdvance - fit.size * 0.82;
    roundedPath(ctx, x - 22, top + lineAdvance * 0.06, width + 44, lineAdvance * 0.88, 10);
    ctx.fill();
  });

  ctx.globalAlpha = 1;
  ctx.fillStyle = input.foreground;
  ctx.textAlign = "center";
  fit.lines.forEach((line, index) => {
    ctx.fillText(line, CARD_W / 2, firstBaseline + index * lineAdvance);
  });

  // Progress, below the zone, under the quote.
  ctx.font = `28px ${font}`;
  ctx.globalAlpha = 0.55;
  ctx.fillText(progressLine(input.progress, input.chapterIdx), CARD_W / 2, QUOTE_ZONE_BOTTOM + 56);

  // The wordmark, bottom-left, level with the plate's bottom edge.
  ctx.font = `26px ${font}`;
  ctx.globalAlpha = 0.45;
  ctx.textAlign = "left";
  ctx.fillText("ColorReader", MARGIN, CARD_H - MARGIN);

  drawQr(ctx, input.link, CARD_W - MARGIN - QR_PLATE, CARD_H - MARGIN - QR_PLATE);
  return true;
}

/** The cover in its box: centre-cropped like every cover in the app, corners
 *  rounded to match the plate, and one hairline so it reads as an object
 *  lying on the paper rather than printed into it. */
function drawCover(ctx: CanvasRenderingContext2D, cover: HTMLImageElement, fg: string): void {
  // The intrinsic size, not `width`/`height` — those are the element's
  // attributes and read 0 on an image the markup never sized.
  const natural = { width: cover.naturalWidth, height: cover.naturalHeight };
  const crop = coverCrop(natural, { width: COVER_W, height: COVER_H });

  // An SVG cover is rasterised by the engine at draw time, and a
  // nine-argument drawImage — the only form that crops — samples it wrongly
  // on a canvas this size: Chromium measured the crop selecting the image's
  // top-left corner instead of its centre, so the whole box came out one
  // flat colour (the five-argument form, which cannot crop, was correct).
  // Compositing the image once into a bitmap first turns the source into
  // pixels the crop then addresses exactly, and costs one canvas the size
  // of the cover. Raster covers did not need this; they get it anyway,
  // because "is this an SVG" is not a question worth asking here.
  const bitmap = document.createElement("canvas");
  bitmap.width = natural.width;
  bitmap.height = natural.height;
  const source = bitmap.getContext("2d");
  if (!source) return;
  source.drawImage(cover, 0, 0);

  roundedPath(ctx, MARGIN, MARGIN, COVER_W, COVER_H, COVER_R);
  ctx.save();
  ctx.clip();
  ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, MARGIN, MARGIN, COVER_W, COVER_H);
  ctx.restore();
  roundedPath(ctx, MARGIN, MARGIN, COVER_W, COVER_H, COVER_R);
  ctx.strokeStyle = fg;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** The QR on its white plate: modules in a fixed near-black, quiet zone
 *  carved out of the plate's margin, and a hairline so the plate reads as a
 *  plate on paper nearly its own colour. */
function drawQr(ctx: CanvasRenderingContext2D, link: string, x: number, y: number): void {
  const qr = QRCode.create(link, { errorCorrectionLevel: "M" });
  const count = qr.modules.size;
  const cell = Math.min(QR_MAX_CELL, Math.floor((QR_PLATE - 64) / count));
  const side = cell * count;
  const offset = (QR_PLATE - side) / 2;

  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  roundedPath(ctx, x, y, QR_PLATE, QR_PLATE, 28);
  ctx.fill();
  ctx.strokeStyle = "#20242a";
  ctx.globalAlpha = 0.12;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.globalAlpha = 1;
  ctx.fillStyle = QR_INK;
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.modules.get(row, col)) continue;
      ctx.fillRect(x + offset + col * cell, y + offset + row * cell, cell, cell);
    }
  }
}
