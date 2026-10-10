import { describe, expect, it } from "vitest";

import { applySectionText } from "./sectionText";
import { verticalQuotes } from "./foliateStyle";

const quotes = (text: string) => text.replace(/“/g, "﹁").replace(/”/g, "﹂");
const zh = (text: string) => text.replace(/内存/g, "記憶體");

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("applySectionText", () => {
  it("rewrites text nodes and leaves code, styles and attributes alone", () => {
    const d = doc(
      `<article><p>他说：“你好。”</p><p>don’t stop</p><img alt="“不这里”"><style>.x::before{content:"“css 不动”"}</style></article>`,
    );
    // Two text nodes change: the paragraphs. Attribute values (the img alt)
    // and the style element's sheet text are skipped — rewriting those would
    // corrupt the rule, not the prose.
    expect(applySectionText(d, [verticalQuotes])).toBe(2);
    expect(d.body.textContent).toContain("他说：﹁你好。﹂");
    expect(d.querySelector("style")?.textContent).toContain("“css 不动”");
  });

  it("honours the ignore-opencc convention class", () => {
    const d = doc("<p>简</p><p class='ignore-opencc'>简</p>");
    applySectionText(d, [(text) => text.replace(/简/g, "繁")]);
    expect(d.querySelectorAll("p")[0]?.textContent).toBe("繁");
    expect(d.querySelectorAll("p")[1]?.textContent).toBe("简");
  });

  /** The reason the pipeline exists: 替换引号 and 简繁转换 both rewrite the
   *  same nodes, and turning one off must not wipe the other's work. */
  it("replays the layers that are still on, from the published text", () => {
    const d = doc("<p>他说：“内存”</p>");
    applySectionText(d, [quotes, zh]);
    expect(d.body.textContent).toBe("他说：﹁記憶體﹂");

    // 替换引号 off: only the conversion replays, over the *unquoted* source.
    applySectionText(d, [zh]);
    expect(d.body.textContent).toBe("他说：“記憶體”");

    // Both off: the book's own characters come back.
    applySectionText(d, []);
    expect(d.body.textContent).toBe("他说：“内存”");
  });

  it("reports zero when a replay changes nothing", () => {
    const d = doc("<p>无引号</p>");
    expect(applySectionText(d, [(text) => text.replace(/“/g, "﹁")])).toBe(0);
  });

  /**
   * The book opens with every rewrite off, so this is the path every section
   * takes: it must not write. Assigning a text node its own value is still a
   * `characterData` mutation, and WebKit invalidates layout for it.
   */
  it("writes nothing on a second pass with no layers on", async () => {
    const d = doc("<p>他说：“内存”</p>");
    const node = d.querySelector("p")!.firstChild!;
    applySectionText(d, [quotes, zh]);
    expect(node.nodeValue).toBe("他说：﹁記憶體﹂");
    // Everything off: the restore is the last write this node ever gets.
    applySectionText(d, []);
    expect(node.nodeValue).toBe("他说：“内存”");

    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(node, { characterData: true });
    applySectionText(d, []);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mutations).toBe(0);
    observer.disconnect();
  });
});
