# ColorReader 新功能与优化建议

> 日期：2026-10-12 · 方法：读源码 + 实测统计（目录规模、产物体积、配置）+ 与 `ARCHITECTURE.md §9` 待办清单交叉核对。技术栈不动，不推倒重写。
> 所有数字均为本次重新量测，未从旧文档推算。
>
> **落地进展（同日）**：✅ **F2 更新角标** 与 ✅ **O3 桌面构建剔除字体** 已实现并过全量门禁；O3 实施中另发现并修复一个**存量 bug**（vite 别名从未生效，两个「已剔除」的构建一直打着 29 MB 字体），细节见该条。其余项未动。
>
> **落地进展（2026-10-13）**：✅ **F1 快捷键自定义**（收编 + 面板）、✅ **O4 凭据加密** 已实现并过全量门禁。O4 的原始方向**缺了「密钥从哪来」这一半**，实际做法改为「系统钥匙串保管主密钥」，代价是新增 1 个依赖 —— 细节与理由见该条。**O2 已落地**：`library/` 分进七个子目录、`mobi.rs` 拆成八个文件、`clippings.rs` 拆成七个文件，门禁绿；证据行里那组「越线」用的是含测试的总行数，订正见该条。

---

## 一、现状分析

### 1.1 定位与栈

AI Native · Local First · High Performance 的跨平台（Tauri 2）电子书阅读器。三条取舍贯穿全局：联网能力全部可选、不打包任何数据集、整本书不进 React。栈：Rust（edition 2024，单 crate）+ React 19 / Vite 8 / Tailwind v4 / Zustand / TanStack Query / Motion + SQLite（WAL）+ FTS5(trigram) + pdf.js + vendored foliate-js；渲染走 foliate（EPUB/MOBI）与自建 pdf.js 通路两条。

### 1.2 结构（实测）

| 区域                  | 实测                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 前端 `src/`           | 214 个 ts/tsx，约 5.5 万行（含测试）；最大 `ReaderPage.tsx` 2741、`FoliateBookView.tsx` 1757、`SettingsPage.tsx` 1351 |
| Rust `src-tauri/src/` | 26,235 行；`commands/` 22 个域、`library/` **24 个文件平铺**、`document/` 9 个                                        |
| IPC                   | 80+ 命令（3 条二进制通道手写），5 个事件，`src/lib/ipc.ts` 单一出口，类型由 tauri-specta 生成                         |
| 测试                  | vitest 719 · cargo 426 · Playwright 96×2 引擎；pre-commit 跑 prettier/oxlint/tsc/rustfmt/clippy                       |
| 产物                  | `dist` 35 MB（**29 MB 是 582 个 lxgw-wenkai woff2 子集**）；入口 chunk 351.6 kB，pdf chunk 431 kB，均在 500 kB 红线内 |

### 1.3 主要业务流程

```
导入（book_import → SHA-256 去重 → 解析元数据/封面/章节 → 事务落库 + FTS 触发器）
  → 阅读（foliate / pdf.js / 纯文本三条渲染通路，一次只加载一章；进度按 chars 前缀定位）
  → 标注（章节不可变文本上的 UTF-16 区间，EPUB 走 CFI；migrate/bookmark/clippings 共用 haystack 锚定）
  → 检索与 AI（FTS5+BM25 / RAG 暴力点积 Top-6 / 图谱 / 词典三级链 / Edge TTS 双引擎）
  → 数据流转（.ctz 书档 / .ctzx 加密 / WebDAV 进度+标注+书签 LWW+墓碑 / 全库备份）
```

### 1.4 值得肯定的既有实现（不建议重做）

- 标注 = 不可变字符区间 + `content_hash` 身份键，取消了一整类 re-location 问题；
- 深链只带身份不带位置（三种位置模型互不通约）；
- 错误处理干净：生产路径 `unwrap()/expect()`、`TODO/FIXME`、`console.*`、吞错的 `let _ =` **均为 0**；
- 最小权限 capability、CSP `default-src 'self'`、Key 只存 Rust 侧、明文 http 仅 loopback；
- 换版本迁移「先复制后删除」、OCR「写回章节正文以复用四条消费链路」——都是靠证据逼出来的设计。

---

## 二、新功能建议（5 项）

### F1 · 快捷键自定义　【优先级 P1 · 中等改动 · ✅ 已落地 2026-10-12】

- **问题**：全仓带快捷键的命令只有 3 条（⌘K / ⌘B / ⌘,，见 `registerCoreCommands.tsx`），翻章翻页、RSVP、标尺步进散在各自的 keydown 里，读者改不了任何一个键。
- **订正（本次实测后）**：本报告原先写的第 ① 步「把阅读器按键逐个搬进命令注册表、`Command.shortcut` 已有类型、`useHotkeys` 现成、是纯接线」**是错的**。注册表的 `shortcut` 语义是「这个键，在任何地方」，而阅读器的键是**上下文相关**的：同一个 ArrowRight 在翻页版式里翻页、滚动版式里翻章，标尺开着时归标尺，垂直排版里方向还要反过来；灯箱开着时它独占键盘。挂进注册表会同时带来两个问题——在阅读器外也会触发，且含义取决于命令的注册顺序。真做下去会得到「能改，但改完行为随机」的面板。
- **第 ① 步（已完成）**：`src/features/reader/readerKeys.ts` —— 一张**纯表**（`id` / `title` / `keys` / `when(ctx, stroke)` / `inEditable` / `keepDefault`）+ `resolveReaderKey`，按声明顺序取第一个命中且闸门放行的绑定。灯箱模态用**换一张表**表达，而不是给每条绑定加 `!lightboxOpen`。`ReaderPage` 的 105 行分支变成「搭上下文 → 解 id → 翻译成调用」，文件 2741 → 2722 行，而这 105 行**此前一条单测都没有**（只有浏览器套件能碰到），现在 `readerKeys.test.ts` 钉住整张表。
- **第 ② 步（已完成，同日）**：`KeyOverrides`（`lib/commands.ts`）= 一张扁平 `Record<id, Shortcut[]>`，**注册表命令与阅读器键表共用**（id 空间不重叠），存在 `useSettings` 里跟着 `persist` 走；消费者一律问 `effectiveKeys(id, 默认, overrides)`，且 `useHotkeys` / `resolveReaderKey` 都是**每次按键现读** store 而不是绑定时捕获。设置页新增 `KeymapSection`（`features/settings/`，与 `section.tsx` 一起把设置页从 1351 行降到 1241 行）：分「应用 / 阅读器」两张表，点「改键」→ 按一下 → 换；录制监听挂 `window` **捕获阶段**并吞掉一切（录制时按 ⌘K 不能让命令面板盖上来），Escape 取消，裸修饰键不绑。**只覆盖 `keys`**，闸门与 `inEditable` / `keepDefault` 面板碰不到。
- **冲突检测**：`unreachableBindings` 枚举四个闸门的 16 种组合，找「在任何上下文都赢不了」的绑定并点名是谁拿走的（**按表分别枚举**，灯箱里的绑定不去怪阅读表）；`sharedShortcuts` 只对**全局**命令报同键冲突（阅读器里同键绑两条是设计）。两条都渲染进「需要注意」。
- **测试**：`commands.test.ts` 12 → 29、`readerKeys.test.ts` 11 → 25、`settings.test.ts` 8 → 14、`reset.test.ts` 2 → 3（重置也把改键一起还原），并对 `unreachableBindings` / `effectiveKeys` / `sharedShortcuts` 做了变异验证。新增 `e2e/keymap.spec.ts`（5 条 × 双引擎）走完整条链：面板写 → **刷新** → 打开书按新键；两处变异（录制器改冒泡、阅读器忽略覆盖）都精准打红对应用例。🔴 **e2e 跑的是 `vite preview`，服务的是 `dist/`** —— 改完源码必须先 `vite build`，否则测的是上一次的构建（这次差点被它骗过去）。

### F2 · 自动更新角标　【优先级 P0 · 小改动 · ✅ 已落地 2026-10-12】

- **问题**：`useUpdater.ts` 的注释自己写了「启动时检查需要一个能自己冒出来的通知面（横幅或角标），那个还不存在，而静默到达的更新比读者主动要的更新更糟」。结果：更新机制已落地，但只在设置页手动查，绝大多数装机永远收不到新版。
- **实施**：`useUpdater` 从 hook 升级为 `stores/updater.ts`（设置行与横幅共享同一份状态机，SettingsPage 的调用签名不变）；新组件 `components/layout/UpdateBanner.tsx` 挂在 AppShell，launch 后 8 s 检查一次——只对「有新版」显示、可关闭、全屏阅读时不绘制、检查失败保持安静（没人要求过它）。**只发现、不安装**：安装永远是读者按的。
- **测试**：19 条新单测。拆成两个文件是因为 motion 的全局帧循环活不过假时钟——时序测试（`UpdateBanner.check.test.tsx`）单独住，并套 `MotionConfig reducedMotion="always"`；渲染与关闭（`UpdateBanner.test.tsx`）全程真实时钟，直接驱动 store。

### F3 · 整本扫描页 OCR　【优先级 P1 · 中偏大】

- **问题**：纯扫描 PDF 是文档记录的真缺口。单页 OCR 链路已通（`ai/vision.rs::transcribe` + `library/ocr.rs` 写回章节正文，FTS/朗读/RAG/助手四条链路同时活），「整本识别刻意没做：差进度事件、取消、提交前可见的花费」（ARCHITECTURE 原话）。
- **思路**：① 批量入口先统计无文字层页数并给出预估（页数 × 单页成本）；② 复用 `book://import-progress` 的事件模式加 `page://ocr-progress`（事件契约、specta 注册、`emit` 全都有现成样板）；③ 取消用 generation 计数器（与朗读 `cancel` 同款）；④ 继续走「结果写回章节正文」不变。
- **范围**：Rust 一个命令 + 一个事件 + 阅读器一个面板入口。
- **红线不变**：vision 模型给词不给框，**划词仍不可用**（ARCHITECTURE 已判「设计而不是遗漏」），文档需明示。

### F4 · 金句卡片分享图　【优先级 P2 · 小到中等】

- **问题**：P2 清单在列项；本地导出只有 md/csv，没有面向分享的单图。
- **思路**：离屏 canvas 按 3:4（1080×1440）渲染：标注原文 + 书名/作者 + 阅读进度 + 右下角含深链的二维码（`export.rs::link` 的生成器已存在）。存盘走 `dialog:allow-save`（已授权）。**纯前端、无服务端**，符合 Local First。可复用霞鹜文楷字体链与 glass 材质语言。
- **范围**：纯前端一个渲染模块 + 标注面板/灯箱一个入口 + 单测（换行与 CJK 度量需实测）。
- **风险**：canvas 中 CJK 文本度量与 WebKit/Chromium 差异，e2e 双引擎各断言一次。

### F5 · OPDS 1.2 目录订阅　【优先级 P2 · 较大】

- **问题**：「在线找书」只有用户手写 JSON 规则的书源（规则刻意收窄、不支持 HTML）。OPDS 是电子书目的事实标准，公共图书馆/自建书站通用。
- **思路**：用已有的 `reqwest` + `quick-xml`，**不新增依赖**；只收两类 feed——Navigation（目录浏览）与 Acquisition（条目+获取链接），分页/OpenSearch 收窄到 v1.2 最小集。下载产物**复用既有导入管线**（与书源完全同一条路：暂存文件 → `import_files`）。一个目录不配照样读，符合 Local First。
- **范围**：新命令域 `catalog`（订阅管理 + feed 解析）+ 浏览 UI + 下载接线。
- **不做**：OPDS 服务器端、认证之外的双向同步（与「自建云同步不做」一致）。

---

## 三、优化建议（7 项）

### O1 · `ReaderPage.tsx` 仍是巨石，且比上次量测时又长了　【P1 · ✅ 已落地 2026-10-13】

- **证据**：2741 行，比 PR#10 后的 2565 长了 176。`scripts/measure-reader-clusters.py` 与 CI 量测摘要在位，但**判定表是这三个功能之前量的**。
- **重跑结果（2026-10-12）**：9 个簇，与 2026-09-28 那版逐条对比（脚本的列是 `行数 / 入口 / 出口 / 入口+出口`，下表只取前三个）：

  | 簇           | 行数（09-28 → 10-12） | 入口 | 出口   | 判定                                             |
  | ------------ | --------------------- | ---- | ------ | ------------------------------------------------ |
  | 搜索/AI 跳转 | 40 → 9                | 5    | 2      | 已抽（PR#8），余下是别名解构                     |
  | 图片/灯箱    | 85 → 11               | 1    | 13     | 已抽（PR#7）                                     |
  | foliate 桥   | 169 → 59              | 21   | 33     | 已抽（PR#9/#10）                                 |
  | 头部视图     | 15 → 17               | 10   | 9      | 不做（一层间接）                                 |
  | 阅读标尺     | 50 → 58               | 3    | 19     | 不做（横切 + flake 集中）                        |
  | PDF          | 63 → 64               | 10   | 24     | 不做（出口 8 处在脊柱）                          |
  | 标注桥接     | 72 → 58               | 2    | 33     | 不做（`pending`×27，页面中心状态）               |
  | 翻页手势     | 134 → 141             | 18   | 25     | 不做（脊柱 × 标尺 × 两渲染器的交汇）             |
  | 位置与导航   | 291 → **316**         | 28   | **75** | 不做（`chapterIdx`×33、`goTo`×12，出口 78 → 75） |

- **结论**：**没有出现新的可抽簇**，三个新功能（迁移 / 单页 OCR / 周节奏）没有在页面里形成新的叶子——增长都落在既有的脊柱簇上（位置与导航 291→316、翻页手势 134→141、标尺 50→58），出口数反而略降（78→75），也就是那 25 行是往已有的脊柱里加料，不是新长出一条可切的边。按仓库自己的尺子（出口 ≤ ~2/消费点、入口是纯值）**剩余九簇全部不合格**，`ReaderPage` 的规模问题**不能靠继续抽簇解决**。真要动它，方向是「按渲染分支拆文件」（PDF / foliate / 纯文本三条视图）而不是抽 hook —— 那是另一笔，得先量分支之间的共享面。
- **本次顺带做的**：翻页/翻章/标尺那 105 行键盘分支从页面搬进 `readerKeys.ts`（见 F1），文件 2741 → 2722 行。
- **落地（2026-10-13，按渲染分支拆文件）**：动手前先补了一次「分支共享面」量测（`scripts/measure-reader-branches.py`），把 2377 行主体按语句分类：分支专属 40.3% / 与分支无关 31.8% / 多分支 27.8%。多分支的 662 行里 **501 行是 JSX `return`（分发器本体，天然碰三个分支）**，真正共享的分支感知逻辑只有 **161 行**（flip 83 + goTo 48 + readAloud 17 + wallpaperUrl 8 + headerIndex 5）——所以「拆文件」不会把共享逻辑撕成两半。
- **拆法：一个渲染分支一个 hook，页面只留分发器**。三个新 hook（`usePdfReading.ts` 270 行 / `useFoliateReading.ts` 109 行 / `useProseReading.ts` 225 行）各自收一条分支的自留逻辑，页面用**原名字**解构，四类委托只留一行（goTo 的 `pdfClaimPage`、applyPending 的两条、onScroll 的 `pdfTrackScrolledPage`、flip 的 `pdfTurn`）；JSX 的 `pdf={{…}}` bundle 与 wash effect 一行未动。`ReaderPage.tsx` **2731 → 2553 行**。
- **关键约束是 TDZ，不是行数**：hook 的输入若晚于其最早消费者即 TS2448/2454（folio 分支的 `readAloud.pdfWash` 在 853 行，`goTo` 在 791 行就要用 `pdfClaimPage`）。解法是「hook 只收早期输入、返回晚期产物」，而不是把 hook 调用点往下挪。第一版设计曾给 PDF hook 传 `ttsWash` / `darkSurface` / `view`，一次报 6 个 TS2448/2454，已按此改正。
- **每个新 hook 补了单测**（`usePdfReading.test.tsx` 6 条 / `useFoliateReading.test.ts` 4 条 / `useProseReading.test.ts` 12 条），三处静默失败点（翻 spread 少走一页、suppress 通知被二次消费、CFI 优先级链被调换）按变异验证逐条确认会红。门禁：tsc ✓、oxlint 327 文件 0-0、vitest reader+hooks **600 passed**、e2e 十二个 reader spec **184 passed**（含全部 PDF 翻页/滑动/夜间重绘、folio 抽屉与位置、正文标尺/选择/朗读）。

### O2 · Rust `library/` 越过自己定的拆分阈值　【P2 · 已落地 2026-10-13】

- **证据**：ARCHITECTURE 自定规则「单模块超约 800 行且两个以上变更理由即拆」。实测越线：`document/mobi.rs` 1809、`library/clippings.rs` 1590、`repository.rs` 1194、`export.rs` 1028、`sync.rs` 970；`library/` 是 24 文件平铺桶，内含词典解析 / 检索与 AI / 同步备份 / 导出 / 书源五类互不相关领域。
- **订正（实施时发现）**：上面那组「越线」用的是**总行数**（含 `#[cfg(test)] mod tests`）。按**生产代码**算，只有 `mobi.rs`（1311）与 `clippings.rs`（948）真的越过 800 —— `repository.rs` 690、`export.rs` 435、`sync.rs` 631 都在线内。而 `repository.rs` 里**没有 tag 查询**（只有 `attach_tags`），chapter 相关只有 4 个 pending 标志位，按原方向「按实体拆 books / chapters / tags」拆完，`books.rs` 仍有约 1100 行，**达不到拆的目的**。所以实际范围收窄为「分层 + 拆真正超线的两个文件」，`repository.rs` 不硬拆。
- **落地（一）分层**：26 个文件分进七个**私有**子目录（`shelf` / `marks` / `lookup` / `retrieval` / `assist` / `transfer` / `io`），`mod.rs` 把每个模块 `pub use` 回顶层，于是全 crate 的 **114 处 `library::x` 引用（41 个文件）一行都不用改** —— 分层管的是「该打开哪个文件」，不是新的公开路径。`retrieval/` 与 `transfer/` 不叫 `search/`、`sync/`，是因为 `pub mod search;` 与 `pub use search::search;` 同名会撞 **E0255**。子目录里的 `super::` 语义会变（`library/x.rs` 的 `super` 是 `library`，搬到 `library/<sub>/x.rs` 后是 `library::<sub>`），所以指向 library 级条目的 `super::NAME` 全改成 `crate::library::NAME`，**但 `mod tests` 里的 `use super::*;` 保持不动**。
- **落地（二）拆 `mobi.rs`**：1311 行生产代码 → `document/mobi/{mod, pdb, palmdoc, exth, index, markup, text, bytes}.rs`，最大 786 行（含 498 行测试）。函数体按行区间**脚本搬运而非手抄**（手抄 1300 行二进制解析是引入笔误的最快方式）；`Section` 的三个 EXTH 方法改写成一行委托，其余方法与调用点不动。
- **落地（三）拆 `clippings.rs`**：948 行生产代码 → `io/clippings/{mod, kindle, markdown, csv, anchor, import, fixture}.rs`，最大 439 行（其中 237 行是测试）。**`mod.rs` 只留三处共享物**：`Clipping` / `Parsed` 模型、`detect`，以及两个解析器都要用的 `LINK_PREFIX` / `linked_book_id`；子目录私有 + `pub use` 回顶层，于是全 crate **19 处 `clippings::` 引用（3 个文件）一行未改**。私有助手跟着调用它的人走：`SEPARATOR` / `read_entry` / `collapse` / `split_title_author`（**原本 `pub`，收紧为私有**）进 `kindle.rs`，`heading_title` / `chapter_number` 进 `markdown.rs`，`non_empty` / `csv_rows`（改 `pub(super)`，因为 `detect` 的 `header_of` 也要读表头）进 `csv.rs`。`signature` / `ignorable` / `Haystack` / `Catalog` 合成一个 `anchor.rs`——「匹配哪本书」与「在书里哪一段」本来就是同一次匹配的两半，也正好是 `migrate.rs` 借走的那三个函数。测试按被测对象分发，跨文件共用的夹具（`entry` / `highlight` / `blocks` / `LINK`）收进 `#[cfg(test)] mod fixture`。`Outcome` / `BookOutcome` 搬了位置但 specta 契约没变（`bindings.ts` 与 HEAD 逐字节一致）。`cargo test` 前后都是 **471 passed / 0 failed / 7 ignored**。

### O3 · 29 MB 字体仍随安装包分发　【P2 · ✅ 已落地 2026-10-12】

- **证据**：`dist` 35 MB 中 29 MB 是 582 个 lxgw-wenkai woff2；`frontendDist: ../dist` 且无 `resources` 排除 → Tauri 打包把它们收进 `.app` / 安装包。上一笔提交（`3260146`）只解决了首屏 CSS（620 KB → 66 KB），**没有解决体积**；霞鹜文楷是 5 个字体栈之一、默认值是「系统」。
- **实施**：`scripts/build-app.mjs`（设 `CR_NO_BUNDLED_FONT` 后跑 `pnpm build`）经 `tauri.conf.json` 的 `beforeBuildCommand` 生效；`vite.config.ts` 在该变量或 `PAGES_BASE` 下把 `bundledFont` 模块与样式表换成空壳。**实测三种构建**：标准 35 MB / 582 子集（`pnpm dev` 与 CI、e2e 不变），两个打包构建各 **5.8 MB / 0 子集**；入口 chunk 338 KB、pdf chunk 430 KB，均在 500 kB 红线下。
- **额外收获（存量 bug）**：原别名写在 `resolve.alias` 对象里、排在 `"@"` 之后——字符串别名按前缀匹配，`"@"` 先吞掉所有 `@/…` 导入，精确的模块别名与带 `?url` 的 CSS 别名**从未生效**，GitHub Pages 预览一直打着全部 29 MB。改为数组形式、按特异性排序，CSS 改用正则容忍 `?url`。坑已写进 `ARCHITECTURE.md`「自定义字体」一节。

### O4 · 凭据在 SQLite 里明文　【P2 · ✅ 已落地 2026-10-13】

- **证据**：AI Key / DeepL Key / WebDAV 密码存 `settings` KV 表。全库备份已正确排除凭据（`7d5f500`），但数据目录里的 DB 文件本身是明文，能被同机任何进程读 profile 目录者拿到。
- **订正（实施时发现）**：本报告原先写的方向「**复用 `.ctzx` 机制**（Argon2id + AES-256-GCM）加密这几个 secret 行，零新依赖」**缺了最关键的一半 —— 密钥从哪来**。`.ctzx` 的 Argon2id 是用来拉伸**读者输入的口令**的，而这里若照搬，就得让读者每次启动输一次口令（报告里「解锁时一次性派生、会话内缓存」其实已经默认了这一点，只是没写明代价）。两条路都不是免费的，所以这一条是问过之后再动的。
- **实际做法**：**系统钥匙串保管主密钥**。32 字节随机主密钥存进 macOS Keychain / Windows 凭据管理器 / Linux Secret Service（`keyring` v4，`v1` 模式按平台自动选店），秘密字段用 AES-256-GCM 封装。读者完全无感 —— 没有口令、启动流程不变 —— 而报告点名的那个威胁（同用户的其他进程读 profile 目录）真的被挡住了，因为密钥与数据库处在**不同的访问规则**之下。
  - **这里刻意没有 Argon2**：主密钥已经是 256 位均匀随机数，再拉伸要在每次保存时付 19 MiB 的开销，换不到东西。Argon2 是给低熵口令的，两者密钥来源不同，所以共用 AEAD 而不共用 KDF。
  - **AAD 绑定「settings 行 key + 字段名」**，密文只在它被写入的那一格打得开；把 `deeplKey` 的密文拷到 `apiKey` 上是 GCM 校验失败，不是被悄悄调换的凭据。
  - **`SECRET_FIELDS` 是一条常量、两个消费者**：`secrets.rs` 封装的字段与 `library/backup.rs` 从备份里抹掉的字段是同一批。只改一处，结果要么明文落盘、要么进了导出的归档。
  - **旧明文行原样读出、写入时封装**，启动时 `seal_existing` 补一遍；它没事可做时不碰凭据库，所以除第一次以外每次启动零开销。
  - **打不开的凭据是错误，不是空串**：交回空串看起来就是「没配过」，读者下一次保存就会把空串写回去、毁掉真凭据。
  - **降级可见**：`system.secretsStatus` + 设置页 AI / 同步两块各一行警示。这个状态从输入框里看不出来，不说就等于悄悄降级成明文。
- **代价（明写）**：新增 1 个依赖（`keyring` 4.2，macOS 上就是已在链接的 Security.framework 的薄封装）。Linux 上没有 Secret Service 时**保存凭据会失败并给出原因**，而不是悄悄退回明文。
- **测试**：`secrets.rs` 16 条单测（封装往返、篡改、跨行/跨字段搬运、明文遗留、空值不封装、升级补封、真库读写、`SECRET_FIELDS` 覆盖完整性）+ `SecretsNotice` 4 条组件测试。🔴 **单测里 `master_key()` 返回固定值**（`#[cfg(test)]`）：headless CI 没有 Secret Service，需要真凭据库的套件只会挂。真凭据库的 I/O 由 `#[ignore]` 的 `keychain_round_trip` 覆盖，它用 `probe-account` 而非真账号名，否则删掉的是读者的真主密钥。

### O5 · vitest 无覆盖率可见性　【P3】

- **证据**：无 coverage 配置（清单 1.6 已记）；`pdfCanvas` 这类只能靠 e2e 兜，盲区位置不可见。
- **方向**：加 v8 provider 的 `--coverage`，**只报告不设门禁**，并接进 CI 摘要。目标不是追数字，是把「哪些模块改了没有对应测试」照出来。

### O6 · React Compiler 未启用，但它的 lint 规则已在把关　【P3 · 需实测】

- **证据**：`vite.config.ts` 只有 `@vitejs/plugin-react`，手写 memo 真实起作用，父组件 re-render 带整棵子树（ReaderPage 尤甚）；而 oxlint 的 React Compiler 规则已经在拦 `immutability` 违规（PR#8）。
- **方向**：试启用编译器（react-compiler-runtime），**全量 e2e 验证行为等价**后再默认开启。预期收益是记忆化从「手写 + 审计」变成编译器保证；风险是插件对 foliate 桥这类命令式代码的行为差异，必须双引擎跑完再合。

### O7 · 浏览器替身比真身还大；e2e 仍有 load 敏感 flake　【P2 / P3】

- **证据**：`src/lib/local/backend.ts` 1250 行，比最大的 Rust 后端文件还长；`reading-ruler.spec.ts` 那条负载敏感的 flake 有完整机制记录（单独跑可复现红），归档清单给的候选改法（加重试 / 容差两行高放宽到三行 / 测量前等排版稳定）**未落地**。
- **方向**：① 按 `LOCAL_COMMANDS` 分组拆 `local/{books, annotations, stats, search, ...}.ts`，`backend.ts` 只留 `fromLocal` 转发表——Rust 端与浏览器端从此同名同位；② 三选一治 flake，先加重试（最便宜）。

---

## 四、落地顺序建议

| 批次                 | 项                                                                                         | 状态                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 第一批（小、高感知） | ~~F2 更新角标 → O3 构建剔除字体~~                                                          | ✅ **已落地**（2026-10-12，全量门禁绿）                                                                                     |
| 第二批（结构性）     | ~~F1 快捷键自定义（收编 → 面板）~~ → ~~O1 重跑 ReaderPage 量测~~ → **O1 按渲染分支拆文件** | ✅ **F1、量测、拆分均已落地**（2026-10-12 量测 / 2026-10-13 拆分，全量门禁绿）：三个分支 hook + 页面 2731 → 2553 行（见上） |
| 第三批（数据与安全） | ~~O4 凭据加密~~ → O2 library 分层（纯移动）                                                | O4 **已落地**（2026-10-13）；O2 **全部落地**（2026-10-13，门禁绿）：分层 + `mobi.rs` 八文件 + `clippings.rs` 七文件         |
| 第四批（按需）       | F3 整本 OCR → F4 金句卡片 → F5 OPDS                                                        | 未动                                                                                                                        |
| 随时                 | O5 覆盖率报告 → O7 拆 backend.ts / flake 加重试                                            | 未动                                                                                                                        |
