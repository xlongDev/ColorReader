import { describe, expect, it } from "vitest";

import { convertParagraphs, ZH_MODES } from "./zhConvert";

/** A fake converter: enough to prove the plumbing, not the dictionaries. */
const fakeConvert = (text: string): string => text.replace(/简/g, "繁");

describe("ZH_MODES", () => {
  it("keeps off first and every other key unique", () => {
    expect(ZH_MODES[0]!.key).toBe("off");
    const keys = ZH_MODES.map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("convertParagraphs", () => {
  it("keeps paragraph count and blank placeholders stable", () => {
    const paragraphs = ["简体", "", "繁体"];
    expect(convertParagraphs(paragraphs, fakeConvert)).toEqual(["繁体", "", "繁体"]);
  });
});
