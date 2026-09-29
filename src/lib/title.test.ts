import { describe, expect, it } from "vitest";

import { displayTitle } from "./title";

describe("displayTitle", () => {
  it("keeps a title that already fits", () => {
    expect(displayTitle("算法图解")).toBe("算法图解");
    expect(displayTitle("深入浅出 Node.js")).toBe("深入浅出 Node.js");
    expect(displayTitle("生命3.0")).toBe("生命3.0");
  });

  it("cuts at a colon, which is where a subtitle starts", () => {
    expect(displayTitle("孤星之旅: 苏东坡传")).toBe("孤星之旅");
    expect(displayTitle("AI未来已来：CEO 的 AI 思维课")).toBe("AI未来已来");
    expect(
      displayTitle(
        "认知觉醒: 开启自我改变的原动力 (当你认知觉醒, 何惧焦虑迷茫! 畅销书《反本能》作者卫蓝激赏力荐!)",
      ),
    ).toBe("认知觉醒");
  });

  it("ignores a colon too close to the start to be a separator", () => {
    expect(displayTitle("上: 下册合集")).toBe("上: 下册合集");
  });

  it("drops a long trailing parenthetical, but only once over the limit", () => {
    // Exactly at the limit — the parenthetical survives, because the name
    // itself is short enough to print whole.
    expect(displayTitle("韭菜的自我修养(李笑来首次公开投资原则)")).toBe(
      "韭菜的自我修养(李笑来首次公开投资原则)",
    );
    expect(displayTitle("韭菜的自我修养(李笑来首次公开投资原则与人生规划)")).toBe("韭菜的自我修养");
  });

  it("keeps a short parenthetical — it is what tells these apart", () => {
    expect(displayTitle("你不知道的 JavaScript（上卷）")).toBe("你不知道的 JavaScript（上卷）");
    expect(displayTitle("刺杀骑士团长（第一部）")).toBe("刺杀骑士团长（第一部）");
    expect(displayTitle("天才的编辑（美国文库）")).toBe("天才的编辑（美国文库）");
  });

  it("falls back to a hard cut with an ellipsis", () => {
    const long = "一个没有任何分隔符但就是很长很长的书名最后真的超过二十个字了";
    const cut = displayTitle(long);
    expect(cut).toBe(`${long.slice(0, 20)}…`);
    expect(cut).toHaveLength(21);
  });

  it("never returns an empty string for a title made only of a prefix", () => {
    expect(displayTitle("：")).toBe("：");
    expect(displayTitle("")).toBe("");
  });
});
