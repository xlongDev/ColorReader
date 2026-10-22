import { describe, expect, it } from "vitest";

import {
  annotationLink,
  canvasFont,
  coverCrop,
  ellipsize,
  fitQuote,
  progressLine,
  wrapLines,
  type TextMeasure,
} from "./quoteCard";

/** Characters measured in fixed pixels — CJK 10, Latin 6, space 3. Every
 *  number a wrap test asserts below is this map, not a real font, so the
 *  expectations stay readable and the break points stay predictable. */
const wide = (char: string) => /[\u4e00-\u9fff]/.test(char);
const measure: TextMeasure = {
  measureText(text: string) {
    let width = 0;
    for (const char of text) width += char === " " ? 3 : wide(char) ? 10 : 6;
    return { width };
  },
};

/** A measure whose width does not depend on the size: only the zone maths
 *  differs between steps, which is what the fit cases are about. */
const withFont = () => measure;

describe("annotationLink", () => {
  it("is the literal the Rust side asserts", () => {
    // The other end of this contract: `export.rs`'s `link` is pinned by
    // `the_link_format_is_the_one_the_frontend_parses` to exactly this string,
    // and `deeplink.ts` parses both. Three call sites, one format.
    expect(annotationLink("book-1", "note-1")).toBe("fangce://book/book-1?annotation=note-1");
  });
});

describe("canvasFont", () => {
  it("passes a literal stack through untouched", () => {
    expect(canvasFont('"LXGW WenKai", serif')).toBe('"LXGW WenKai", serif');
  });

  it("resolves a variable the reader's surface actually declares", () => {
    // `resolveFont` hands back `var(--font-sans)` for the book and system
    // keys; a canvas cannot paint that. The variable's own value is what the
    // card draws, and a missing declaration must fall back to the stack
    // rather than an empty font string.
    document.documentElement.style.setProperty("--font-sans", '"MiSans", "PingFang SC"');
    try {
      expect(canvasFont("var(--font-sans)")).toBe('"MiSans", "PingFang SC"');
    } finally {
      document.documentElement.style.removeProperty("--font-sans");
    }
    // Undeclared: keep the stack, which the next entry of always resolves.
    expect(canvasFont("var(--font-unset)")).toBe("var(--font-unset)");
  });
});

describe("wrapLines", () => {
  it("breaks CJK at character boundaries, greedily", () => {
    // Three chars fill 30px exactly; the fourth would overflow.
    expect(wrapLines(measure, "一二三四五六", 30)).toEqual(["一二三", "四五六"]);
  });

  it("keeps a Latin word whole", () => {
    // 30px fits "hello " but not "hello w"; the break backs up to the space
    // rather than splitting the word.
    expect(wrapLines(measure, "hello world", 30)).toEqual(["hello", "world"]);
  });

  it("breaks mid-word only when the word alone is longer than the line", () => {
    // Five Latin chars is the whole 30px measure; a single 10-char word has
    // nowhere else to go, and overflowing is the worse failure.
    expect(wrapLines(measure, "abcdefghij", 30)).toEqual(["abcde", "fghij"]);
  });

  it("wraps mixed scripts at the script boundary", () => {
    // The CJK run fills the first line to its measure; the Latin word that
    // follows backs up to the space rather than splitting.
    expect(wrapLines(measure, "你好 world", 30)).toEqual(["你好", "world"]);
  });

  it("collapses whitespace, newlines included", () => {
    // A highlight copied out of prose keeps its line structure; the card
    // wraps like prose instead.
    expect(wrapLines(measure, "你好\n  世界", 33)).toEqual(["你好 世", "界"]);
  });

  it("returns nothing for blank text", () => {
    expect(wrapLines(measure, "   \n  ", 30)).toEqual([]);
  });
});

describe("fitQuote", () => {
  it("takes the largest size whose block fits the zone", () => {
    // Three lines at 76px step at 1.55 = 353.4px, inside a 400px zone.
    const fit = fitQuote(withFont, "一".repeat(30), 100, 400);
    expect(fit?.size).toBe(76);
    expect(fit?.lines).toHaveLength(3);
  });

  it("steps down when the largest size overflows", () => {
    // 353.4 at the top size, 297.6 at the next — the zone takes the smaller.
    expect(fitQuote(withFont, "一".repeat(30), 100, 300)?.size).toBe(64);
  });

  it("refuses rather than shrinks below the floor", () => {
    // Even 30px over ten lines cannot enter a 200px zone; the card's one
    // refusal, which the dialog reports as "这一句装不下".
    expect(fitQuote(withFont, "一".repeat(100), 100, 200)).toBeNull();
  });
});

describe("ellipsize", () => {
  it("leaves a line that fits alone", () => {
    expect(ellipsize(measure, "三体", 40)).toBe("三体");
  });

  it("cuts to the last character that keeps the ellipsis inside", () => {
    // 25px holds "一…" (16px); "一二…" (26px) would not.
    expect(ellipsize(measure, "一二三四五", 25)).toBe("一…");
  });
});

describe("progressLine", () => {
  it("reads the percentage and the chapter for an opened book", () => {
    expect(progressLine(0.37, 4)).toBe("读到 37% · 第 5 章");
  });

  it("names only the chapter for a book never opened", () => {
    // A shelf card with no progress has no percentage to read; inventing one
    // ("0%") would say something the app does not know.
    expect(progressLine(null, 0)).toBe("第 1 章");
  });
});

describe("coverCrop", () => {
  // The card's own box, and the ratio every case below is measured against.
  const box = { width: 168, height: 236 };

  it("passes a cover already at the box's ratio through untouched", () => {
    // 420x590 is 168:236 exactly — nothing to crop, nothing to centre.
    expect(coverCrop({ width: 420, height: 590 }, box)).toEqual({
      sx: 0,
      sy: 0,
      sw: 420,
      sh: 590,
    });
  });

  it("crops the top and bottom of a taller cover", () => {
    // 600x900 is 2:3, narrower than the box: the height is the binding side
    // and the cover loses an equal band off both ends.
    const crop = coverCrop({ width: 600, height: 900 }, box);
    expect(crop.sw).toBe(600);
    expect(crop.sh).toBeCloseTo(600 / (168 / 236));
    expect(crop.sx).toBe(0);
    expect(crop.sy).toBeCloseTo((900 - 600 / (168 / 236)) / 2);
  });

  it("crops the sides of a wider cover", () => {
    const crop = coverCrop({ width: 900, height: 600 }, box);
    expect(crop.sh).toBe(600);
    expect(crop.sw).toBeCloseTo(600 * (168 / 236));
    expect(crop.sy).toBe(0);
    expect(crop.sx).toBeCloseTo((900 - 600 * (168 / 236)) / 2);
  });

  it("crops both sides of a square cover", () => {
    // Square is wider than the box, so it loses the same two side bands.
    const crop = coverCrop({ width: 800, height: 800 }, box);
    expect(crop.sh).toBe(800);
    expect(crop.sw).toBeCloseTo(800 * (168 / 236));
    expect(crop.sx).toBeCloseTo((800 - 800 * (168 / 236)) / 2);
  });
});
