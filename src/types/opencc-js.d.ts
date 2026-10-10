// opencc-js 的 `./*` 子路径导出（dist/esm-lib）没有自带类型声明，只有
// `opencc-js/core` 与 `.` 有。我们只按需引入两个 preset 数据模块，这里给它们
// 补上与 dist/esm-lib/preset/*.js 实际导出（from / to / configs）一致的形状。
declare module "opencc-js/preset/cn2t" {
  import type { LocalePreset } from "opencc-js/core";
  export const from: LocalePreset["from"];
  export const to: LocalePreset["to"];
  export const configs: NonNullable<LocalePreset["configs"]>;
}

declare module "opencc-js/preset/t2cn" {
  import type { LocalePreset } from "opencc-js/core";
  export const from: LocalePreset["from"];
  export const to: LocalePreset["to"];
  export const configs: NonNullable<LocalePreset["configs"]>;
}
