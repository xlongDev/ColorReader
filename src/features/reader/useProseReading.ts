import { useCallback, useMemo, type CSSProperties } from "react";

import {
  IMAGE_PARAGRAPH_PREFIX,
  LINK_PARAGRAPH_PREFIX,
  isProseParagraph,
  parseLinkParagraph,
} from "@/features/reader/chapterText";
import { highlightSegments } from "@/features/reader/selection";
import { resolveFont, type ReadingSurface } from "@/features/reader/theme";
import { HIGHLIGHT_COLORS, LINE_HEIGHTS } from "@/stores/reader";
import { inkWash } from "@/features/reader/selection";
import type { Annotation, AnnotationStyle, ChapterContent } from "@/types/ipc";
import type { WashSpan } from "@/features/reader/speech";

/** One inline run of a prose paragraph, cut where a marker begins or ends. */
export interface ProseSegment {
  key: string;
  text: string;
  highlighted: boolean;
  /** The annotation covering this run, if any: search matches highlight
   *  without owning one, so they carry no ink. */
  annotationId: string | undefined;
  /** True for the run the read-aloud voice is on right now. */
  tts?: boolean;
  /** The annotation's own ink; a legacy highlight reads the palette's yellow. */
  color: string | null;
  /** `"highlight"`, `"underline"` or `"squiggly"` as the row carries it: the
   *  wire string, narrowed to `AnnotationStyle` only at the point of use
   *  (see `ReaderChapterView`'s `ink`). */
  style: string | null;
}

/** One prose paragraph as the flow draws it. */
export interface ProseParagraph {
  idx: number;
  key: string;
  /** An image marker renders as the referenced picture; it has no text. */
  imagePath: string | null;
  /** A link marker renders as a tappable entry that jumps to the target
   *  chapter (in-book tables of contents). */
  link: { idx: number; text: string } | null;
  segments: ProseSegment[];
}

export interface ProseReadingOptions {
  /** The chapter body on screen: the wallpaper blanking applied, the 简繁
   *  rewrite done. Only its paragraphs are read here. */
  displayChapterData: (ChapterContent & { wallpaper: string | null }) | null | undefined;
  /** The book's annotations, for the runs they cover. */
  annotations: Annotation[] | undefined;
  chapterIdx: number;
  /** The search drawer's query: matches are washed into the flow. */
  search: string;
  /** The reading voice's current span, or `null` when nothing is being read. */
  speechSpan: WashSpan | null;
  fontSize: number;
  /** The font key, bundled or imported. */
  font: string;
  lineHeightIdx: number;
  /** Applied horizontal margin, fullscreen bonus included. */
  margin: number;
  /** Applied vertical margin, fullscreen bonus included. */
  blockMargin: number;
  /** Column width for the paged layouts; `undefined` keeps flow layout. */
  columnWidth: number | undefined;
  /** The measured viewport height; 0 before the first measurement. */
  viewportH: number;
  /** The sidebar's frozen pre-animation width, or `null` when it is not
   *  animating. Freezing it keeps a resize from re-wrapping the chapter. */
  pinnedW: number | null;
  /** The book's own paper art; light in both themes, hence the dark ink. */
  wallpaperPath: string | null;
  /** The surface the ink is laid on, for the dark-paper highlight alpha. */
  surface: ReadingSurface;
}

export interface ProseReading {
  /** The prose flow's own inline style: type, measure, and the column grid. */
  articleStyle: CSSProperties;
  /** The chapter split into highlightable paragraphs and runs. */
  renderedParagraphs: ProseParagraph[];
  /**
   * Inline ink for one annotation run: the translucent wash, the straight line
   * or the squiggle, in the annotation's colour. `null` colour means a legacy
   * highlight — the palette's marker yellow.
   */
  markInk: (color: string | null, style: AnnotationStyle | null) => CSSProperties;
}

/**
 * Everything the prose path keeps for itself.
 *
 * The other two renderers draw pages a book engine composes; the prose path
 * composes the page here, from the chapter text, the annotations, the search
 * matches and the reading voice's wash. What that takes — the flow's style,
 * the paragraph split, and the ink a highlight is drawn with — lives in this
 * hook, so the page holds only the JSX that lays them out.
 */
export function useProseReading({
  displayChapterData,
  annotations,
  chapterIdx,
  search,
  speechSpan,
  fontSize,
  font,
  lineHeightIdx,
  margin,
  blockMargin,
  columnWidth,
  viewportH,
  pinnedW,
  wallpaperPath,
  surface,
}: ProseReadingOptions): ProseReading {
  const articleStyle: CSSProperties = {
    fontSize: `${fontSize}px`,
    fontFamily: resolveFont(font),
    lineHeight: LINE_HEIGHTS[lineHeightIdx],
    // Wallpaper chapters read off the book's own paper art (light in both
    // themes), so the ink stays dark there instead of following the surface.
    color: wallpaperPath ? "#3f3629" : surface.fg,
    paddingInline: margin,
    paddingBlock: blockMargin,
    ...(columnWidth !== undefined
      ? {
          height: "100%",
          columnWidth,
          columnGap: margin,
          columnFill: "auto",
          // Page box for the `.paged-prose` image cap (see globals.css):
          // the measured scroller height beats any 100vh estimate. Only
          // inject a real measurement — a 0 would clamp the img cap to 0
          // and silently hide every picture.
          "--page-block": `${blockMargin}px`,
          ...(viewportH > 0 ? { "--page-h": `${viewportH}px` } : {}),
        }
      : {}),
    // Sidebar spring: frozen at the pre-animation width so the per-frame pane
    // resize never re-wraps the chapter (mx-auto keeps it centred).
    ...(pinnedW !== null ? { width: pinnedW } : {}),
  };

  // Split the chapter into paragraph segments, wrapping the parts covered by an
  // annotation, a search match or the reading voice in a highlight. Keys are
  // built here (outside the JSX map) so the render lists never use a raw index
  // key. Only the paragraph the voice is on gets the extra cut, so a word-level
  // wash re-renders one paragraph, not the chapter.
  const renderedParagraphs = useMemo(() => {
    const paragraphs = displayChapterData?.paragraphs ?? [];
    const chapterAnnotations = (annotations ?? []).filter((a) => a.chapterIdx === chapterIdx);
    const wash = speechSpan && isProseParagraph(paragraphs[speechSpan.source]) ? speechSpan : null;
    return paragraphs.map((paragraph, idx): ProseParagraph => {
      // An image marker renders as the referenced picture; it has no text.
      // A link marker renders as a tappable entry that jumps to the target
      // chapter (in-book tables of contents).
      const imagePath = paragraph.startsWith(IMAGE_PARAGRAPH_PREFIX)
        ? paragraph.slice(IMAGE_PARAGRAPH_PREFIX.length)
        : null;
      const link = paragraph.startsWith(LINK_PARAGRAPH_PREFIX)
        ? parseLinkParagraph(paragraph)
        : null;
      return {
        idx,
        key: `${chapterIdx}-${idx}`,
        imagePath,
        link,
        segments: highlightSegments(
          paragraphs,
          idx,
          chapterAnnotations,
          search,
          wash?.source === idx ? wash : undefined,
        ).map((segment, position): ProseSegment => {
          // Annotation-backed runs carry their own ink; the toolbar's palette
          // decides what they look like.
          const owned = segment.annotationId
            ? annotations?.find((a) => a.id === segment.annotationId)
            : undefined;
          return {
            key: `${chapterIdx}-${idx}-${position}`,
            text: segment.text,
            highlighted: segment.highlighted,
            annotationId: segment.annotationId,
            tts: segment.tts,
            color: owned?.color ?? null,
            style: owned?.style ?? null,
          };
        }),
      };
    });
  }, [displayChapterData, chapterIdx, annotations, search, speechSpan]);

  const markInk = useCallback(
    (color: string | null, style: AnnotationStyle | null): CSSProperties => {
      const hex = color ?? HIGHLIGHT_COLORS[0]!.hex;
      if ((style ?? "highlight") === "underline") {
        return {
          textDecoration: "underline",
          textDecorationColor: hex,
          textDecorationThickness: 2,
          textUnderlineOffset: "3px",
        };
      }
      if (style === "squiggly") {
        return {
          textDecoration: "underline wavy",
          textDecorationColor: hex,
          textDecorationThickness: 1.5,
          textUnderlineOffset: "3px",
        };
      }
      // Dark paper needs a lighter hand; the foliate overlay uses the same
      // two alphas, so one highlight reads the same on every path.
      return {
        backgroundColor: inkWash(hex, surface.mode === "dark" ? 0.26 : 0.36),
        borderRadius: 2,
      };
    },
    [surface.mode],
  );

  return { articleStyle, renderedParagraphs, markInk };
}
