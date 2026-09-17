import { describe, expect, it } from "vitest";

import { LONE_FIGURE_ATTR, markLoneFigures } from "./loneFigure";

/** Parses `html` as a section body and returns the picture it marked, if any. */
const marked = (html: string) => {
  const doc = document.implementation.createHTMLDocument("section");
  doc.body.innerHTML = html;
  markLoneFigures(doc);
  return [...doc.body.querySelectorAll("img, svg")].filter((el) =>
    el.hasAttribute(LONE_FIGURE_ATTR),
  ).length;
};

describe("markLoneFigures", () => {
  it("tags a cover, a plate in a paragraph, and a plate whose box also holds a <br>", () => {
    // The three shapes Calibre and friends actually ship for a full-page
    // picture. `text/part0001.html` of a converted book is the third.
    expect(marked(`<div><svg viewBox="0 0 950 1388"><image href="c.jpg"/></svg></div>`)).toBe(1);
    expect(marked(`<p><img src="a.jpg"/></p>`)).toBe(1);
    expect(marked(`<div class="calibre3"><img src="a.jpg"><br></div>`)).toBe(1);
  });

  it("leaves an icon that shares its line with text alone", () => {
    // The trap: the icon is the paragraph's only *element* child, so an
    // `:only-child` selector would tag it and sink it below the baseline.
    expect(marked(`<p>前面一段正文<img src="i.png">，后面继续正文。</p>`)).toBe(0);
    expect(marked(`<p><span>文字</span><img src="i.png"><span>文字</span></p>`)).toBe(0);
    expect(marked(`<div>说明文字<img src="i.png"></div>`)).toBe(0);
  });

  it("treats only the book's own scaffolding as shareable", () => {
    // Whitespace and comments are not content...
    expect(marked(`<div>\n  <img src="a.jpg"/>\n</div>`)).toBe(1);
    expect(marked(`<div><!-- plate --><img src="a.jpg"/></div>`)).toBe(1);
    // ...but a caption beside the picture is.
    expect(marked(`<div><img src="a.jpg"><span>图 1</span></div>`)).toBe(0);
  });

  it("walks every picture in the section, not just the first", () => {
    const doc = document.implementation.createHTMLDocument("section");
    doc.body.innerHTML = `<div><img src="a.jpg"></div><p>正文<img src="i.png">正文</p><div><img src="b.jpg"></div>`;
    markLoneFigures(doc);
    const tagged = [...doc.body.querySelectorAll("img")].map((el) =>
      el.hasAttribute(LONE_FIGURE_ATTR),
    );
    expect(tagged).toEqual([true, false, true]);
  });
});
