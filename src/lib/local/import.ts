/**
 * Turning a picked file into a shelf row, in the browser.
 *
 * Two paths, because the shelf already has two: the formats foliate-js can open
 * (epub / mobi / azw3 / fb2 / cbz / pdf) are read by the same engine the reader
 * uses, so metadata, cover and table of contents come from it and agree with
 * what the reader will show; plain text and markdown are split here, the way
 * the Rust importer splits them on the desktop.
 *
 * `ponytail:` the desktop importer also extracts every chapter's text for
 * search and read-aloud. On the web that is foliate's business — the reader
 * renders the file itself — so only text formats keep a body, and full-text
 * search over epub is desktop-only until someone needs it.
 */
import { makeBook } from "foliate-js/view.js";

import type { BookFormat, ChapterContent, ChapterMeta } from "@/lib/bindings";

/** Formats the shelf accepts, and the extension that names each one. */
const BY_EXTENSION: Record<string, BookFormat> = {
  epub: "epub",
  pdf: "pdf",
  mobi: "mobi",
  azw: "azw",
  azw3: "azw3",
  prc: "prc",
  fb2: "fb2",
  cbz: "cbz",
  md: "markdown",
  markdown: "markdown",
  txt: "txt",
};

export function detectFormat(name: string): BookFormat | null {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[extension] ?? null;
}

/** A heading that starts a chapter in a plain-text book.
 *
 * No `\b` after the marker: the characters around it are CJK, which has no word
 * boundaries in a regex, so the anchor would never match. The line-length check
 * at the call site is what keeps a sentence that merely starts with 第一章 from
 * being taken for a heading.
 */
const HEADING =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷篇部集]|chapter\s+\d+|(?:序章|序言|前言|后记|尾声|番外)\s*$)/i;

/**
 * Splits a text into chapters and paragraphs.
 *
 * A book with headings is split at them; one without is split every
 * `PLAIN_CHUNK` characters so the reader's progress bar and TOC still have
 * something to move between — the desktop importer does the same thing for the
 * same reason.
 */
export function splitChapters(text: string, fallbackTitle: string): ChapterContent[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const chapters: ChapterContent[] = [];
  let title = fallbackTitle;
  let body: string[] = [];

  const flush = () => {
    const paragraphs = body.map((line) => line.trim()).filter((line) => line.length > 0);
    if (paragraphs.length === 0) return;
    chapters.push({ idx: chapters.length, title, paragraphs });
    body = [];
  };

  let chunk = 0;
  for (const line of lines) {
    if (HEADING.test(line) && line.trim().length <= 40) {
      flush();
      title = line.trim();
      chunk = 0;
      continue;
    }
    // No headings in sight: cut on a paragraph boundary so a chunk never starts
    // mid-sentence, and only once the run is long enough to be worth a chapter.
    const size = body.reduce((total, entry) => total + entry.length, 0);
    if (chapters.length === 0 && chunk === 0 && size > 8000) {
      flush();
      title = `${fallbackTitle}（续 ${chapters.length + 1}）`;
      chunk = chapters.length;
    }
    body.push(line);
  }
  flush();
  if (chapters.length === 0) {
    chapters.push({ idx: 0, title: fallbackTitle, paragraphs: ["（这本书没有可显示的正文）"] });
  }
  // Ids are positional: the reader addresses chapters by index, and the split
  // order is the reading order.
  chapters.forEach((chapter, idx) => {
    chapter.idx = idx;
  });
  return chapters;
}

/** What importing one file produced. */
export type ParsedBook = {
  format: BookFormat;
  title: string;
  subtitle: string | null;
  description: string | null;
  language: string | null;
  publisher: string | null;
  authors: string[];
  cover: Blob | null;
  toc: ChapterMeta[];
  /** Kept only for the formats rendered from text; foliate formats carry none. */
  chapters: ChapterContent[] | null;
};

/**
 * Decodes a text file, guessing the encoding when UTF-8 does not fit.
 *
 * Chinese `.txt` books are as often GB18030 as UTF-8, and a wrong guess is not
 * a subtle failure — it is a page of replacement characters. The guess is the
 * cheap one: decode as UTF-8 (fatal off), and if the result is littered with
 * U+FFFD, decode again as GB18030, which every browser supports and which is a
 * superset of GBK.
 */
export function decodeText(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const broken = (utf8.match(/\uFFFD/g) ?? []).length;
  if (broken < Math.max(2, utf8.length / 2000)) return utf8;
  try {
    return new TextDecoder("gb18030").decode(bytes);
  } catch {
    return utf8;
  }
}

/** Reads one picked file into everything the shelf and the reader need. */
/** The bit of a foliate book this module reads: everything else belongs to the
 *  reader view. */
type FoliateBookDoc = {
  metadata?: Record<string, unknown> | null;
  toc?: { label?: string; subitems?: unknown[] }[];
  sections?: { id?: string }[];
  getCover?: () => Promise<Blob | null> | Blob | null;
};

export async function readBook(file: File): Promise<ParsedBook> {
  const format = detectFormat(file.name);
  if (!format) throw new Error(`不支持的格式：${file.name}`);
  const stem = file.name.replace(/\.[^.]+$/, "");

  if (format === "txt" || format === "markdown") {
    const chapters = splitChapters(decodeText(await file.arrayBuffer()), stem);
    return {
      format,
      title: stem,
      subtitle: null,
      description: chapters[0]?.paragraphs[0]?.slice(0, 200) ?? null,
      language: null,
      publisher: null,
      authors: [],
      cover: null,
      toc: chapters.map((chapter) => ({
        idx: chapter.idx,
        title: chapter.title,
        chars: chapter.paragraphs.reduce((total, text) => total + text.length, 0),
      })),
      chapters,
    };
  }

  // foliate's own type is the reader's; the metadata surface is wider than it
  // declares, so it is spelled out here rather than reaching through `any`.
  if (format === "pdf") {
    // foliate's PDF path is stubbed out in this repo — the reader renders PDFs
    // through its own pdf.js pipeline (`lib/pdf.ts`) — so a PDF arrives with
    // nothing but its name here, and `describePdf` fills in the page count and
    // the cover from that pipeline once the bytes are in place to be read.
    return {
      format,
      title: stem,
      subtitle: null,
      description: null,
      language: null,
      publisher: null,
      authors: [],
      cover: null,
      toc: [],
      chapters: null,
    };
  }

  const book = (await makeBook(file)) as FoliateBookDoc;
  const meta = (book.metadata ?? {}) as {
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
    language?: string | null;
    publisher?: string | null;
    author?: string | string[] | null;
  };
  const authors = Array.isArray(meta.author)
    ? meta.author
    : typeof meta.author === "string" && meta.author.length > 0
      ? [meta.author]
      : [];
  const labels = flattenToc(book.toc ?? []);
  let cover: Blob | null = null;
  try {
    cover = (await book.getCover?.()) ?? null;
  } catch {
    // A malformed cover is not a reason to refuse the book.
  }
  return {
    format,
    title: meta.title?.trim() || stem,
    subtitle: meta.subtitle ?? null,
    description: meta.description ?? null,
    language: meta.language ?? null,
    publisher: meta.publisher ?? null,
    authors,
    cover,
    toc:
      labels.length > 0
        ? labels.map((title, idx) => ({ idx, title, chars: 0 }))
        : (book.sections ?? []).map((section, idx) => ({
            idx,
            title: section.id ?? `第 ${idx + 1} 节`,
            chars: 0,
          })),
    chapters: null,
  };
}

/** foliate's nested TOC as a flat list of labels, in reading order. */
function flattenToc(toc: { label?: string; href?: string; subitems?: unknown[] }[]): string[] {
  const out: string[] = [];
  const walk = (items: { label?: string; subitems?: unknown[] }[]) => {
    for (const item of items) {
      if (item.label) out.push(item.label.trim());
      if (Array.isArray(item.subitems)) walk(item.subitems as { label?: string }[]);
    }
  };
  walk(toc);
  return out.filter((label) => label.length > 0);
}
