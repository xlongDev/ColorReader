/**
 * 简繁转换（readest 同款能力，词典与转换链来自 opencc-js）。
 *
 * 只改显示，不改书源：转换发生在 section 文档挂载（foliate 通路）或章节段落
 * 渲染（纯文本通路）时，数据库里的语料、检索索引永远是原文。
 *
 * 词典按方向切成两个动态分块：简→繁一整族（s2t/s2tw/s2hk/s2twp）共用
 * `preset/cn2t`，繁→简一整族（t2s/tw2s/hk2s/tw2sp）共用 `preset/t2cn`。
 * 读者一次只会用其中一个方向，另一块的 ~1 MB 词典永远不必下载解析；
 * 两块都是懒加载 chunk，首屏不碰。
 */

import { useEffect, useState } from "react";

/** 转换模式，`off` 之外都是 opencc-js 的预设名。 */
export type ZhConvertMode =
  "off" | "s2t" | "t2s" | "s2tw" | "s2hk" | "s2twp" | "tw2s" | "hk2s" | "tw2sp";

/** 面板与菜单共用的模式清单，顺序即展示顺序（readest 同款措辞）。 */
export const ZH_MODES: { key: ZhConvertMode; label: string }[] = [
  { key: "off", label: "不转换" },
  { key: "s2t", label: "简 → 繁" },
  { key: "t2s", label: "繁 → 简" },
  { key: "s2tw", label: "简 → 繁（台湾）" },
  { key: "s2hk", label: "简 → 繁（香港）" },
  { key: "s2twp", label: "简 → 繁（台湾）习惯用语" },
  { key: "tw2s", label: "繁（台湾）→ 简" },
  { key: "hk2s", label: "繁（香港）→ 简" },
  { key: "tw2sp", label: "繁（台湾）→ 简 习惯用语" },
];

/** 转换函数：一段原文进，一段转换后的文本出。 */
export type ZhConverter = (text: string) => string;

/** 模式 → cn2t 族里的目标locale（简→繁一族）。 */
const CN2T_TARGETS: Partial<Record<ZhConvertMode, string>> = {
  s2t: "t",
  s2tw: "tw",
  s2hk: "hk",
  s2twp: "twp",
};

/** 模式 → t2cn 族里的来源 locale（繁→简一族）。 */
const T2CN_SOURCES: Partial<Record<ZhConvertMode, string>> = {
  t2s: "t",
  tw2s: "tw",
  hk2s: "hk",
  tw2sp: "twp",
};

const cache = new Map<ZhConvertMode, Promise<ZhConverter>>();

/**
 * 加载一个模式的转换器并记忆化。词典分块是纯数据 + 纯函数，构建在主线程
 * 一次（Trie ~几十 ms），之后 `convert` 是同步查表。`off` 不会走到这里。
 */
export function loadZhConverter(mode: ZhConvertMode): Promise<ZhConverter> {
  const cached = cache.get(mode);
  if (cached) return cached;
  const job = (async (): Promise<ZhConverter> => {
    const { ConverterBuilder } = await import("opencc-js/core");
    const target = CN2T_TARGETS[mode];
    if (target) {
      const preset = await import("opencc-js/preset/cn2t");
      return ConverterBuilder({ from: preset.from, to: preset.to, configs: preset.configs })({
        from: "cn",
        to: target,
      });
    }
    const source = T2CN_SOURCES[mode];
    if (source) {
      const preset = await import("opencc-js/preset/t2cn");
      return ConverterBuilder({ from: preset.from, to: preset.to, configs: preset.configs })({
        from: source,
        to: "cn",
      });
    }
    throw new Error(`未知的简繁转换模式：${mode}`);
  })();
  cache.set(mode, job);
  // 失败的作业不留缓存：下一次翻模式还能重试。
  job.catch(() => cache.delete(mode));
  return job;
}

/**
 * 转换纯文本通路的段落数组。段落数量与分隔符（`\n`）不变，段落 idx、
 * 章节结构、壁纸标记的空串占位全部保持——下游的标注、TTS、检索高亮都在
 * 同一份转换后的文本上工作，互相一致。
 */
export function convertParagraphs(paragraphs: string[], convert: ZhConverter): string[] {
  return paragraphs.map((paragraph) => (paragraph ? convert(paragraph) : paragraph));
}

/**
 * The converter for `mode`, or `null` while the dictionary chunk loads (and
 * for `off`). The answer is mode-tagged: a mode flip answers `null` right away
 * so the prose path falls back to the original text instead of flashing the
 * previous mode's conversion under the new label.
 */
export function useZhConverter(mode: ZhConvertMode): ZhConverter | null {
  const [loaded, setLoaded] = useState<{ mode: ZhConvertMode; converter: ZhConverter } | null>(
    null,
  );
  useEffect(() => {
    // `off` loads nothing; the return below answers `null` for it, because a
    // converter for a non-off mode can never carry that tag.
    if (mode === "off") return;
    let cancelled = false;
    void loadZhConverter(mode).then((converter) => {
      if (!cancelled) setLoaded({ mode, converter });
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);
  return loaded?.mode === mode ? loaded.converter : null;
}
