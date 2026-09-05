import { describe, expect, it } from "vitest";

import { scoreCommand, type Command } from "@/lib/commands";

function command(title: string, keywords?: readonly string[]): Command {
  return {
    id: `test.${title}`,
    title,
    group: "测试",
    keywords,
    run: () => {},
  };
}

describe("scoreCommand", () => {
  const open = command("打开命令面板", ["palette", "命令"]);

  it("scores every command when the query is empty", () => {
    expect(scoreCommand("", open)).toBe(1);
    expect(scoreCommand("   ", open)).toBe(1);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(scoreCommand("xyz", open)).toBeNull();
  });

  it("matches the title case-insensitively", () => {
    expect(scoreCommand("命令面板", open)).toBeGreaterThan(0);
  });

  it("matches keywords as well as the title", () => {
    expect(scoreCommand("palette", open)).toBeGreaterThan(0);
  });

  it("rewards a contiguous prefix match over a scattered one", () => {
    const prefix = scoreCommand("打开", open) ?? 0;
    const scattered = scoreCommand("开命", open) ?? 0;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it("ranks prefix matches above mid-string matches", () => {
    const a = command("设置");
    const b = command("打开设置");
    expect(scoreCommand("设置", a) ?? 0).toBeGreaterThan(scoreCommand("设置", b) ?? 0);
  });
});
