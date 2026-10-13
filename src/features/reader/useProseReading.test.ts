import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  IMAGE_PARAGRAPH_PREFIX,
  LINK_FIELD_SEPARATOR,
  LINK_PARAGRAPH_PREFIX,
} from "@/features/reader/chapterText";
import { useProseReading, type ProseReadingOptions } from "@/features/reader/useProseReading";
import type { ReadingSurface } from "@/features/reader/theme";
import { HIGHLIGHT_COLORS } from "@/stores/reader";
import type { Annotation, ChapterContent } from "@/types/ipc";

/**
 * The prose flow as the page composes it.
 *
 * Three promises here fail silently, which is why they are worth a test of
 * their own: a paragraph list that loses the annotation's colour leaves every
 * saved highlight reading as the palette's yellow (the same as a legacy one),
 * a search match that stops splitting a run leaves the query's words
 * unwashable, and a `markInk` that answers the wrong shape paints a squiggly
 * where the reader asked for a straight line. The fourth — which ink a
 * wallpaper chapter gets — is the one the eye notices immediately, so it is
 * pinned here too.
 */

const LIGHT: ReadingSurface = {
  key: "paper",
  label: "纸",
  background: "#faf7f0",
  fg: "#241f1a",
  tint: "#efe9dd",
  mode: "light",
};

const DARK: ReadingSurface = {
  ...LIGHT,
  key: "night",
  label: "夜",
  background: "#16181d",
  fg: "#e8e6e1",
  tint: "#22252b",
  mode: "dark",
};

const MARKER_YELLOW = HIGHLIGHT_COLORS[0]!.hex;

/** A CSS custom property is not in `CSSProperties`; the flow hands React the
 *  plain object this reads back. */
const vars = (style: object) => style as Record<string, string | undefined>;

function chapter(paragraphs: string[]): ChapterContent & { wallpaper: string | null } {
  return { idx: 0, title: "第一章", paragraphs, wallpaper: null };
}

function annotation(
  chapterIdx: number,
  startChar: number,
  endChar: number,
  over: Partial<Annotation> = {},
): Annotation {
  return {
    id: "a1",
    bookId: "b1",
    chapterIdx,
    startChar,
    endChar,
    text: "",
    cfi: null,
    color: "#ff0000",
    style: "underline",
    note: null,
    createdAt: 0,
    ...over,
  };
}

function options(over: Partial<ProseReadingOptions> = {}): ProseReadingOptions {
  return {
    displayChapterData: chapter(["你好世界", "abc"]),
    annotations: [],
    chapterIdx: 0,
    search: "",
    speechSpan: null,
    fontSize: 18,
    font: "serif",
    lineHeightIdx: 1,
    margin: 20,
    blockMargin: 24,
    columnWidth: undefined,
    viewportH: 600,
    pinnedW: null,
    wallpaperPath: null,
    surface: LIGHT,
    ...over,
  };
}

describe("useProseReading", () => {
  it("splits the paragraph where an annotation covers it, and keeps its ink", () => {
    // "你好世界\nabc": chars 1..3 of paragraph 0 is 好世.
    const { result } = renderHook(() =>
      useProseReading(options({ annotations: [annotation(0, 1, 3)] })),
    );

    expect(result.current.renderedParagraphs[0]!.segments).toEqual([
      {
        key: "0-0-0",
        text: "你",
        highlighted: false,
        annotationId: undefined,
        tts: undefined,
        color: null,
        style: null,
      },
      {
        key: "0-0-1",
        text: "好世",
        highlighted: true,
        annotationId: "a1",
        tts: undefined,
        color: "#ff0000",
        style: "underline",
      },
      {
        key: "0-0-2",
        text: "界",
        highlighted: false,
        annotationId: undefined,
        tts: undefined,
        color: null,
        style: null,
      },
    ]);
    // Keys are chapter-scoped, so a matched paragraph in another chapter never
    // collides with this one's list.
    expect(result.current.renderedParagraphs.map((paragraph) => paragraph.key)).toEqual([
      "0-0",
      "0-1",
    ]);
  });

  it("reads another chapter's annotation as no ink at all", () => {
    const { result } = renderHook(() =>
      useProseReading(options({ annotations: [annotation(1, 1, 3)] })),
    );

    const segments = result.current.renderedParagraphs[0]!.segments;
    expect(segments.some((segment) => segment.highlighted)).toBe(false);
    expect(segments.every((segment) => segment.color === null)).toBe(true);
  });

  it("washes the search query's occurrences into the flow", () => {
    const { result } = renderHook(() =>
      useProseReading(options({ displayChapterData: chapter(["aXbXc"]), search: "x" })),
    );

    expect(
      result.current.renderedParagraphs[0]!.segments.map((segment) => segment.highlighted),
    ).toEqual([false, true, false, true, false]);
  });

  it("washes the run the voice is on, and no other paragraph", () => {
    const { result } = renderHook(() =>
      useProseReading(
        options({
          displayChapterData: chapter(["你好世界", "abc"]),
          speechSpan: { start: 1, end: 3, source: 0 },
        }),
      ),
    );

    const [first, second] = result.current.renderedParagraphs;
    expect(first!.segments.filter((segment) => segment.tts).map((segment) => segment.text)).toEqual(
      ["好世"],
    );
    expect(second!.segments.some((segment) => segment.tts)).toBe(false);
  });

  it("hands an image marker out as the picture it names, not as text", () => {
    const { result } = renderHook(() =>
      useProseReading(
        options({ displayChapterData: chapter([`${IMAGE_PARAGRAPH_PREFIX}cover.png`, "正文"]) }),
      ),
    );

    const [image, text] = result.current.renderedParagraphs;
    // The split keeps the marker paragraph whole; it is the flow that reads
    // `imagePath` first and draws the picture instead of the text.
    expect(image!.imagePath).toBe("cover.png");
    expect(image!.segments.map((segment) => segment.text)).toEqual([
      `${IMAGE_PARAGRAPH_PREFIX}cover.png`,
    ]);
    expect(text!.imagePath).toBeNull();
    expect(text!.segments.map((segment) => segment.text)).toEqual(["正文"]);
  });

  it("hands a link marker out as the entry it names", () => {
    const { result } = renderHook(() =>
      useProseReading(
        options({
          displayChapterData: chapter([
            `${LINK_PARAGRAPH_PREFIX}3${LINK_FIELD_SEPARATOR}目录`,
            "正文",
          ]),
        }),
      ),
    );

    expect(result.current.renderedParagraphs[0]!.link).toEqual({ idx: 3, text: "目录" });
    expect(result.current.renderedParagraphs[1]!.link).toBeNull();
  });

  it("paints the ink in the shape the annotation asked for", () => {
    const { result } = renderHook(() => useProseReading(options()));

    const underline = result.current.markInk("#123456", "underline");
    expect(underline.textDecoration).toBe("underline");
    expect(underline.textDecorationColor).toBe("#123456");

    const squiggly = result.current.markInk("#123456", "squiggly");
    expect(squiggly.textDecoration).toBe("underline wavy");

    // A legacy highlight carries no colour and no style: the palette's marker
    // yellow, in the translucent wash.
    const legacy = result.current.markInk(null, null);
    expect(legacy.textDecoration).toBeUndefined();
    expect(legacy.backgroundColor).toBe(`rgba(255, 209, 46, 0.36)`);
    expect(MARKER_YELLOW).toBe("#ffd12e");
  });

  it("lays a lighter wash on dark paper than on light", () => {
    const light = renderHook(() => useProseReading(options())).result.current.markInk(
      "#abcdef",
      "highlight",
    );
    const dark = renderHook(() =>
      useProseReading(options({ surface: DARK })),
    ).result.current.markInk("#abcdef", "highlight");

    expect(light.backgroundColor).toBe("rgba(171, 205, 239, 0.36)");
    expect(dark.backgroundColor).toBe("rgba(171, 205, 239, 0.26)");
  });

  it("keeps the ink dark on a wallpaper chapter, and follows the surface otherwise", () => {
    const paper = renderHook(() => useProseReading(options())).result.current.articleStyle;
    const wallpaper = renderHook(() => useProseReading(options({ wallpaperPath: "paper.png" })))
      .result.current.articleStyle;

    expect(paper.color).toBe(LIGHT.fg);
    // Wallpaper chapters read off the book's own paper art, light in both
    // themes, so the ink cannot follow a dark surface there.
    expect(wallpaper.color).toBe("#3f3629");
  });

  it("builds the column grid only for the paged layouts, with a measured page box", () => {
    const flow = renderHook(() => useProseReading(options())).result.current.articleStyle;
    const paged = renderHook(() => useProseReading(options({ columnWidth: 320, viewportH: 812 })))
      .result.current.articleStyle;

    // The custom property is not in `CSSProperties`, so it is read as a plain
    // record — the same shape the flow hands React.
    expect(flow.columnWidth).toBeUndefined();
    expect(vars(flow)["--page-h"]).toBeUndefined();
    expect(paged.columnWidth).toBe(320);
    expect(paged.columnFill).toBe("auto");
    expect(vars(paged)["--page-h"]).toBe("812px");
    // A sidebar mid-spring freezes the width, so the per-frame resize never
    // re-wraps the chapter.
    const spring = renderHook(() => useProseReading(options({ pinnedW: 400 }))).result.current
      .articleStyle;
    expect(spring.width).toBe(400);
  });
});
