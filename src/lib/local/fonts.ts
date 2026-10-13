/**
 * Imported fonts: the bytes, and a blob URL the reader's own `@font-face` rule
 * loads them from.
 *
 * The URL is made once per font and kept until the font goes — a section
 * document declares the face itself, so the app's chrome never sees it.
 */

import type { LocalFont } from "@/types/ipc";

import * as db from "@/lib/local/db";
import { newId, now } from "./rows";

/* -------------------------------------------------------------------- fonts */

/** One imported font as it is stored: the bytes, and where the name came from. */
type StoredFont = {
  id: string;
  name: string;
  /** The name the reader picked it under. Kept for the same reason the desktop
   *  keeps its stored filename: resolving an id is a lookup, never a guess. */
  file: string;
  bytes: ArrayBuffer;
  addedAt: number;
};

/** Blob URLs, one per font, made once and kept until the font goes. */
const fontUrls = new Map<string, string>();

function fontUrlOf(font: StoredFont): string {
  const existing = fontUrls.get(font.id);
  if (existing) return existing;
  const url = URL.createObjectURL(new Blob([font.bytes]));
  fontUrls.set(font.id, url);
  return url;
}

/** The shape the reader's font picker reads — the same one the desktop answers
 *  with, so `fontFaceCss` never has to know which side it is on. */
const asLocalFont = (font: StoredFont): LocalFont => ({
  id: font.id,
  name: font.name,
  file: font.file,
  addedAt: font.addedAt,
  url: fontUrlOf(font),
});

export async function fontList(): Promise<LocalFont[]> {
  const rows = await db.all<StoredFont>("fonts");
  return rows.toSorted((a, b) => a.addedAt - b.addedAt).map(asLocalFont);
}

/**
 * Imports one picked font file.
 *
 * The `FontFace` load is the check, not a formality: it is what a corrupt file
 * — or a `.zip` someone renamed — fails, and failing here, while the reader is
 * looking at the button, is worth far more than a family that quietly renders
 * in the fallback stack the next time a book is opened.
 *
 * The loaded face is then thrown away on purpose. A book section is its own
 * document, so the face has to be declared *inside* it by CSS (`fontFaceCss`
 * takes the URL from here); registering it in this document's `document.fonts`
 * would style the app's own chrome and nothing else.
 */
export async function fontImportFile(file: File): Promise<LocalFont> {
  const bytes = await file.arrayBuffer();
  const id = newId();
  await new FontFace(`cr-${id}`, bytes).load();
  const name = file.name.replace(/\.[^.]+$/, "").trim() || file.name;
  const font: StoredFont = { id, name, file: file.name, bytes, addedAt: now() };
  await db.put("fonts", id, font);
  return asLocalFont(font);
}

export async function fontDelete(id: string): Promise<null> {
  await db.del("fonts", id);
  const url = fontUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    fontUrls.delete(id);
  }
  return null;
}
