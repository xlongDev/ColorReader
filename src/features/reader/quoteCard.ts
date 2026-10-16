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

/** Where the quote may live, and how much of it. */
const QUOTE_ZONE_TOP = 296;
const QUOTE_ZONE_H = 700;
/** Stepped down until the wrapped block fits; 30px is the floor. */
const QUOTE_SIZES = [76, 64, 54, 46, 40, 36, 32, 30] as const;
const LINE_HEIGHT = 1.55;

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
  const fit = fitQuote(withFont, input.quote, quoteWidth, QUOTE_ZONE_H);
  if (!fit) return false;

  // Paper.
  ctx.fillStyle = input.paper;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Metadata: title · authors, top-left, held to one line.
  const meta = ellipsize(withFont(30), [input.title, ...input.authors].join(" · "), quoteWidth);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = input.foreground;
  ctx.fillText(meta, MARGIN, MARGIN + 22);

  // The quote, centred in its zone, with the marker behind it.
  const lineAdvance = fit.size * LINE_HEIGHT;
  const blockHeight = fit.lines.length * lineAdvance;
  const firstBaseline = QUOTE_ZONE_TOP + (QUOTE_ZONE_H - blockHeight) / 2 + fit.size * 0.82;
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
  ctx.fillText(
    progressLine(input.progress, input.chapterIdx),
    CARD_W / 2,
    QUOTE_ZONE_TOP + QUOTE_ZONE_H + 56,
  );

  // The wordmark, bottom-left, level with the plate's bottom edge.
  ctx.font = `26px ${font}`;
  ctx.globalAlpha = 0.45;
  ctx.textAlign = "left";
  ctx.fillText("ColorReader", MARGIN, CARD_H - MARGIN);

  drawQr(ctx, input.link, CARD_W - MARGIN - QR_PLATE, CARD_H - MARGIN - QR_PLATE);
  return true;
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
