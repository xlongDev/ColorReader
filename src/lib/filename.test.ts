import { describe, expect, it } from "vitest";

import { filename } from "./filename";

describe("filename", () => {
  it("leaves a title every filesystem accepts alone", () => {
    expect(filename("三体", "书档")).toBe("三体");
    expect(filename("Thinking, Fast and Slow", "书档")).toBe("Thinking, Fast and Slow");
  });

  it("replaces the characters a path would read as structure", () => {
    expect(filename("三体/黑暗森林:2", "书档")).toBe("三体_黑暗森林_2");
    expect(filename('a\\b*c?d"e<f>g|h', "书档")).toBe("a_b_c_d_e_f_g_h");
  });

  it("replaces control codes, newlines included", () => {
    expect(filename("三体\n第二行", "书档")).toBe("三体_第二行");
    expect(filename("三体\u0000", "书档")).toBe("三体_");
  });

  it("falls back when nothing usable is left", () => {
    expect(filename("", "标注与笔记")).toBe("标注与笔记");
    expect(filename("   ", "标注与笔记")).toBe("标注与笔记");
  });

  it("treats a title of pure punctuation as a name of its own", () => {
    // `//` became something a panel will accept, so the fallback stays out of
    // it — the reader's own book title is better than a generic word.
    expect(filename("//", "书档")).toBe("__");
  });
});
