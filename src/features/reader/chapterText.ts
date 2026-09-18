import { paragraphAt, paragraphStart } from "@/features/reader/selection";
import type { SpeechSource, SpeechUnit } from "@/features/reader/speech";

/** A paragraph starting with this marker renders as an in-book image. */
export const IMAGE_PARAGRAPH_PREFIX = "￼";

/** A paragraph starting with this marker is an in-book link (EPUB table of
    contents entry): `<target chapter idx>\u{1F}<text>`, resolved at import
    time by the document parser. */
export const LINK_PARAGRAPH_PREFIX = "￻";
export const LINK_FIELD_SEPARATOR = "\u{1F}";

/** A paragraph starting with this marker is the chapter's wallpaper (a Kindle
    CSS page background): painted behind the text, never flowed inline. */
export const WALLPAPER_PARAGRAPH_PREFIX = "\u{FFFA}";

/** Parses a link-marker paragraph (`<marker><idx><sep><text>`) into its
    target chapter and visible text; `null` when malformed. */
export function parseLinkParagraph(paragraph: string): { idx: number; text: string } | null {
  const payload = paragraph.slice(LINK_PARAGRAPH_PREFIX.length);
  const separator = payload.indexOf(LINK_FIELD_SEPARATOR);
  if (separator < 0) return null;
  const idx = Number.parseInt(payload.slice(0, separator), 10);
  const text = payload.slice(separator + LINK_FIELD_SEPARATOR.length);
  return Number.isFinite(idx) && text ? { idx, text } : null;
}

/** Read-aloud sources for a chapter: image placeholders say nothing at all,
    link entries speak their visible text. */
export function speechSources(paragraphs: string[]): SpeechSource[] {
  const out: SpeechSource[] = [];
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX)) return;
    if (paragraph.startsWith(LINK_PARAGRAPH_PREFIX)) {
      const text = paragraph.split(LINK_FIELD_SEPARATOR)[1] ?? "";
      if (text.trim() !== "") out.push({ index, text });
      return;
    }
    if (paragraph.trim() !== "") out.push({ index, text: paragraph });
  });
  return out;
}

/** True for a paragraph that renders as running text — the only kind the
    read-aloud wash can be drawn on. */
export function isProseParagraph(paragraph: string | undefined): paragraph is string {
  return (
    paragraph !== undefined &&
    paragraph.trim() !== "" &&
    !paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX) &&
    !paragraph.startsWith(LINK_PARAGRAPH_PREFIX)
  );
}

/**
 * Index of the first utterance at or after `offset` in the chapter's joined
 * text — the sentence "read from here" lands on. Falls back to the top when
 * the offset is past the last unit, so the voice always starts somewhere.
 */
export function unitAtOffset(
  queue: readonly SpeechUnit[],
  paragraphs: string[],
  offset: number,
): number {
  const paragraph = paragraphAt(paragraphs, offset);
  const local = offset - paragraphStart(paragraphs, paragraph);
  const at = queue.findIndex(
    (unit) => unit.source > paragraph || (unit.source === paragraph && unit.end > local),
  );
  return at < 0 ? 0 : at;
}
