import { describe, expect, it } from "vitest";

import { deepLinkRoute, parseDeepLink } from "./deeplink";

// Ids in the shape the app hands out, so the fixtures look like the real thing.
const BOOK = "6f1d2c3e-0000-4000-8000-000000000001";
const NOTE = "9a2b4c6d-0000-4000-8000-000000000002";

describe("parseDeepLink", () => {
  it("reads the book and the highlight the app wrote into the file", () => {
    expect(parseDeepLink(`fangce://book/${BOOK}?annotation=${NOTE}`)).toEqual({
      bookId: BOOK,
      annotationId: NOTE,
    });
  });

  it("accepts a link that only names a book", () => {
    expect(parseDeepLink(`fangce://book/${BOOK}`)).toEqual({
      bookId: BOOK,
      annotationId: null,
    });
  });

  it("refuses the resource URLs the webview streams covers and books through", () => {
    // Same scheme, different job: those are addressed on the resource origin
    // and are not links a reader can follow.
    expect(parseDeepLink(`fangce://localhost/book/${BOOK}`)).toBeNull();
    expect(parseDeepLink(`http://fangce.localhost/book/${BOOK}`)).toBeNull();
  });

  it("refuses anything that is not a link at all", () => {
    expect(parseDeepLink(`https://example.com/book/${BOOK}`)).toBeNull();
    expect(parseDeepLink(`fangce://`)).toBeNull();
    expect(parseDeepLink(`fangce://book/`)).toBeNull();
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });

  it("refuses a path it cannot decode rather than guessing", () => {
    expect(parseDeepLink("fangce://book/%")).toBeNull();
  });

  it("decodes a book id that arrived percent-encoded", () => {
    expect(parseDeepLink("fangce://book/a%2Fb")?.bookId).toBe("a/b");
  });
});

describe("deepLinkRoute", () => {
  it("rides on the reader's own query parameters", () => {
    expect(deepLinkRoute({ bookId: BOOK, annotationId: NOTE })).toBe(
      `/reader?book=${BOOK}&annotation=${NOTE}`,
    );
    expect(deepLinkRoute({ bookId: BOOK, annotationId: null })).toBe(`/reader?book=${BOOK}`);
  });
});
