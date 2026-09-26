import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { adler32, lookup, openIndex, parseHeader } from "@/lib/local/mdict";

/**
 * The reader against the same fixture the Rust half is tested on.
 *
 * `src-tauri/tests/fixtures/mini.mdx` was written by a third-party writer and
 * read back by a third-party reader (see `scripts/generate-mdx-fixture.py`), so
 * "this is a well-formed MDX 2.0 file" is a claim established by something
 * other than either copy of the parser. Sharing it is what makes the two
 * implementations answer for each other: every expectation below is the Rust
 * test's expectation.
 */
const fixture = (): ArrayBuffer => {
  // Relative to the working directory, which is the project root for `vitest`
  // — `import.meta.url` is rewritten on the way through the transform, so a
  // path built from it points somewhere the fixture is not.
  const file = readFileSync("src-tauri/tests/fixtures/mini.mdx");
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
};

describe("mdict", () => {
  it("checksums the way RFC 1950 does", () => {
    // The published example, so a wrong modulus or bit order fails here rather
    // than as a mysterious "block checksum" error on a real dictionary.
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e6_0398);
    expect(adler32(new Uint8Array())).toBe(1);
  });

  it("refuses the header shapes it does not parse", () => {
    const good =
      '<Dictionary GeneratedByEngineVersion="2.0" Encoding="UTF-8" Encrypted="0" Title="T" Description="D"/>';
    expect(parseHeader(good)).toEqual({ title: "T", description: "D" });

    expect(() => parseHeader("<html/>")).toThrow("没有 XML 标签");
    expect(() =>
      parseHeader('<Dictionary GeneratedByEngineVersion="1.2" Encoding="UTF-8" Encrypted="0"/>'),
    ).toThrow("1.2");
    expect(() =>
      parseHeader('<Dictionary GeneratedByEngineVersion="2.0" Encoding="GBK" Encrypted="0"/>'),
    ).toThrow("GBK");
    expect(() =>
      parseHeader('<Dictionary GeneratedByEngineVersion="2.0" Encoding="UTF-8" Encrypted="2"/>'),
    ).toThrow("加密");
  });

  it("reads the fixture the way the oracle reads it", async () => {
    const bytes = fixture();
    const index = await openIndex(bytes);
    // Small enough that the writer split it into several blocks, which is the
    // point: the index walk actually runs.
    expect(index.keyBlocks.length).toBeGreaterThan(1);
    expect(index.records.length).toBeGreaterThan(1);
    expect(index.wordcount).toBe(44);
    expect(index.metadata.title).toBe("迷你词典");

    // ASCII keys at both ends of the sort order, a CJK key last, and a word
    // from the middle of a multi-block index.
    await expect(lookup(bytes, index, "apple")).resolves.toBe("苹果");
    await expect(lookup(bytes, index, "hello")).resolves.toBe("你好");
    await expect(lookup(bytes, index, "word017")).resolves.toBe("释义 17");
    await expect(lookup(bytes, index, "word040")).resolves.toBe("释义 40");
    await expect(lookup(bytes, index, "踟蹰")).resolves.toBe("犹豫不前");
  });

  it("arrives as text, not markup", async () => {
    const bytes = fixture();
    await expect(lookup(bytes, await openIndex(bytes), "markup")).resolves.toBe("粗体");
  });

  it("misses a word the dictionary lacks", async () => {
    const bytes = fixture();
    const index = await openIndex(bytes);
    await expect(lookup(bytes, index, "zzzzqqqq")).resolves.toBeNull();
    // Between two real keys, and past the last one.
    await expect(lookup(bytes, index, "word0175")).resolves.toBeNull();
    await expect(lookup(bytes, index, "zzz")).resolves.toBeNull();
  });
});
