import { afterEach, describe, expect, it } from "vitest";

import { partnerOf, usePairView, type BookPair } from "@/stores/pairView";

const PAIR: BookPair = ["book-a", "book-b"];

describe("partnerOf", () => {
  it("returns null without a pair", () => {
    expect(partnerOf(null, "book-a")).toBeNull();
  });

  it("returns the other side, whichever book is in hand", () => {
    // A pair is a relationship, not a mode: opening either book names the
    // other one. This is what a relaunch restores from.
    expect(partnerOf(PAIR, "book-a")).toBe("book-b");
    expect(partnerOf(PAIR, "book-b")).toBe("book-a");
  });

  it("returns null for a book that is not in the pair", () => {
    expect(partnerOf(PAIR, "book-c")).toBeNull();
    expect(partnerOf(PAIR, null)).toBeNull();
  });
});

describe("usePairView", () => {
  afterEach(() => {
    usePairView.setState({ pair: null });
  });

  it("records a pair", () => {
    usePairView.getState().setPair("a", "b");
    expect(usePairView.getState().pair).toEqual(["a", "b"]);
  });

  it("refuses a book paired with itself", () => {
    usePairView.getState().setPair("a", "a");
    expect(usePairView.getState().pair).toBeNull();
  });

  it("forgets the pair on clearPair", () => {
    usePairView.getState().setPair("a", "b");
    usePairView.getState().clearPair();
    expect(usePairView.getState().pair).toBeNull();
  });
});
