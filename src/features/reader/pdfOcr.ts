/**
 * Turning a scanned page into an image a vision model can read.
 *
 * Deliberately **not** the canvas the reader is looking at: that one is drawn
 * in whatever palette the night surface asked for, possibly with its images
 * inverted, and at whatever zoom the reader happens to be at. A model handed a
 * page from night mode reads it upside down in tone and answers accordingly.
 *
 * So this re-renders the page from the source document, once, at a fixed size
 * chosen for legibility rather than for the screen — and hands back a JPEG
 * data URL, which is the shape every OpenAI-compatible endpoint takes directly
 * and which keeps a PNG of a dense page from costing more to upload than the
 * page weighs on disk.
 */

import { loadDoc } from "@/lib/pdf";

/**
 * Longest edge of the image sent. A vision model reads a printed page well
 * from about 1500px on its long edge and gains nothing legible above it, while
 * the bytes scale with area: doubling this quadruples the upload.
 *
 * `ponytail:` one number, tuned by eye on a real scan. Raise it if a page of
 * small print comes back with dropped lines, lower it if a chapter page is
 * costing more than it should.
 */
const LONGEST_EDGE = 1600;

/** JPEG quality. Below ~0.7 text starts to smear at the sizes we send. */
const QUALITY = 0.82;

/** What one page costs to send, for the readers that would like to know. */
export const MAX_OCR_BYTES = 8 * 1024 * 1024;

/**
 * Renders `pageNumber` (1-based) as a base64 JPEG data URL.
 *
 * Not attached to the DOM and not kept: the canvas is released as soon as the
 * data URL exists, because a page-sized bitmap at this scale is 8–12 MB and the
 * reader already has one (the one on screen) that this is deliberately not
 * reusing.
 */
export async function pageImageDataUrl(bookId: string, pageNumber: number): Promise<string> {
  const doc = await loadDoc(bookId);
  const page = await doc.getPage(pageNumber);
  const unit = page.getViewport({ scale: 1 });
  const scale = Math.min(LONGEST_EDGE / Math.max(unit.width, unit.height), 2);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(Math.floor(viewport.width), 1);
  canvas.height = Math.max(Math.floor(viewport.height), 1);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("这一页画不出来");
  // No night wrapper and no `background`: the model wants the document's own
  // colours on white paper, which is what pdf.js paints by default.
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const url = canvas.toDataURL("image/jpeg", QUALITY);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}
