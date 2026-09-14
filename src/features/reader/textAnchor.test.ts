import { describe, expect, it } from "vitest";

import { condense, findInSections, findRange, indexText } from "./textAnchor";

/** A paragraph carrying `text`, in a document that can host a Range. */
function paragraph(text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = text;
  document.body.append(element);
  return element;
}

/** Where a range points, as `[startOffset, endOffset]` inside its text node. */
function offsets(range: Range | null) {
  if (!range) return null;
  return [range.startOffset, range.startOffset + range.toString().length];
}

describe("condense", () => {
  it("drops whitespace and the invisible characters a clipping lacks", () => {
    expect(condense("a b\n c")).toBe("abc");
    expect(condense("imme\u{00ad}asurable")).toBe("immeasurable");
    expect(condense("\u{feff}start")).toBe("start");
  });
});

describe("findRange", () => {
  it("finds a snippet that the section broke across lines", () => {
    const element = paragraph("and the House\n  said:  hello");
    const range = findRange(indexText(element), "the House said: hello");
    expect(offsets(range)).toEqual([4, 28]);
    expect(range?.toString()).toBe("the House\n  said:  hello");
  });

  it("reports nothing when the section does not carry the text", () => {
    const element = paragraph("and the House said hello");
    expect(findRange(indexText(element), "something else entirely")).toBeNull();
    expect(findRange(indexText(element), "")).toBeNull();
  });

  it("counts offsets past a surrogate pair in code units", () => {
    // Each emoji is one character and two UTF-16 code units; an offset counted
    // in characters would land the range in the middle of one.
    const element = paragraph("🌙🌙 moonlight");
    const range = findRange(indexText(element), "moonlight");
    // The ignored space still counts towards the DOM offset: 4 code units of
    // emoji, a space, then the word.
    expect(offsets(range)).toEqual([5, 14]);
    expect(range?.toString()).toBe("moonlight");
  });

  it("reads across several text nodes in one section", () => {
    const element = document.createElement("div");
    const first = document.createElement("span");
    first.textContent = "The Beauty ";
    const second = document.createElement("em");
    second.textContent = "of the House";
    element.append(first, second);
    document.body.append(element);

    const range = findRange(indexText(element), "The Beauty of the House");
    expect(range?.toString()).toBe("The Beauty of the House");
  });

  it("ignores script and style bodies", () => {
    // Detached on purpose: jsdom evaluates an inline `<script>` the moment it
    // enters a document, and what this checks is the tag, not the code.
    const element = document.createElement("div");
    const script = document.createElement("script");
    script.textContent = "var hidden = 'hiddenneedle'";
    const style = document.createElement("style");
    style.textContent = "hiddenneedle { color: red }";
    const prose = document.createElement("p");
    prose.textContent = "visible prose";
    element.append(script, style, prose);

    const index = indexText(element);
    expect(index.flat).toBe("visibleprose");
    expect(findRange(index, "hiddenneedle")).toBeNull();
  });
});

/** One section, as its own document: foliate hands them out as documents, so
 *  the search must cross realms rather than stay in the test page. */
function section(text: string): Document {
  const doc = document.implementation.createHTMLDocument();
  const prose = doc.createElement("p");
  prose.textContent = text;
  doc.body.append(prose);
  return doc;
}

describe("findInSections", () => {
  it("reports which section carries the text", () => {
    const found = findInSections(
      [
        { index: 0, doc: section("nothing to see") },
        { index: 1, doc: section("the House said hello") },
      ],
      "the House said hello",
    );
    expect(found?.index).toBe(1);
    expect(found?.range.toString()).toBe("the House said hello");
  });

  it("reports nothing when no mounted section carries it", () => {
    expect(findInSections([{ index: 0, doc: section("别的句子") }], "moonlight")).toBeNull();
  });

  it("skips entries whose section has not resolved yet", () => {
    // The paginator emits an entry before its document exists; reading `doc`
    // off it would throw instead of moving on.
    const found = findInSections(
      [{ index: 0 }, { index: 1, doc: section("moonlight") }],
      "moonlight",
    );
    expect(found?.index).toBe(1);
    expect(found?.range.toString()).toBe("moonlight");
  });
});
