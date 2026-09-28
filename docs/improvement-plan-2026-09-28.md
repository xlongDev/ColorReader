# ColorReader 代码与体验审查 · 改进建议清单

日期：2026-09-28　范围：全仓（前端 / Rust / 构建 / 文档）
方法：读源码 + 实测统计 + 对两张截图做像素级取样核对。**技术栈与架构不动，不推倒重写。**

> 本文所有结论都标了文件与行号，或标了实测数字。凡是我没能验证的（例如真机 WKWebView 上原生下拉弹出层的实际配色），我标成「待实测」而不是当成结论。

## 进展

**第一批已提交并推送**（`58d8535` + `f9d519d`，本文档本身是第二笔）：P0-1（4 处焦点环）、P0-2（含 `NotesPage` 上同一处图标）、P0-3、P0-4、P1-10、P1-11 —— 9 个文件 +145/−12。校验链全绿（prettier / oxlint 0 error / tsc / vitest 548 条 / playwright 170 条）。

**第二批已落地**（2026-09-28，改动留在工作区，未提交）：P0-5、P1-6、P1-7、P1-13 —— 11 个文件。Rust 侧新增 `book_delete_many` / `book_set_favorite_many` 两条命令（含 `bindings.ts` 重新生成），前端批量条改走它们；`usePdfCovers` 改成串行 + 单次失效；时钟从 `LibraryPage` 下推到 `ShelfHeader`；`LibraryStats.reading` 的口径收紧。

校验链全绿：`cargo fmt --check` / `clippy --all-targets -D warnings` / `cargo test`（418 条）/ prettier / `oxlint .`（0 warning）/ `tsc` / vitest 548 条 / playwright 170 条。新增的统计断言验过在旧口径上会红（`reading: 2` vs `1`）。

**第四批第一笔已落地**（2026-09-28，改动留在工作区，未提交）：P2-14 的第 ④ 笔 —— 朗读引擎整层抽成 `src/hooks/useReadAloud.ts`，`ReaderPage.tsx` 净 −423 行（3348 → 2925），顺带把 `pdfWash` 的偏移算术移进 `speech.ts` 并补上它此前没有的单测。校验链全绿：prettier / oxlint 0 warning（257 文件）/ tsc / vitest 563 → **588 条** / `vite build` / playwright 170 条（169 passed / 1 failed，是既有 flake，见下）。详见 P2-14 的 PR#4。**已提交并推送**（`7b07b8a` + `17e676d` + `5fb1bc6`，三笔按文件拆开，逐笔 `git archive` 检出验过 tsc / oxlint）。

**第四批第二笔已落地**（2026-09-28，改动留在工作区，未提交）：量完发现计划里的 ⑤「位置与导航」不能成笔（46 处引用在簇外），改做接口真正窄的 **实测页数** → `src/hooks/usePageCounter.ts`，`ReaderPage.tsx` 删 96 / 加 25。详见 P2-14 的 PR#5。**已提交并推送**（`5a8ed1a` + `4bb4266`）。

**第四批第三笔已落地**（2026-09-28，改动留在工作区，未提交）：同一把尺子的第二个候选 **自动滚动** → `src/hooks/useAutoScroll.ts`，`ReaderPage.tsx` 删 72 / 加 27，顺带补上这条行为此前的**零覆盖**（9 条单测）。详见 P2-14 的 PR#6。**已提交并推送**（`9c64622` + `5b2f317` + `65d02b5`，含量测脚本）。

**第四批第四笔已落地**（2026-09-28，改动留在工作区，未提交）：重新量完的第一顺位 **图片/灯箱** → `src/hooks/useImageLightbox.ts`，`ReaderPage.tsx` 删 109 / 加 27。详见 P2-14 的 PR#7。**已提交并推送**（`afb89ff` + `aa60295`）。

**第四批第五笔已落地**（2026-09-28，改动留在工作区，未提交）：全表出口最少的 **搜索/AI 跳转** → `src/hooks/useHitJumps.ts`，`ReaderPage.tsx` 删 52 / 加 24。它**不持有任何状态**，三个回调共享一条规则；React Compiler 的 `immutability` 规则拦了一次并改对了。详见 P2-14 的 PR#8。**已提交并推送**（`12c1307` + `d978e96`）。

**第四批第六笔已落地**（2026-09-29，改动留在工作区，未提交）：foliate 桥量完确认「不能顺手做完」（174 行、入口 22、出口里 `foliateRef`×14 是共享句柄、入口里有四个脊柱 setter），先取它最窄的一片 —— 交给渲染器的**样式对象** → `src/features/reader/useFoliateStyle.ts`，`ReaderPage.tsx` 删 46 / 加 13。详见 P2-14 的 PR#9。

**第四批第七笔已落地**（2026-09-29，改动留在工作区，未提交）：foliate 桥量完确认过的那笔大活 —— 它的**位置/目录那一半** → `src/features/reader/useFoliateBook.ts`，`ReaderPage.tsx` 删 173 / 加 72（2666 → 2565）。详见 P2-14 的 PR#10。**同一轮把那条 flake 治了**（`selection-toolbar.spec.ts:101`：第一次导航不再等 `load`，并加一次重试），见下面那节。

**待做**：第三批只剩 P1-8（真机验证原生下拉配色）；第四批是结构性的（P2-14 起）—— 已落地 ④ 朗读引擎、⑤ 实测页数、⑥ 自动滚动、⑦ 图片/灯箱、⑧ 搜索/AI 跳转、⑨ foliate 样式对象、⑩ foliate 桥的位置/目录那一半。**foliate 桥剩下的一小块不抽**：`foliateRef` 是导航 / 标尺 / 朗读共用的句柄，`clearPaintedMatches` 与 `foliateRulerLines` 只是它的两个窄封装 —— 抽走等于换个名字，不减少任何耦合。**下一个候选是 PDF**，但出口 24 里有 8 处在脊柱里（`goTo` 直接写 `el.scrollTop = clamped * pdfSlotH.current`，`applyPending` 读 `suppressPdfPending`），要做就得像自动滚动那样让脊柱改调 hook，收益与风险得先量。**「位置与导航」「标注桥接」整簇不做**（分别是脊柱与页面中心 UI 状态）。**那条 flake 已治**，见下一节。

### 实施中发现的两条 flake（与本次改动无关，但值得记）

- `cargo test` 里 `dictionary::tests::the_system_dictionary_answers_a_real_word`（macOS 系统词典 FFI）**在并行负载下会偶发失败**：同一次全量里它失败，单独跑 3/3 过，HEAD 全量也过，重跑全量又 418/0。它只在 macOS 上编译，CI 跑 ubuntu 不受影响，**但本地全量跑会出现假红**。
- `e2e/selection-toolbar.spec.ts:101`：**挂过四次**（第一批之后、PR#3 之后、PR#5 之后、PR#8 之后），**四次都是同一个签名**：webkit、`page.goto("http://localhost:4173/?demo=1")` 等 `load` 超时 30s，也就是那条用例的**第一次导航**；四次单独跑都过（6/6、6/6、4/4、4/4）。它是这套 e2e 里复发率最高的一条。
- `e2e/image-lightbox.spec.ts:148`：断言 `download="fig3.png"` 失败。**这条挂过两次** —— 一次在 PR#3 之后，一次在 PR#4 的全量里（`169 passed / 1 failed`），两次单独跑都是 `--repeat-each=2` 8/8 过，且两次的失败行与断言完全相同。**第三次出现在 PR#10 的全量里**（chromium，`169 passed / 1 failed`），单独跑 `--repeat-each=2` 仍然 **8/8 过**。
  **这一次留下了 trace，机制查清了**（`trace: "retain-on-failure"` 只在失败时留存，所以前两次没有）。读 `trace.zip` 的动作日志：`img[data-path] >> nth=2`（`fig3.png`）的**点击是成功派发的**（`click action done`，无错误），随后 `保存图片` 那条 `expect` 等了 5003 ms 超时；而失败快照里**整个页面没有灯箱**（主文档与两个 section iframe 里 `保存图片` / `上一张` 各出现 0 次，图片仍在 iframe 里）—— 也就是**点了但应用没响应**，不是「打开了但内容不对」。
  关键在动作耗时：`attempting click action` 到 `element is visible, enabled and stable` 之间等了 **20 秒**（61870 → 61890）。foliate 的 paginator 在那段时间里一直在重排（换列是 `transform`），Playwright 判定「稳定」后派发点击，而列又移走了 —— 这正是仓库里已经记过的那条：**点在已被移出视口的列上会静默无效**。所以这条的成因与 `selection-toolbar:101` **不同**：那条是导航没落地，这条是**点击落在移动中的分页列上**。
  可能的改法（**未做**，见下）：`bookImage` 的轮询现在只要求「≥48px 且在视口内」，可以再加上「盒子连续两次采样不变」；但那只缩小竞态窗口，不消除它 —— Playwright 自己已经做过稳定性检查仍然丢掉了这一次。真正对症的是**点完验证灯箱开没开、没开就再点一次**（灯箱是关闭状态时可安全重试；打开状态下重试才是错的）。

**八次全量、四条不同的 spec** —— 大约 1/170 的 flake 率，都出现在 10 分钟以上的长跑里（`selection-toolbar:101` 占四次、`image-lightbox:148` 占三次、`reading-ruler` 占两条）。**每次换个地方坏**，而不是「同一处又坏了」。不要当成「改动引入的回归」；判定办法一律是「单独跑也过」。

**「负载」不是完整解释，这一点要更正。** 我原先的记录说是负载（`reading-ruler` 那次 load 12.46 挂 2 条、PR#7 那次 load 5.08 全过）。但 PR#8 这次 `load average` 只有 **2.97**，照样挂一条 —— 而且**四次都是同一个签名**：webkit、那条用例的第一次 `page.goto` 等 `load` 超时。所以更像两件事叠在一起：① `reading-ruler` 那种是**时序断言**（容差两个行高），负载高就红；② `selection-toolbar:101` 这种是**长跑里 webkit 实例的第 N 次导航** —— 跟 CPU 无关，跟浏览器活了多久有关。要治的是第 ② 类。

- **`e2e/reading-ruler.spec.ts:547`（`dragging the band…`）—— 这条不一样，单独跑也会红，所以做了一次完整对照。**
  它断言的是「拖动之后重新打开，带要停在拖到的位置」，容差只有两个行高，而它要做「拖动 → 松开 → 重新打开 → 再量」，是最吃时序的一条。

  | 版本                     | 结果                                                     |
  | ------------------------ | -------------------------------------------------------- |
  | 全量（PR#2 版本）        | 169 passed / 1 failed（就是它）                          |
  | 单独全 spec（PR#2）      | 15 passed / 1 failed → 再跑一次 **16/16 全过**           |
  | 单条 ×3（PR#2）          | 过、过、**红**，耗时 9.7 → 12.8 → 16.2s（负载在爬）      |
  | 单条 ×6 chromium（PR#2） | **6/6 全过**，每条 ~10s                                  |
  | 全 spec（HEAD）          | **16 passed**                                            |
  | 单条 ×3（HEAD）          | **3/3 全过**，chromium 14.4 / 13.6 / 13.4s（比上面还慢） |

  **这条 spec 整体是负载敏感的**：PR#6 的全量里它一次挂了**两条不同的**（`:512` 与 `:606`，都是 webkit），而那次全量跑了 13.1 分钟（比前一次多 2.6 分钟），`uptime` 的 load average 是 **12.46**。清掉残留的 preview 服务后单独跑全 spec：**16/16 全过**，包括 547。

  累计：PR#2 版本 3 红 / 12 次，HEAD 0 红 / 4 次，**但三次红全部落在机器最重的窗口**（紧随 271s 的 vitest 与 13.4 分钟的全量 e2e；其中一次尝试直接被 SIGTERM 杀掉）。机器空下来后两个版本都全绿。

  改动本身按检视是**行为中性**的：被移动的那个 effect 在没有定时器时是空转的（`if (sleep?.kind !== "minutes") return`），`clearIfChapterEnded` 身份稳定，`onChapterEnd` 的依赖集合换名不换重建条件。

  结论：负载相关的时序 flake，不是回归。**但它是这一批里最该先修的**（唯一一条单独跑都红过的），要么加重试，要么把容差从「两个行高」放宽到「三个」，要么在量之前等排版稳定。

#### 治掉了第 ② 类：`selection-toolbar.spec.ts:101`（2026-09-29）

**先量，再改。** 三条探针，全部在打包后的产物上跑：

| 探针                                                | 结果                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| 正常首次导航的 `domcontentloaded` / `load`          | **58–135 ms / 70–155 ms**，`load` 只比 DCL 晚约 40 ms              |
| 首屏资源数                                          | **8 个**（html + css + 6 个 JS chunk）—— 582 个 woff2 一个都不在内 |
| 同一个 webkit 进程里连跑 80 次「新 context + 导航」 | 最大 **71 ms**，`slow > 400ms` 的有 **0 次**                       |

所以两条最顺手的解释都被否掉了：**不是字体慢**（`load` 等的根本不是它们），**也不是「浏览器活了很久就退化」**（80 次冷导航毫秒级）。而正常值 75–120 ms 对 30 s 超时是 **250 倍**的偏离 —— 那不是慢，是一次**没有落地的导航**。成因**仍未证明**（没有留下 trace：`trace: "retain-on-failure"` 只在失败时留存，而 `test-results/` 里那几次的产物已经不在）。

**改法（`e2e/selection-toolbar.spec.ts`）：**

1. **不再等 `load`。** 这个测试不需要它：假书架是 JS 现搭的，后面每一步要么是自动等待的定位器、要么是显式的 `waitForSelector`。测量显示 `load` 只多给 40 ms，却把整条用例暴露在「什么东西卡住」上。改成 `waitUntil: "domcontentloaded"`。
2. **第一次导航加一次重试**（第一次 12 s，第二次用默认超时）。卡住的导航不会因为等而恢复，重开的会 —— 「重跑一遍就过」一直就是在手工做这件事。文件超时相应提到 60 s（`test.describe.configure`），因为第一次尝试会花掉它自己的整个预算。

**验证**：该 spec 双引擎 **6/6 过**。重试路径本身也验过 —— 把第一次的 `timeout` 压到 `1`，让它在 `try` 里必定失败并紧跟着 `throw`（若 `goto` 真的成功就会被这个 `throw` 抓住）：测试仍然全绿，说明确实是 catch 接住后重试的，不是「1 ms 也能过」。之后恢复 12 s 再跑一遍，仍 6/6。

**留下的一件不确定的事**：如果卡住的是**导航提交**本身（而不是 `load` 事件），那么去掉 `load` 帮不上忙，起作用的只有重试。这两条一起加，是因为我分不出是哪种 —— 重试对两种都成立，而 DCL 只是顺手把「测试根本用不到的等待」删掉。

#### PR#8（2026-09-28）：`useHitJumps` —— 全表出口最少的一笔，而且它**不持有任何状态**

40 行 / 入口 7 / **出口 2**。它和别的簇都不一样：**状态数为零**，三个 `useCallback` 共享一条规则 ——

- 位置在**当前这一章** → 现在就滚过去；
- 位置在**别的章** → 那一章还没取、更没排版，所以记下偏移、`goTo` 换章，等 `applyPending` 在正文出现时滚；
- 引用指向**另一本书** → 那不是跳，是导航。

每条分支都是「往哪个槽里写」的承诺，写错了就是「跳到命中结果却滚了一个还没取到的章节」。

**React Compiler 的 `immutability` 规则拦了一次，而且它是对的。** 我最初把 `pendingFocus`（脊柱的 ref）直接传进去，在 hook 里写 `pendingFocus.current = x` —— oxlint 报 `This value cannot be modified`，并提示「由所有者提供更新回调」。改成 `setPendingFocus(offset)`。这是这一批里**第三次被工具抓到我本来要直接交出去的东西**（前两次：PR#4 那个「多余依赖」其实是对的、`close` 必须身份稳定）。由此得到一条新的硬规则：**hook 不许改不属于自己的 ref；传 setter，不传盒子。**

`useNavigate()` 挪进 hook（少一个入口）；`pickHit` / `jumpToCitation` 两个别名让两处消费点零改动。

校验：prettier / oxlint 0 warning（265 文件）/ tsc / vitest 621 → **628 条** / `vite build` / playwright 170 条 → 169 passed / 1 failed，是 `selection-toolbar.spec.ts:101`（既有 flake 第四次，签名一致，单独跑 4/4 过）。`ReaderPage.tsx` 删 52 / 加 24。五次定向变异全被抓（同章也去等渲染 / 跨章不等渲染直接滚 / 别书引用不跳转 / 正文没到也照滚 / 记下偏移但不换章）。

#### PR#9（2026-09-29）：foliate 桥太大，先取它最窄的一片 —— `useFoliateStyle`

按重量后的顺序，下一个候选是 foliate 桥。量完确认了 PR#8 那条判断：**174 行、入口 22、出口 35**，而且出口里 `foliateRef`×14 是**共享句柄**（`goTo` / `flip` / `applyPending` / 朗读都在用它，不是这一簇的私有物），入口里还带着四个**脊柱的 setter**（`setChapterIdx` / `setDisplayProgress` / `setProgress` / `setLookup`）—— 也就是说这一簇会**驱动导航状态**。计划里写它「值得一笔大活，适合单独一轮」，量完同意：它不是一笔能顺手做完的东西。

所以先取它里面**接口最窄的一片**：交给 foliate 渲染器的那个**样式对象**（`foliateStyle` memo，41 行、入口 9、出口 1）。它正好是 `foliateStyle.ts` 那个模块的**输入类型** —— 那个模块已经有 `buildStyleSheet(FoliateStyle)` 和它自己的测试，缺的就是「阅读设置 → `FoliateStyle`」这一半。搬进 `src/features/reader/useFoliateStyle.ts`（和 `usePdfZoom` / `useReaderLayout` 做邻居），返回类型直接写 `FoliateStyle`，于是两半**按类型对接**，不再靠约定。

三条规则跟着它走，都是「字段为什么长这样」而不是「怎么算」：

- **调色板跟阅读面走，不跟外壳主题走**（和 PDF 夜间路径同一个触发条件）。阅读面是绝对的：读者可以在夜间页上、而应用是白天模式。
- **反色是读者的决定，不是阅读面的**。默认关：调色板已经让页面变暗，而反过来的照片读起来是缺陷不是特性。
- **字体要跟着样式表走**（section 是独立 document，应用自己的声明进不去），导入的 + 应用自带的（霞鹜文楷）拼在一起 —— 这是「读者选了它」和「读者拿到系统楷体」的区别。

校验：prettier / oxlint 0 warning（267 文件）/ tsc / vitest 628 → **633 条** / `vite build` / playwright **170/170 全过**（13.7 分钟，负载 6.39；覆盖这条路径的 `font-display.spec.ts` 与 `kindle-reading.spec.ts` 都在里面）。`ReaderPage.tsx` 删 46 / 加 13（2699 → 2666）。新增 5 条单测；五次定向变异全被抓（调色板不跟阅读面 / 反色跟随阅读面 / 行高越界不兜底 / 空来源留分隔符 / 竖排开关丢失）。

**变异脚本自己也被抓了一次，值得记**：`invertImages` 与 `vertical` 在文件里各出现两次（对象字面量一次、依赖数组一次），我那个「`count(old) == 1` 才动手」的守卫因此**拒绝执行**这两个变异 —— 没有它，我会拿着「测试全绿」当成「变异被抓住」。**给变异脚本加唯一性断言，是让「没跑」和「跑了但没红」不可能混淆的最便宜手段。**

#### PR#10（2026-09-29）：foliate 桥的位置/目录那一半 —— `useFoliateBook`

PR#9 量完说这一簇「值得一笔大活，适合单独一轮」。这一轮就是那一笔，但**没有整簇搬走**：按「出口来自哪里」再量一次，它其实是两半。

**留下的那一半（`foliateRef` 及其两个窄封装）不该抽。** `foliateRef`×14 是共享句柄 —— `goTo` / `flip` / `applyPending` / 朗读 / 标尺 / 面板都在用它；`clearPaintedMatches` 与 `foliateRulerLines` 只是它的两个具名封装（`useReaderPanels` 要前者身份稳定）。把这三样收进一个 hook，脊柱那边就得改成 `handle.current?.goToFraction()` 这种绕一层的写法，**耦合一点没少**，只是换了个名字。这不是「剩下的以后再抽」，是**判定不做**。

**搬走的那一半**（`src/features/reader/useFoliateBook.ts`）：四个 foliate 状态（`toc` / `sectionLabel` / `page` / `bookPage`）、`rememberFoliateLocation` 与它自己的 debounce 定时器、三个视图回调（`select` / `annotationClick` / `anchor`）、两个派生 memo（`tocChapters` / `tocIdx`）与 `hasToc`。`ReaderPage.tsx` 删 173 / 加 72（**2666 → 2565**）。

三个判断：

- **入口里那四个脊柱 setter 是正常的，和 PDF 不是一回事。** PDF 那 8 处出口是**脊柱读写簇的内部**（`goTo` 直接 `el.scrollTop = clamped * pdfSlotH.current`），所以不做；这里的方向是反的 —— 页面把「怎么记位置」告诉 hook（`setChapterIdx` / `setDisplayProgress` / `setProgress`），hook 从不反过来动脊柱。**同一种耦合，方向决定它是不是问题。**
- **`POSITION_SAVE_DELAY_MS` 搬进了 `progress.ts`。** 原来 `SAVE_DELAY_MS` 在 `ReaderPage` 里，现在两个模块（prose 的 `onScroll` 与 foliate 的位置上报）需要同一个值，而「一条规则写两遍」正是 PR#3 抓到过缺陷的形状。放在 `progress.ts` 是因为两边都已经 import 它。
- **`PendingSelection` 从 `ReaderPage` 的内联类型提到 `selection.ts`。** 四个渲染器各建一个（prose、PDF 文字层、foliate 的两个回调），它本来就不是某一个模块的私有状态；hook 要建它，类型就得有个共享的家。
- **顺手改了一个名字**：`useFoliateToc` → `hasToc`。它是个布尔（「foliate 的目录是不是该读的那份」），但顶着 `use*` 前缀，和 `useFoliate` / `useFoliateStyle` / 新来的 `useFoliateBook` 摆在一起会读成一次 hook 调用。7 处引用一起改。

校验：prettier / oxlint 0 warning（268 文件）/ tsc / vitest 633 → **645 条** / `vite build` / playwright 170 条 → **169 passed / 1 failed**（11.6 分钟），失败的是既有的 `image-lightbox.spec.ts:148`（第三次，单独跑 `--repeat-each=2` 8/8 过，机制这一次由 trace 查清了，见上面 flake 那节）—— `selection-toolbar` 在这轮长跑里**过了**，正是这次要治的那条。新增 12 条单测；**十次定向变异全被抓**（分数不驱动脊柱 / 章号不从分数落地 / 空 CFI 也写位置 / 无 debounce 每帧写一次 / `select` 不关查词浮层 / pill 不带 CFI / 未知 CFI 当成命中 / 目录深度被拍平 / 非 foliate 书也读 foliate 目录 / 卸载后定时器仍写）。依赖数组也验过：临时抽掉 `select` 与 `remember` 里的两个依赖，oxlint 报 **4 个 error**，说明 `exhaustive-deps` 真的在看着这两个 hook（不验这一下的话，「0 warning」只说明它没说话，不说明它在看）。

量测脚本的复量：foliate 桥 **146 行 → 56 行**，剩下的正是那段别名解构（393-419）加上 `foliateRef` 与它的两个 helper —— 和「抽干净了没有」的判据一致。

---

## 一、现状盘点（实测数字）

### 1.1 分层

```
React 19 渲染层（Zustand 偏好 / TanStack Query IPC 数据）
        ↓  Tauri IPC（71 命令 · 5 事件 · 单一出口 src/lib/ipc.ts）
Rust 单 crate（解析 / 索引 / 检索 / 文件 IO / AI 编排）
        ↓
SQLite WAL · FTS5(trigram) · 向量走 Rust 暴力点积
```

边界规则（React 不碰文件系统、整本书不进 State/DOM、大文件解析不在渲染层）**在代码里是成立的**，不是文档口号：`ipc.ts` 是唯一出口，`bookAsset` / `bookSourceFile` / `webviewCaptureRegion` 走二进制通道，其余全部由 `cargo test export_bindings` 生成的 `bindings.ts` 供类型。

### 1.2 规模

| 区域                                     | 实测                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 前端 `src/`（不含 vendor）               | 214 个 ts/tsx，43,727 行                                                                                                   |
| `src/vendor/foliate-js/`（readest fork） | 13,699 行                                                                                                                  |
| Rust `src-tauri/src/`                    | 21,895 行；22 个 `commands/`、23 个 `library/`、9 个 `document/`                                                           |
| 单文件最大（前端）                       | `ReaderPage.tsx` 3382 · `FoliateBookView.tsx` 1580 · `SettingsPage.tsx` 1271 · `lib/local/backend.ts` 1225                 |
| 单文件最大（Rust）                       | `document/mobi.rs` 1809 · `library/clippings.rs` 1597 · `library/repository.rs` 1092 · `library/sync.rs` 970               |
| IPC                                      | 76 个命令（73 由 specta 生成，3 个二进制通道手写：`book_asset` / `book_source_file` / `webview_capture_region`）+ 5 个事件 |
| 测试                                     | 53 个单测文件 / 214 个源文件；Rust 421 个 `#[test]`；e2e 33 个 spec / 5076 行 / chromium+webkit 双引擎                     |
| 构建产物                                 | `dist` 33 MB：woff2 582 个共 29 MB、JS 46 个共 1.9 MB、CSS 604 KB（含 582 条 `@font-face`）                                |
| 最大 chunk                               | `pdf` 431 KB、`index` 413 KB，均低于 500 KB 红线                                                                           |
| 代码标记                                 | `TODO`/`FIXME`/`HACK` 0 处，`@ts-ignore` 0 处，`as any` 3 处                                                               |

### 1.3 技术栈（与文档一致，无漂移）

React 19.2 / Vite 8.2（rolldown）/ Tailwind v4 / motion 13 / Radix（dialog、switch）/ TanStack Query 5 / Zustand 5 / pdf.js 6.3.289 / Phosphor 图标；Rust 侧 rusqlite(bundled) + FTS5 + RustCrypto（argon2、aes-gcm）+ pdf-extract。

`tsconfig` 是**严格档**：`strict` + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters` + `verbatimModuleSyntax`。这一项比大多数项目高，值得保持。

### 1.4 页面与组件地图

| 层     | 内容                                                                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由   | `AppShell` + memory router；书库 / 最近 / 收藏 / 标签**是同一个 `LibraryPage` 的四个 filter**（`SHELF_VIEWS` 共用 key，切 filter 不重挂载）；笔记 / 统计 / 搜索 / 设置 / 阅读器各自 lazy                                                                                                              |
| 布局   | `TitleBar`（仅 36px 拖拽带）/ `GlassSidebar` / `NavList` + `Footer` / `GlassPanel` 内容面板 / `data-overlay-host` 浮层宿主                                                                                                                                                                            |
| 材质   | `glass`（e1 无模糊）/ `glass-2`（e2 顶层模糊）/ `glass-solid`（e3 气泡），只有 `GlassSurface` 一个入口                                                                                                                                                                                                |
| 书架   | `ShelfHeader` / `ShelfToolbar` / `ShelfGrid`（窗口化渲染 + 两段 spacer）/ `BookCard`（grid·list 两态）/ `ShelfBatchBar` / `ContinueReadingCard` / 6 个 lazy 对话框                                                                                                                                    |
| 阅读器 | `ReaderPage`（宿主）+ `FoliateBookView` / `ReaderChapterView` / `PdfPageView` / `PdfScrollView` / `ReaderChrome` / `ReaderHeader` / `ReaderDrawer` / 7 个面板（目录·标注·搜索·AI·导读·图谱·设置）/ `SelectionToolbar` + `QuickLookup` / `TtsPlayer` / `RsvpPlayer` / `ReadingRuler` / `ImageLightbox` |

### 1.5 状态管理（归属清楚，没有越界）

- **Zustand**：`settings`（persist v1：主题、透明度、侧边栏、`shelfViews` 按 filter 存、`notesView`）、`reader`（persist v7：排版 / 主题 / 表面 / 翻页动画 / 朗读 / 标尺 / RSVP）、`chrome`、`command-palette`、`toasts`、`book-handoff`、`commands`（命令注册表）。
- **TanStack Query**：所有 IPC 数据，`staleTime: 10s`，写操作 `onSettled → invalidateQueries(["books"])`。
- **派生**：`useMemo`（`shelfSections`、`pickContinueReading`、`buildBookQuery`）。
- React Compiler **未启用**（`vite.config.ts` 只有 `@vitejs/plugin-react`），所以手写 memo 是真的在起作用，也意味着**父组件 re-render 会带着整棵子树**（见 P1-7）。

### 1.6 质量基建

- pre-commit：prettier / oxlint / tsc / rustfmt / clippy；CI 额外跑 `pnpm verify`（tsc+oxlint+vitest+build）、双引擎 playwright、`cargo fmt --check` + `clippy -D warnings` + `cargo test`。
- e2e 的失败注解做了折叠（GitHub 只留 10 条 annotation），这个细节说明 CI 是被真正用过的。
- **没有覆盖率度量**（vitest 无 coverage 配置），单测密度不均：`rulerPointer.test.ts` 437 行 vs `pdfCanvas` 这类只能靠 e2e 兜。

### 1.7 已经做得好、这轮不建议动的地方

- **命令注册表单一事实来源**（`lib/commands.ts` → 键盘 / 命令面板 / 菜单共用）。
- **标注是不可变字符区间**，偏移由前端算、后端只做不透明存储；不做 re-location 引擎，理由是「章节正文对一本书不可变」，成立。
- **书档 `.ctz` 装原文件 + reading.json**，不装章节和封面（避免两份数据打架）；`.ctzx` 的 KDF 参数作为 GCM 的 AAD，篡改得到认证失败而不是静默降级。
- **深链只带身份不带位置**，因为三种位置模型互不通约。这是被证据逼出来的设计，正确。
- **浏览器端（IndexedDB）与桌面同形**：同一套 hook、同一个 query key，只有 `ipc.ts` 分岔。
- **三档可访问性降级**（reduced-motion / reduced-transparency / prefers-contrast）与 `focus-ring` opt-in 约定。
- **书架窗口化 + 固定 138px 轨道**（不用 `1fr`，所以侧边栏动画不会让封面缩放），以及为它写下的那套算术约束。

---

## 二、必须修复（正确性与明显缺陷，投入都很小）

### P0-1 两个下拉框（及另外 2 个控件）没有任何焦点指示　【已修复】

- **问题**：`ShelfToolbar` 的排序、分组两个 `<select>` 都写了 `outline-none` 且**没有替代品**。全项目 `focus-visible:focus-ring` 出现 86 次，这两个漏了。同类还有 `SourceDialog.tsx:129`（select）、`SourceDialog.tsx:302`（textarea）。
- **位置**：`src/features/library/ShelfToolbar.tsx:103`、`:183`；`src/features/source/SourceDialog.tsx:129`、`:302`
- **订正（动手时发现）**：这条原先还列了 `TtsPlayer.tsx:775`（自定义定时分钟数）。**那处不是缺口** —— 它的外层 `<form>` 带着 `focus-within:ring-accent focus-within:ring-1`，环由父级画，看 `outline-none` 的 grep 结果会误判。清单里已删掉。
- **方向**：按仓库既有约定补，但要按控件自己有没有边框分两种。`ShelfToolbar` 的两个 `<select>` 的边框和底色画在**外层 div** 上，所以补的是那个 div 的 `focus-within:focus-ring`（与 `NavList` 里 theme radio 的 `focus-within:focus-ring` 同一手法）；`SourceDialog` 的两处控件自带边框，补 `focus-visible:border-accent`（与 `GlassInput` 同一手法）。
- **收益**：键盘用户在这两处不再「按 Tab 之后不知道焦点在哪」。这是唯一一条真正意义上的可达性缺陷。
- **验证**：`pnpm exec prettier --check . && pnpm exec oxlint . && pnpm exec tsc --noEmit`；再键盘 Tab 走一遍书架工具栏。

### P0-2 「批量管理」和「网格视图」用的是同一个图标　【已修复】

- **问题**：`ShelfToolbar.tsx` 里 `SquaresFour` 出现两次：一次是网格视图切换（`:220`），一次是批量管理按钮（`:253`）。截图核对：这两个 2×2 方格图标**水平相邻、完全同形**，语义却一个是「怎么显示」一个是「进入多选」。
- **位置**：`src/features/library/ShelfToolbar.tsx:220`、`:253`
- **补记（动手时发现）**：`NotesPage.tsx:555` 的「批量管理」用的是同一个 `SquaresFour`。那一页没有网格切换所以不构成撞车，但**同一个动作在应用里该是同一个图标**，所以一起换了。`notes-page.spec.ts` 靠可访问名「批量管理」定位，图标不影响它。
- **方向**：换成 `CheckSquare`（`@phosphor-icons/react` 已装，不新增依赖）。
- **收益**：消除工具栏里唯一的图标歧义；这一行本来就拥挤，两个同形图标让「批量管理」看起来像视图切换的一部分。
- **验证**：截图比对；`shelf-manage.spec.ts` / `notes-page.spec.ts` 复跑（已通过）。

### P0-3 书卡的元信息行会随「有没有作者」左右跳　【已修复】

- **问题**：`BookCard` 的作者槽是 `min-w-0 flex-1` 的 `MarqueeText`，没有作者时这个节点**整个不渲染**，于是「格式 · 大小」从右端跳到左端。截图核对（同一行相邻两本书）：`深入浅出Node.js` 的 `PDF · 11.0 MB` 右对齐，`算法图解` 的 `PDF · 17.1 MB` 左对齐。6 列网格里每行的第二行文字边缘都不齐。
- **位置**：`src/features/library/BookCard.tsx:240-252`、`src/features/library/format.ts:65`
- **方向**：作者槽**恒定占位**（有作者渲染 marquee，无作者渲染一个 `flex-1` 的空 span），或把格式块改成 `ml-auto shrink-0`。前者更稳，因为 `reserveTags` 那套「一行高度必须恒定」的理由同样适用于宽度。
- **收益**：一行文字的右边界稳定，书架从「一堆卡片」变回「一张表」。
- **验证**：`BookCard.test.tsx` 加一条「无作者时格式块仍有 `ml-auto` / 作者槽仍存在」的断言。

### P0-4 占位作者 `Unknown` 原样上屏　【已修复】

- **问题**：截图里 `深入浅出Node.js` 的作者显示为字面量 `Unknown`。代码里搜不到这个字符串，说明它来自书自己的元数据（Calibre 转换的书常见），而 `authorLine()` 只做 `authors.join(" / ")`，没有任何占位词处理。结果是一个全中文界面里出现英文 `Unknown`，读起来像应用报错。
- **位置**：`src/features/library/format.ts:65`（`authorLine`）；导入侧 `src-tauri/src/library/import.rs` 落 `metadata.authors`
- **方向**：在 `authorLine` 做一次占位词归一（`Unknown` / `unknown` / `N/A` / `未知` / `佚名` → 空串），空串走 P0-3 的空槽；也可以顺手在 `BookMetaDialog` 里让用户改。不建议在导入期丢弃，那是数据。
- **收益**：书架上不再出现读起来像故障的字符串；顺带把 P0-3 的空槽路径变成常见路径而不是边角情况。
- **验证**：`format.test.ts` 加一条归一断言。

### P0-5 批量收藏 / 批量删除是 N 次 IPC + N 次全库失效　【已修复】

- **问题**：`LibraryPage.tsx:305-314` 把批量动作拆成循环：`for (const id of ids) deleteBook.mutate(id)`。而 `useDeleteBook` / `useSetFavorite` 的 `onSettled` 都是 `invalidateQueries({ queryKey: ["books"] })`。选 20 本删 = **20 次 IPC 往返 + 20 次列表失效**（并发时 TanStack 会把进行中的请求取消重来，于是列表被反复重取）。后端已经有 `annotation_delete_many` 这个先例，书这边没有。
- **位置**：`src/features/library/LibraryPage.tsx:305-314`；`src/hooks/useLibrary.ts:113-129`；`src-tauri/src/commands/book.rs`
- **方向**：Rust 加 `book_delete_many(ids)` 与 `book_set_favorite_many(ids, favorite)`（一个事务里循环，复用现有 repository 函数），前端两个 mutation 改成单次调用 + 单次 invalidate。或者更省事的最小版本：前端 `Promise.all` + 手动只在最后 `invalidateQueries` 一次。
- **实际做法**：走了完整版。`repository` 里的 `delete` / `set_favorite` 拆出 `delete_one` / `set_favorite_one`，`*_many` 收 `&Transaction`（`Transaction` deref 到 `Connection`，所以内部照旧调 `*_one`，SQL 只有一份）；`library::delete_books` 用 `with_tx`，**文件在提交之后才 unlink**，所以失败的批次既不留「有行无文件」也不留「有文件无行」。前端批量条改走新命令，单本删除对话框仍走 `book_delete`。
- **一处清单里没写、但必须一起做的**：浏览器端（IndexedDB）后端也要实现这两个命令——`ipc.ts` 的 `LOCAL_COMMANDS` 加上、`lib/local/backend.ts` 里实现。漏了的话 web 构建会去调 `commands` 里那个 `__TAURI_INVOKE` 而炸掉。e2e 打的正是 web 构建，所以 `shelf-manage.spec.ts` 能抓到，但不该指望它。
- **收益**：批量删除从「N 次往返 + 列表抖动 N 次」变成一次事务；`clippy` 与 e2e 都不受影响（批量条已有 e2e `shelf-manage.spec.ts`）。
- **验证**：`cargo test`（加一条 many 的用例）+ `shelf-manage.spec.ts` 复跑。

---

## 三、体验优化（小改动，直接可感知）

### P1-6 PDF 封面回填没有并发上限，且每本书都失效一次列表　【已修复】

- **问题**：`usePdfCovers` 对**所有**缺封面的 PDF 同时发起 `renderFirstPagePng → bookCoverSave → invalidateQueries(["books"])`。截图那个书库里 PDF 占多数，首次进书架等于并发解析几十个 PDF、并触发几十次列表失效。仓库里已经量过单本封面回填 126ms（WebKit），乘几十就是肉眼可见的一段卡顿。
- **位置**：`src/hooks/useLibrary.ts:50-67`
- **方向**：串行或小并发（2 个一批）+ 批次结束后只失效一次；`coverAttempted` 的去重机制保留。
- **收益**：首次进入书架不再抖动；「刚导入一批 PDF 后书架卡一下」的来源就是这里。
- **验证**：DevTools Performance 里数一次挂载期的 `bookCoverSave` 调用峰值；或临时打点统计 `getDocument` 并发数。

### P1-7 书架每分钟被整体重渲染一次　【已修复】

- **问题**：`LibraryPage` 用 `useState(new Date())` + `setInterval(60_000)` 驱动问候语，而 `now` 只被 `ShelfHeader` 用。React Compiler 未启用，于是每分钟整个页面（含窗口化后的所有 `BookCard`）重渲染一次。
- **位置**：`src/features/library/LibraryPage.tsx:174`、`:223-226`、`:382`；`src/features/library/ShelfHeader.tsx:33`
- **方向**：把时钟下推到一个 `useNow()` hook 或直接放进 `ShelfHeader` 内部。一处搬家。
- **收益**：书架空闲时零重渲染；顺带把「问候语」这件事的边界收在它自己的组件里。
- **验证**：React DevTools Profiler 里静置两分钟，看 `ShelfGrid` 的 render 次数应为 0。

### P1-8 深色主题下原生下拉的弹出层是浅色的（待真机实测）

- **问题**：两处 `<select>` 都带 `[&>option]:text-black`，这是为了在**浅色弹出层**上可读而加的补丁；而这个应用在深色外观下并没有声明 `color-scheme`（这是有意的，见 `index.html` 的注释：根上声明会让 WebKit 把透明根 iframe 画布画成不透明）。不同引擎对 `<option>` 样式的采纳程度不一样：Chromium 自绘弹出层吃 option 样式，WebKit/macOS 用的是原生菜单、基本忽略 option 样式。**我没有真机验证，所以这一条是待实测而不是结论。**
- **位置**：`src/features/library/ShelfToolbar.tsx:103`、`:183`；`src/features/source/SourceDialog.tsx:129`
- **方向**：先在打包后的 app 里、系统深色外观下实际打开一次排序下拉截图。① 若弹出层是深色且文字可读 → 补丁可以直接删掉；② 若是深色但文字是黑的 → 换成自绘菜单（Radix 已在依赖里，加 `@radix-ui/react-select`，或者复用现有 `glass-solid` 做一版轻量 popover，与工具栏其他控件的材质统一）；③ 若确实是浅色 → 保持现状并补一行注释说明这是引擎行为。
- **收益**：不管结论是哪个，都会让「为什么这里有个 `text-black`」从谜团变成记录；如果是情况 ②，这是深色主题下唯一的硬伤。
- **验证**：`pnpm tauri build --bundles app` 后打开，系统外观切深色，截排序下拉的图。

### P1-9 错误状态把后端原始错误直接贴给用户

- **问题**：`ShelfGrid` 的错误分支把 `String(error)` 当成 `description` 渲染。数据库锁、文件缺失、迁移失败都会原样出现在「书架暂时打不开」下面。
- **位置**：`src/features/library/ShelfGrid.tsx:69-78`
- **方向**：给一句人话 + 一个「重试」按钮（`refetch`），原始错误收进可展开的 `<details>` 或「复制诊断信息」。`ErrorBoundary` 的 `scope` 已有，可以复用同一种语气。
- **收益**：失败时用户知道下一步做什么，而不是读一段英文。
- **验证**：临时让 `book_list` 返回 `Err` 看一眼。

### P1-10 搜索无结果时没有出口　【已修复】

- **问题**：`ShelfGrid` 的空状态里，`action` 只在 `!search` 时给（导入按钮）。搜索无结果时用户被告知「换个关键词试试」，但页面上唯一的清除入口是搜索框里那个 13px 的 `✕`。
- **位置**：`src/features/library/ShelfGrid.tsx:79-99`
- **方向**：`search` 非空时把 action 换成「清除搜索」按钮，调用方已有 `onSearch("")`。
- **收益**：空状态从「死路」变成「一步回到全库」。
- **验证**：现有 e2e 可加一条。

### P1-11 「最近」页的副标题承诺了一个不在这页的卡片　【已修复】

- **问题**：`titleForFilter("recent")` 的副标题是「继续阅读的地方」，但 `ContinueReadingCard` 只在 `filter === "all"`（书库页）渲染。截图正是「最近」页，页面上没有那张卡。文案与行为不一致。
- **位置**：`src/features/library/format.ts:8`、`src/features/library/LibraryPage.tsx:394`
- **方向**：两条路选一条。① 最省事：把副标题改成实际行为（例如「最近读过的书」，因为这张书架已按 `最近阅读` 降序，第一块封面本身就是「继续阅读」）；② 更贴语义：把 `ContinueReadingCard` 移到「最近」页首，书库页去掉它。我倾向 ①，因为「最近」页的第一块封面已经承担了这个功能，再放一张大卡是重复。
- **收益**：文案不再撒谎；顺带明确了「继续阅读」这个入口的归属。
- **验证**：截图 + `titleForFilter` 的单测（若加）。

### P1-12 侧边栏底部两个按钮做同一件事，只靠 tooltip 区分

- **问题**：footer 第二行四个等宽按钮里，第 1 个是「折叠侧边栏」（`CaretLeft`，收成窄栏）、第 2 个是「隐藏侧边栏」（`ArrowLineLeft`，整条消失）。两者都是「把侧边栏收起来」，图标同族、按钮同形，差别只在 tooltip 和收起的程度。截图核对：两个图标确实可区分（`<` 与 `|←`），但第一眼要靠试。
- **位置**：`src/components/layout/NavList.tsx:377-402`
- **方向**：两个选项里挑一个：① 合并成一个按钮，长按或右键给第二种；② 保留两个但让视觉分家（隐藏那条用更弱的样式或收进溢出菜单）。不要动 `LayoutGroup` 那套 `layoutId`（它同时负责收栏时的图标 FLIP）。
- **收益**：footer 的四个按钮从「两个是同一件事」变成四个各自清楚的动作。
- **验证**：`settings-rail.spec.ts` 复跑（它测的就是这块）。

### P1-13 「在读 27」的口径比读者以为的宽　【已修复】

- **问题**：截图右下「共 39 本 · 在读 27 · 收藏 6」。SQL 是 `SUM(last_read_at IS NOT NULL AND progress < 0.999)`（`library/repository.rs:165`），也就是「**打开过且没读完**」。打开一本书、翻一页就关掉，也算在读。39 本里 27 本「在读」会让这个数字失去意义。
- **位置**：`src-tauri/src/library/repository.rs:161-172`；展示 `src/features/library/ShelfToolbar.tsx:256-261`
- **方向**：两条路。① 改口径：`progress > 0 AND progress < 0.999`（真的翻过）；② 改文案：把「在读」改成「未读完」。②零风险，①更符合直觉。我建议 ①+② 一起做，因为 27/39 这个比例说明它现在报的不是读者以为的东西。
- **实际做法**：只做了 ①。口径收紧之后「在读」这个词本身就准确了，②随之不必要——**先把数字弄对，再决定要不要改词**。`LibraryStats.reading` 的文档注释同步改写，它会随 `bindings.ts` 生成到前端类型上（`cargo test` 的 `export_bindings` 会把它带过去），所以这一条改动在两端都留下了痕迹。
- **收益**：书架头部的三个数字变成可信的概览。
- **验证**：`repository.rs` 已有 `stats` 的单测，改断言即可。

---

## 四、长期规划（结构性的，别在功能迭代里顺手做）

### P2-14 `ReaderPage.tsx` 是唯一的真巨石：一个函数 3028 行、89 个 hooks

- **问题**：`ReaderView` 从 `:229` 一直到 `:3256`，中间没有任何顶层声明。实测其中 `useState` 12 / `useEffect` 17 / `useRef` 9 / `useMemo` 18 / `useCallback` 33。33 个 `useCallback` 里有一批存在的唯一理由是喂 `useEffect` 的依赖数组。7 个面板、TTS、RSVP、标尺、PDF、foliate 两条通路的编排全在这一个函数里。仓库已经在往外抽（`ReaderChrome` / `ReaderHeader` / `ReaderDrawer` / `ReaderPanels` 都在），所以这是**抽到一半**，不是没开始。
- **位置**：`src/features/reader/ReaderPage.tsx`
- **方向**：按已有的模块边界继续抽，优先级：① 位置与进度（`goTo` / `chapterIdx` / `locateChapter` / 翻页手势状态）→ 一个 `useReaderNavigation`；② 面板开关 + 抽屉（`Panel` 联合类型已经存在）→ `useReaderPanels`；③ 标注与选区桥接 → 已经部分在 `selection.ts` / `ReaderPanels`。**不要一次拆完**，按「一个 hook 一个 PR、每次跑全量 e2e」推进，因为 `goTo` 是全局导航入口（TOC / 书签 / 搜索 / 进度 / 深链都走它）。
- **收益**：这是当前最大的维护风险，也是唯一会随功能增长而恶化的项。拆完之前，任何涉及 `goTo` 的改动都要求跑全量 e2e（114 条 / 约 6 分钟）。
- **验证**：每抽一个 hook 跑 `pnpm exec tsc --noEmit` + `oxlint` + 全量 e2e。

#### 缝在哪（2026-09-28 按 state/ref 的声明顺序量出来的）

`ReaderView` 里其实是 8 个纠缠在一起的东西。下表按「声明顺序」分组，行号是 `ReaderPage.tsx` 里的绝对行号：

| 关注点      | 状态与引用                                                                                                                                | 行段    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 朗读        | `playerOpen` `rsvpOpen` `sleep` `sleepRef` `effectiveVoice`                                                                               | 322–345 |
| 标注桥接    | `annotationsByPage`                                                                                                                       | 346     |
| 面板        | `panel` `search` `pending` `aiContext` `lookup` `searchSeed`                                                                              | 400–430 |
| 位置与导航  | `startCfi` `start` `chapterIdx` `displayProgress` `fraction` `nav` `rememberFoliateLocation` `pendingScroll` `pendingFocus` `fractionRef` | 393–600 |
| foliate 桥  | `foliateToc` `foliateSectionLabel` `foliatePage` `foliateBookPage` `foliateRef` `foliateRulerLines` `foliateSaveRef`                      | 460–600 |
| 阅读标尺    | `rulerRef` `rulerSettleRef` `rulerDirRef`                                                                                                 | 546–560 |
| PDF         | `pdfSlotH` `suppressPdfPending` `pdfScrollPage` `prevPaged` `handlePdfLayout`                                                             | 634–650 |
| 速度 / 统计 | `speedSampleRef` `paceRef` —— **PR#1 已抽出**，见下                                                                                       | 665–670 |
| 实测页数    | `tallyRef` `densityKeyRef` `bookPages`（`bookPagesOf` / `observeUnit`）                                                                   | 675–683 |
| 自动滚动    | `autoScrolling` `debounceRef` `flipHint` `pageInfo`                                                                                       | 430–670 |

**顺序**（每笔一个 hook，每笔一次全量 e2e，约 11 分钟）：① 速度 / 统计 —— **已完成（PR#1）**，见下；② 朗读 —— 三个 state 只喂给 `TtsPlayer` / `RsvpPlayer` 这两个已经存在的组件；③ 面板 —— `Panel` 联合类型和 `ReaderPanels.tsx` 已经把这条边画好了；④ 位置与导航 —— **最后做**。

> 订正：初版把 `tallyRef` / `densityKeyRef` 归进了「速度 / 统计」，因为它们和那两个 ref 挨着。**那是错的** —— 它们属于「实测页数」（`bookPagesOf` / `observeUnit` / `setBookPages`，就是「约 xxx 页」那条通路），跟速度没关系。按声明顺序相邻分组会分错，得看它们实际被谁读写。

#### PR#1（2026-09-28，已落地未提交）：`useReadingPace`

速度采样那 17 行连同 `speedSampleRef` / `paceRef` 两个 ref 从 `ReaderPage.tsx` 搬到 `hooks/useReading.ts` 的 `useReadingPace()`，页面里只剩 `reportPace(progress * totalChars(chapters))` 一行。`ReaderPage.tsx` 3382 → 3361。

两个判断值得留着：**采样点必须留在 `saveProgress` 里** —— 一次进度保存**就是**一段阅读的结束（位置已知、时钟诚实），所以 hook 暴露一个 `report(charsNow)` 让调用方喂，而不是自己起 effect 定时采样。**`reportPace` 的 identity 随 `readingSpeed` 变**（它闭包里读了 `readingSpeed`），所以 `saveProgress` 的 deps 从 `[…, readingSpeed, setReadingSpeed, recordPace]` 变成 `[…, reportPace]` —— 依赖换了名字但**重建条件没变**（原来就依赖 `readingSpeed`），这一步要显式确认，不然会悄悄改变重渲染次数。

校验：prettier / oxlint 0 warning / tsc / vitest 548 条 / playwright 170 条（全量里 `image-lightbox.spec.ts:148` 又挂了一次，单独跑 4 次全过，是 flake）。

#### PR#2（2026-09-28，已落地未提交）：`useSleepTimer`

**这一笔换了目标。** 原计划 PR#2 是「朗读」，理由是「三个 state 只喂给 `TtsPlayer` / `RsvpPlayer`」。量完发现**那个判断是错的**：`playerOpen` / `rsvpOpen` 确实只在 JSX 里用，但 `sleep` 和 `effectiveVoice` 深插在朗读引擎里 —— `sleep` 被一个 effect 消费（到点 `stop()`），`sleepRef` 被 `onChapterEnd` 读，`effectiveVoice` 驱动 `setVoice` 并与 `speechQueue` / `activeUnits`（930–1953 行那套引擎）耦合。**「朗读」不是一片叶子，它就是引擎本身**，一笔拆不完。

所以 PR#2 改成只拿睡眠定时器 —— 引擎边上唯一自洽的一块：两个状态、一个 ref 镜像、一个到点超时、一个 `choose`，对外只和 `stop()` 单向耦合（用回调传进去，倒置依赖）。

顺序因此改为：① 速度统计（已完成）→ ② 睡眠定时器（已完成）→ ③ 面板（已完成）→ ④ 朗读引擎（已完成）→ ⑤ 位置与导航 —— **量完发现它不能成笔**（见 PR#5），改做接口真正窄的那几组。

两件事值得留着：

- **`clearIfChapterEnded` 返回布尔**，而不只是清掉：`onChapterEnd` 要在「刚结束的这个章节是定时器指名的那个」时 `stop()` 并**提前返回**（不自动翻章），所以「清掉了没有」必须在返回值里，不然调用方得去读 ref —— 而 ref 是刻意藏进 hook 的。
- **两个回调必须身份稳定**，而且这条有测试守着。原因写在代码注释里：`onChapterEnd` 是位置 effect 的依赖，那里换个身份就会重放 pending scroll，把页面拽回本章开头 —— 一 arm 定时器就发生。新测试里 `keeps both callbacks identity-stable` 就是钉这个，验过把 `useCallback` 去掉它会红。

**顺带补上了它此前的零覆盖**：睡眠定时器没有任何单测，也没有一个 e2e spec 提过 睡眠/定时/sleep。新增 `src/hooks/useSleepTimer.test.ts`（7 条：到点触发并自清、章节定时器不挂超时、章节结束时被消费且只消费一次、分钟定时器不被章节结束消费、off 清空、身份稳定）。

校验：prettier / oxlint 0 warning / tsc / vitest **555 条** / playwright 170 条。这一轮的 e2e 见下面 `reading-ruler` 那条 —— 为它做过一次完整的对照实验。

#### PR#3（2026-09-28，已落地未提交）：`useReaderPanels` —— 量完发现这一组不值得拆，但翻出两个真缺陷

原计划是抽「面板」（`panel` / `search` / `pending` / `aiContext` / `lookup` / `searchSeed`）。量完发现**这个分组本身就是错的**：`pending` 是**待确认的选区**（浮层、复制、问 AI、落成标注都走它），`aiContext` / `lookup` / `searchSeed` 是「选区 → 面板」的载荷 —— 这三个都属于**选区**关注点。真正属于面板的只有 `panel` 和 `search` 两个 state。

两个 state 不值得为拆而拆。但量的时候翻出两个真缺陷：

1. **关闭搜索抽屉的规则写了两遍，其中一遍漏了一步。** `clearSearch()`（清掉 foliate 画进书页里的命中高亮）**全仓只有一个调用点** —— `ReaderPanels` 的 `onClose` 里。而 Escape 那条路自己写了一份「清查询 + 关面板」，**没有清高亮**：用 Escape 关掉搜索抽屉，命中高亮会留在页面上。这正是「一条规则写两遍」会长的东西。
2. **`Panel` 联合类型声明了两遍。** `ReaderPage` 一份、`ReaderChrome` 一份（后者是正主，`ReaderPanels` 用的就是它），两份内容相同，只靠 tsc 的赋值检查勉强绑着。

做法：`useReaderPanels(initialQuery, clearPaintedMatches)` 收掉 `panel` / `search` / `setPanel` / `toggle` / `close`，**`close()` 同时管两半**（清查询 + 清高亮），并返回「刚才有没有东西开着」给 key handler 判断是否消费掉这次 Escape；Escape 与 ✕ 都改走它。`ReaderPage` 里那份重复的 `Panel` 删掉。

两个判断：

- **`setPanel` 仍然原样暴露**，因为「从抽屉里跳走」的那 5 处（跳到章 / 书签 / 图谱节点 / 命中）**刻意不清理**：查询与高亮是读者的上下文，回来时还在。所以有一个语义化的 `close`（抽屉自己的出口，清理）和一个原始 `setPanel`（跳走，不清理）—— 这不是偷懒，是行为差异。
- **`close` 必须身份稳定**，因为它进了 key handler 的依赖数组：把 `panel` 从依赖里换成 `closePanel` 之后，**那个监听器不再每次开关抽屉都重新注册**。

校验：prettier / oxlint 0 warning / tsc / vitest 555 → **563 条** / playwright 170 条。新增 8 条单测；把 `close` 里的 `clearPaintedMatches()` 去掉，其中 2 条会红（`expected "vi.fn()" to be called 1 times, but got 0 times`）—— 钉的就是这个 bug。

**风险写在前面**：`goTo` 是全局导航入口（TOC / 书签 / 搜索 / 进度 / 深链 / RAG 引用都走它），而且它已经踩过两次闭包陈旧值的坑 —— 一次是 `goTo` 的「已经在这一页」判断读了旧的 `chapterIdx`，导致回弹失效；一次是手势状态放在 effect 的局部变量里，翻页本身会重建 effect、把状态冲掉。拆这一块必须守住三条：手势状态用 `useRef`；任何「现在在哪一页」的判断读 ref 而不读闭包；cleanup 里不结算。

**为什么这一轮没开工**：每笔都要一次 11 分钟的全量 e2e 才算验完，一个会话装不下「读 3000 行 + 抽 + 验 + 修」；而且第 ④ 笔是最容易出事的那笔，不该在赶进度的时候做。缝已经标好了，可以一笔一笔来。

#### PR#4（2026-09-28，已落地未提交）：`useReadAloud` —— 朗读引擎整层搬走，ReaderPage 3348 → 2925

`ReaderPage.tsx` 删 488 / 加 65（净 −423），新增 `src/hooks/useReadAloud.ts` 615 行（含注释）+ `useReadAloud.test.ts` 351 行。搬走的是：语音解析（`effectiveVoice`）、两个播放器表面（`playerOpen` / `rsvpOpen` / `rsvpWords`）、朗读队列（`speechQueue` / `foliateUnits` / `activeUnits`）、wash（`span` / `pdfWash` / 逐词收窄）、跟随 effect、foliate 接续（`readFoliateOnwards` / `continueFoliate`）、以及整套传输（`restartSpeech` / `applySettings` / `seek` / `step` / `skip` / `toggle` / `speakFromSelection`）。

**边界是被一个环决定的，不是被「像不像一个关注点」决定的。** `goTo` 每次换章都调 `stop()`，所以页面必须先拿到 `stop`；而这个 hook 又需要页面的 `onChapterEnd`（换章后自动续读），`onChapterEnd` 建在 `goTo` 之上。两头都要对方 —— 破环的办法是**把 `useTts` 留在页面、把整个 tts 对象传进 hook**（`tts: Tts`，新增的类型别名就是为此）。另一条路是把 `onChapterEnd` 藏进 `useRef` 再在 effect 里同步，**没选**：那是在已经出过两次陈旧闭包的地方再加一份看不见的状态。

留在页面里的三样东西，各有理由：

- **`useTts` 本身** —— 见上面的环。
- **`onChapterEnd` / `autoAdvance` / `applyPending`** —— 语音翻章要落在「新章节 body 出现的同一帧」，那是**位置 effect 的帧**（`requestAnimationFrame` 里 `measureTail` → `applyPending` → 中继标尺）。把重启挪到 hook 自己的 effect 里会改变 `scrollIntoView` 与 `applyPosition` 的先后，所以只暴露一个 `playFromStart()` 让页面在自己的帧里调。
- **JSX** —— `TtsPlayer` / `RsvpPlayer` 要 `title` / `coverUrl` / `headerChapter` / `surface.background` / `stepChapter`，都是页面的事。hook 只出逻辑，页面只出标记。

三个判断值得留着：

- **`playFromStart` 必须身份稳定，而且这条有测试钉着。** 它进了 `applyPending` 的依赖数组，而 `applyPending` 是位置 effect 的依赖 —— 换个身份就会重放 pending scroll，把页面拽回本章开头。同时它**不能是冻住的**：它闭包了队列与 `onChapterEnd`，所以换章必须换新。两条断言一正一反（`keeps playFromStart stable…` / `rebuilds playFromStart when its continuation changes`）。**顺带一件事**：因为 `playFromStart` 已经把队列和 `onChapterEnd` 收进自己的身份，`applyPending` 的依赖数组里就不该再列 `onChapterEnd` 与 `speechQueue` —— 我照旧列了，`oxlint` 的 `exhaustive-deps` 判为多余依赖，**它是对的**，已删并留了注释说明为什么这里看着少了一项。
- **`span` 用解构别名拿回页面**（`const { span: speechSpan, playFromStart } = readAloud`）。理由是同一个：依赖数组里写 `readAloud.span` 是成员表达式，静态检查不了；而依赖整个 `readAloud` 对象会让 `renderedParagraphs` 每次渲染都重算。别名一取，`renderedParagraphs` 的**函数体与依赖数组一个字都不用改**。
- **页面里两份 `readAloud` 成员不该进依赖数组**，这是上面那条的普遍形式。写代码时先把「谁进依赖数组」列出来再动手，比写完再让 lint 报错省事。

**一处 effect 顺序变化，判断为惰性**：hook 在页面里被调用的位置（`onChapterEnd` 之后、`applyPending` 之前）决定了它的四个 effect（`setRate` / `setVoice` / 跟随 / 逐词）现在**排在位置 effect 之前**，原先排在之后。惰性的理由：位置 effect 的实体工作在 `requestAnimationFrame` 里，而跟随 effect 的 `scrollIntoView` 是同步的 —— 两者的**实际执行先后没变**；且这组 effect 只写 tts 的 ref 与 DOM 句柄，页面在它之后声明的 effect 没有一个读朗读状态。

**另外把 `pdfWash` 的偏移算术搬进了 `speech.ts`**（`pdfWashNeedle` + `WashSpan` 类型，新增 6 条单测）。这不是为了拆而拆：那 17 行是「文字层保留了缩进、朗读块已被 trim」之间的坐标换算，**此前零单测**，而它错了的后果是 PDF 上的词高亮错位。搬家顺手给了它夹具。验过断言有效：把 `- lead` 两处去掉，`shifts a block-level wash past the indentation…` 与 `clips a block-level wash that runs into the trailing whitespace` 两条立刻红。

校验：prettier / oxlint 0 warning（257 文件）/ tsc / vitest 563 → **588 条** / `vite build` / playwright 170 条。新增 25 条单测（hook 19 + `pdfWashNeedle` 6）。三次定向变异都恰好打红对应的那条：跨引擎换声去掉中止 → 那条红；`playFromStart` 的依赖冻成 `[]` → 那条红；`restartSpeech` 丢掉引擎报的位置 → 那条红。

#### PR#5（2026-09-28）：⑤「位置与导航」量完**不能成笔** —— 它测出来的是页面脊柱，改做接口真正窄的那一组（`usePageCounter`）

计划里 ⑤ 的目标是「`goTo` / `chapterIdx` / `locateChapter` / 翻页手势状态 → 一个 `useReaderNavigation`」。**按声明顺序量完，这一组不能成笔，理由和 PR#3 是同一种，只是更硬**：

| 符号              | 全文件引用 | 其中在簇外 |
| ----------------- | ---------- | ---------- |
| `chapterIdx`      | 69         | **46**     |
| `fraction`        | 33         | 15         |
| `goTo`            | 25         | 14         |
| `flip`            | 24         | 8          |
| `stepChapter`     | 9          | 3          |
| `displayProgress` | 3          | 2          |
| `nav`             | 2          | 1          |

`chapterIdx` 一项就有 46 处引用在簇外 —— 批注 effect、段落渲染、书签、页眉、笔记页全都按它渲染。把这一簇做成 hook，等于把声明抬一层、再把 85 处引用穿回去：**那不是分离，是搬家加一层间接**。`goTo` 是全局导航入口这条（PR#3 末尾写过的风险）本身就说明它是脊柱，不是一片叶子。

量法：把簇的自身行区间列出来，逐符号打印「总引用 / 区间外引用」的行号。**这把尺子比「看着像不像一个关注点」可靠得多** —— PR#3 和这一笔都靠它纠正了分组。

**改做接口真正窄的。** 同一把尺子量剩下的几组：

| 组       | 出口                                                                          | 入口      | 判定                                                                  |
| -------- | ----------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------- |
| 实测页数 | **2**（`shownPages` 3 处 JSX、`countChapterPages` 5 处调用，全在 `onScroll`） | 11 个纯值 | 做                                                                    |
| 自动滚动 | 2（`autoScrollOn`、`setAutoScrolling`）                                       | 6         | 下一笔候选                                                            |
| 阅读标尺 | —                                                                             | —         | `rulerDirRef` 6 处散在 `flip` / `onScroll` / 位置 effect 里，不是叶子 |

这一笔取 **实测页数**：`tallyRef` / `densityKeyRef` / `bookPages` / `densityKey` / `shownPages` / `countChapterPages` 合成 `usePageCounter`，`ReaderPage` 删 96 / 加 25。

三个判断：

- **`densityKey` 留在页面、以字符串传进去。** 它是「哪些设置会让页码作废」的缓存键，而页面本来就把那 8 个设置握在手里；让 hook 去拼这个键要传 8 个原始值，比传一个字符串更差。它的**语义**（换布局就作废统计）写在 hook 里。
- **`chapterMissing` 这个名字是刻意的，而且它带出一条发现。** 原来的守卫写的是 `chapterData === null`（不是 `== null`），而 `useChapter` 的 data 在首次请求落定之前是 **`undefined`** —— `undefined === null` 为 false，所以**首次加载期间那个守卫并不生效**。后果很轻（`observeUnit` 按章号覆盖，下一帧的真实测量会把它换掉，最坏是一次瞬时错误的估算），但它是真的。**这一笔不修**：收紧它等于改「哪些测量会被记录」，那是个需要证据的问题，不是搬家的顺带。测试写死在旧语义上，发现记在这里。
- **用别名让消费点一字不改**（`const { shown: shownPages, count: countChapterPages } = pageCounter`）：`countChapterPages` 进 `onScroll` 的依赖数组，必须是普通标识符；名字保住了，`onScroll` 与 JSX 的 diff 就是 0 行。

校验：prettier / oxlint 0 warning（259 文件）/ tsc / vitest 588 → **599 条** / `vite build` / playwright 170 条。新增 11 条单测。**变异验证抓到我自己的一个恒真断言**：`stays silent until the chapter body is on screen` 原本只断言 `shown` 为 `null`，而那条用例没给 `pageInfo` —— 所以 `shown` 本来就是 `null`，把守卫整个删掉它照样绿。改成「守卫在时读到单位自己的计数器 `1 / 4`、不在时读到估算 `3 / 24`」之后变异才被抓到。**恒真断言不只会漏，还会让人以为已经覆盖了。**

#### PR#6（2026-09-28）：`useAutoScroll` —— 同一把尺子的第二个候选，顺带补上一条零覆盖的行为

按 PR#5 的表，下一个候选是自动滚动（出口 2、入口 6）。量完发现它的形状和「实测页数」不一样：**`setAutoScrolling` 在簇外有三个调用点** —— `goTo` 的两个分支各一次（换章要停掉自动滚动），footer 一次。于是「flag 归谁」有了个选择：

| 方案 | 谁持有 flag                                       | `goTo` 的改动                       |
| ---- | ------------------------------------------------- | ----------------------------------- |
| A    | hook 持有，暴露 `on` / `toggle` / `stop`          | 两个调用点改名 + **依赖数组多一项** |
| B    | 页面持有，hook 只跑循环（收 `active` + `onStop`） | 零                                  |

**选了 A。** flag 有一个所有者（hook）、三个使用者（循环到尽头清它、footer 切它、导航跳章清它），而 `stop` 是个语义化的名字，比 `setAutoScrolling(false)` 清楚。B 会把「谁来停」摊回页面里，让 hook 变成一个要传 setter 进去的循环 —— 那不是更窄，只是更含糊。

代价落在 **`goTo` 的依赖数组多一项**（`stopAutoScroll`），也就是 PR#3 末尾警告的那块地方。所以 `stop` 是 `useCallback([])`，并且**有测试钉着它的身份**（`keeps both actions identity-stable across renders`）—— 变了就会重放 pending scroll、把页面拽回本章开头。

**顺手补上一条零覆盖的行为。** 自动滚动此前**没有任何测试**：没有单测，也没有一个 e2e spec 提到「自动滚动」。而它是五个 `requestAnimationFrame` 走法，每个走法都是对读者的一个承诺（流到头了、离开 scroll 布局了、视口没了、foliate 那本书读完了），这些承诺此前只靠人眼。新增 9 条：帧用可控队列手动驱动、时钟打桩，所以一步恰好是速度要求的像素数。其中两条值得留着：

- **亚像素余量**那条验的是「头两帧不调 `scrollByPx`、第三帧调一次 1 px」—— 那正是「慢速会一顿一顿」的修复点（1 px 一跳 = 每秒 27 次抖动，而不是滑行）。变异（去掉 `fold.delta !== 0` 的守卫）能打红它。
- **`layoutModeRef` 是 ref 而不是闭包值**这条也有测试：把布局切到 `single` 之后**不需要重渲染**，循环下一帧就自己停了，而且退出时没有把页面动一下。

**一处 effect 顺序变化，判断为惰性（比 PR#4 那次更硬）**：hook 必须声明在 `goTo` 之前（`goTo` 要用它的 `stop`），所以这个 effect 从 ~1405 行挪到了 ~841 行，现在排在位置 effect 之前。理由是**两者互斥**：位置 effect 重放 pending scroll 的场景都是换章，而换章走的 `goTo` 第一件事就是 `stopAutoScroll()` —— 那一帧 `on` 已经是 false，effect 直接早退，根本不会排队 rAF。所以「两个 rAF 谁先跑」在这套代码里没有可达的交点。

校验：prettier / oxlint 0 warning（261 文件）/ tsc / vitest 599 → **608 条** / `vite build` / playwright 170 条 → 168 passed / 2 failed，两条都在 `reading-ruler.spec.ts`（`:512`、`:606`，webkit），而那次全量跑了 13.1 分钟、load average 12.46；单独跑全 spec **16/16 全过**。`ReaderPage.tsx` 删 72 / 加 27。五次定向变异都恰好打红对应的那条：离开 scroll 布局不停 / 到页尾不停 / `stop` 不再身份稳定 / 丢掉亚像素余量 / 分页布局里也照跑。

#### 重新量一遍剩下的簇（2026-09-28，第 3 次抽取之后）

三次抽取（④ 朗读 / ⑤ 实测页数 / ⑥ 自动滚动）之后 `ReaderView` 是 2449 行，PR#5 那张缝表已经不可用 —— 行区间和耦合都变了。所以重新量，并把**量法本身**写清楚，因为这一轮它比结论更容易复用。

**量法**：把 `ReaderView` 的顶层语句切成 span（`const` / `let` / `if` / `useEffect` / `return`），对每个候选簇算两个数，再打印出口的**逐符号分解**：

- **入口** = 簇内读到、声明在簇外的名字（要变成参数的东西）。
- **出口** = 簇外引用簇内名字的次数（要穿回去的东西）。**只看总数会骗人** —— 漏水点往往是某一个符号。

四个踩过的坑，每一个都让数字先假了一次：

1. **多行解构的绑定名**：`const { on: autoScrollOn } = useAutoScroll({…})` 只读首行会得到空名字，而 `on` / `stop` / `zoom` 这些 key 会被当成外部入口。要读到配对的花括号，且 `key: alias` 只算 `alias`。
2. **`useState` 的 setter 与 state 同属一条语句**：把 `setLightboxPath` 算成外部入口是错的。判据要改成「这个名字的**声明语句**在不在簇内」。
3. **不要做「归属语句」吸收。** 我试过「簇外语句若引用簇内名字 ≥2 次就并入簇」，两轮迭代之后**每个簇都把 2166-2683 那块 JSX 吞了**（它引用一切），数字全变成 `in≈120 / out≈0`，排名完全失真。正确做法是不吸收，改看逐符号分解，人工判断哪些引用其实落在紧邻的 effect 里（`remeasureSelection` 的 6 处里有 4 处就在它自己的 effect 内）。
4. **属性名与变量名同形**：`{ chapterIdx: section ?? 0 }` 里的 `chapterIdx` 被算成了一次变量引用。

**结果**（`scripts/measure-reader-clusters.py` 的输出，出口按符号降序）：

| 簇           | 行数 | 入口  | 出口   | 出口的漏水点                                                                                                     |
| ------------ | ---- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 搜索/AI 跳转 | 40   | 7     | **2**  | `pickHit`×1 `jumpToCitation`×1                                                                                   |
| 图片/灯箱    | 85   | **1** | 15     | `bookImages`×3 `lightboxIdx`×3 `stepLightbox`×3 `lightboxPath`×2 `openImageAt`×2 `webImages`×1 `openBookImage`×1 |
| 头部视图     | 15   | 10    | 10     | `useFoliateToc`×3 `headerChapter`×3 `chapterTitle`×2                                                             |
| 阅读标尺     | 50   | 2     | 19     | `remeasureSelection`×6（4 处在自己的 effect 里）`rulerSettleRef`×5 `rulerDirRef`×5 `rulerRef`×2                  |
| PDF          | 63   | 9     | 24     | `pdfZoom`×8 `pdfSlotH`×5 `suppressPdfPending`×3 `pdfScrollPage`×2                                                |
| 标注桥接     | 72   | 4     | **33** | **`pending`×27** `deepLinkTarget`×4                                                                              |
| 翻页手势     | 134  | 16    | 22     | `flip`×14 `flipHint`×3                                                                                           |
| foliate 桥   | 169  | 22    | 35     | `foliateRef`×14 `readsLeftward`×5                                                                                |
| 位置与导航   | 291  | 28    | **78** | **`chapterIdx`×34** `goTo`×15 `stepChapter`×7 `fraction`×5                                                       |

**逐个判定**：

- **图片/灯箱 —— 下一笔。** 入口只有 **1** 个（`bookImagesQuery`），85 行里装的是一件内聚的事：**这本书有哪些图，以及看的是哪一张**。15 处出口落在四个消费点 —— 灯箱 JSX（`lightboxPath` / `stepLightbox` / `webImages`）、章节视图的图片点击与 `images=`、PDF 层的点击、foliate 的点击 —— **没有一处来自脊柱**，这是它和下面几组的本质差别。连那条「用路径而不是下标」的设计理由（`bookImages` 是 query，下标会指向移进来的东西）一起搬走。
- **搜索/AI 跳转 —— 第二笔，或与上一笔一起做。** 出口只有 **2**，是全表最干净的接口，但只有 40 行（`focusOffset` / `pickHit` / `jumpToCitation`），而且入口里带着 `pendingFocus`（脊柱的 ref，它要写）、`goTo`、`navigate` —— 它是**往脊柱里塞一个「待滚到的偏移」**，所以和位置那一簇天然咬合。收益约 30 行。
- **阅读标尺 —— 不做。** 入口 2 个很便宜，但出口是**横切**的：`rulerSettleRef` 在 `onScroll` 里、`rulerDirRef` 在 `flip` 与位置 effect 里。做成 hook 之后那 19 处要改成命名 API 调用，**行数不减**（省下的只有 12 行 ref 声明），而标尺恰好是这套测试里最 flake 的地方（`reading-ruler.spec.ts` 那一整条记录）。收益小、风险集中。
- **头部视图 —— 不做。** 15 行（几个三目）配 10 个入口，抽出来是一层间接而不是一次分离。
- **PDF —— 不做（暂时）。** 出口里 `pdfSlotH`×5 与 `suppressPdfPending`×3 **是被脊柱读写的**：`goTo` 直接设 `el.scrollTop = clamped * pdfSlotH.current`，`applyPending` 读 `suppressPdfPending`。PDF 的槽位记账和导航是共用的 —— 抽走它要让脊柱改成调 hook（像自动滚动那样）。
- **标注桥接 —— 不做。** 出口 33 里 27 处是 `pending`：它是**待确认的选区**，页面几乎每个浮层与回调都在读（PR#3 已经量过一次）。它不是叶子，是页面的中心 UI 状态。
- **翻页手势 —— 不做。** `flip`×14 是共享入口（箭头 / 键盘 / 滚轮 / 手柄都调它），入口里还带着 `goTo` / `stepChapter` / `rulerDirRef`。134 行看着诱人，但它是脊柱、标尺、两个渲染器的交汇处。
- **foliate 桥 —— 第三笔，已做（PR#9 取样式对象、PR#10 取位置/目录那一半）。** 169 行是单笔最大的一块，但入口 22 个（settings / 各查询 / 脊柱的 setter），出口里 `foliateRef`×14 漏进脊柱（`goTo` / `flip` / `applyPending` / 朗读都在用它 —— 它是共享句柄，不是这一簇的私有物）。**订正（PR#10）**：正因为它是共享句柄，**它和它的两个封装不该抽** —— 抽了只是换名字。真正该走的是位置/目录那一半，见 PR#10。
- **位置与导航 —— 确认不做**（`chapterIdx`×34，见 PR#5）。

**建议顺序**：图片/灯箱 → 搜索/AI 跳转 → foliate 桥 →（若还要继续）PDF。

#### PR#7（2026-09-28）：`useImageLightbox` —— 重量后的第一顺位，入口只有 1 个

重新量完排在第一（85 行、入口 1、出口 15）。它和前面几笔的差别不在数字，在**出口来自哪里**：15 处全部落在它自己的四个消费点 —— 键盘处理器（Esc 关、左右键翻图）、章节视图（`images=` 与 `onOpenImage`）、foliate 的图片点击、灯箱本身 —— **没有一处来自脊柱**。

搬走 `lightboxPath` / `webImages` / `bookImages` / `lightboxIdx` / `openImageAt` / `stepLightbox` / `openBookImage` 七样，`ReaderPage` 删 109 / 加 27。八个解构别名（`images: bookImages`、`urls`、`path: lightboxPath`、`index: lightboxIdx`、`openAt: openImageAt`、`openFromBook: openBookImage`、`step: stepLightbox`、`close: closeLightbox`）之后，**四个消费点里只有三处真的改了**：`urls={webImages.urls}` → `urls={urls}`、两处 `setLightboxPath(null)` → `closeLightbox()`、`onClose` 从箭头函数变成直接传。

一处依赖数组变化：键盘处理器多了 `closeLightbox`。原来那个 `setLightboxPath` 是 `useState` 的 setter，oxlint 认得出它稳定、不要求列进依赖；换成 hook 返回的回调就认不出来了。所以 `close` 是 `useCallback([])`，并有测试钉着它的身份。

**变异验证翻出一条：`step` 里的 `Math.min/Math.max` 夹取是冗余的。** 去掉它，「翻到头就停住」那条断言照样绿 —— 越界下标在 JS 数组上读出来是 `undefined`，而紧随其后的 `?? current` 已经回答了「就停在当前这张」。夹取保留（对读代码的人有意义），但**测试注释里写明了它没被钉住**，免得下一个人以为删掉它会红。这是这一批里第二次「变异验证抓到的东西和我想的不一样」（上一次是 PR#5 的恒真断言）。

校验：prettier / oxlint 0 warning（263 文件）/ tsc / vitest 608 → **621 条** / `vite build` / playwright **170/170 全过**（14.1 分钟，负载 5.08；这一笔动的正是 `image-lightbox.spec.ts` 覆盖的代码）。新增 13 条单测，其中一条专门钉那条设计理由：**图是「书自己的列表」还没到时点开的，等它到了之后画面停在「同一张图」而不是「同一个位置」**（路径不变、下标从 0 变 1）。五次定向变异被抓（重复点击去重 / 百分号转义兜底 / 越界退回第一张 / `close` 不再稳定 / 空书表不退回已注册表），第六次就是上面那条冗余。

### P2-15 Rust 侧已经越过文档自己定的拆分阈值

- **问题**：`ARCHITECTURE.md` 自己写了拆分触发条件：「单个模块超过约 800 行且存在两个以上互不相关的变更理由」。按这条尺子，`document/mobi.rs` 1809、`library/clippings.rs` 1597、`library/repository.rs` 1092、`library/sync.rs` 970、`library/export.rs` 876、`library/import.rs` 845、`library/annotations.rs` 721 都在线上或线附近。另外 `library/` 已经是 **23 个文件的平铺桶**，里面至少五类互不相关的领域：格式解析（`stardict` / `mdict` / `dictionaries`）、检索与 AI（`search` / `rag` / `graph`）、同步（`sync` / `backup`）、导出（`export` / `pack` / `clippings`）、书源（`source`）。
- **位置**：`src-tauri/src/library/`、`src-tauri/src/document/`
- **方向**：不急着拆 crate（文档里那三个信号还没到）。先把 `library/` 按领域分成子目录（`library/lookup/`、`library/ai/`、`library/io/`），`repository.rs` 按实体拆（books / chapters / tags），`mobi.rs` 把 PDB 容器、PalmDOC 解压、EXTH 元数据分成三个模块。纯移动 + `mod` 声明，不动逻辑，一次一笔。
- **收益**：`cargo check` 的增量编译受益；找代码不再靠猜在哪个文件。风险极低（移动不改逻辑，编译器全量把关）。
- **验证**：`cargo fmt --check` + `clippy --all-targets -D warnings` + `cargo test`。

### P2-16 `src/lib/local/backend.ts` 已经和整个 Rust 后端同量级

- **问题**：1225 行，一个文件装下浏览器端的全部替身（导入、列表、封面、标注、书签、统计、标签、检索、词典、字体、备份）。它现在比 `library/repository.rs` 还大。它是 web 构建的替身而不是产品，但「替身比真身难维护」是个坏信号。
- **位置**：`src/lib/local/backend.ts`
- **方向**：按 `LOCAL_COMMANDS` 已经在用的分组拆成 `local/books.ts` / `local/annotations.ts` / `local/stats.ts` / `local/search.ts`，`backend.ts` 只留 `fromLocal` 的转发表。`ipc.ts` 的 `LOCAL_COMMANDS` 清单同时是验收表。
- **收益**：浏览器端与 Rust 端的分组一一对应，加一个命令时两边找同一个位置。
- **验证**：`tsc` + `vitest`（`local/*.test.ts` 已有 5 个）+ web 构建的 e2e。

### P2-17 29 MB 字体子集随每个构建分发，而它是第 5 个可选字体

- **问题**：`dist` 33 MB 里 29 MB 是 582 个 `lxgw-wenkai*` woff2 子集。`main.tsx` 的注释是对的：**运行时不下载未命中的子集，所以运行时成本为零**。但这不等于零成本：GitHub Pages 的 web 构建、CI artifact、Tauri 打包产物、每个用户第一次安装都要走这 29 MB。而霞鹜文楷是 `FONT_STACKS` 的第 5 项、默认值是「系统」。
- **位置**：`package.json`（`lxgw-wenkai-webfont`）、`src/main.tsx`、`dist/assets/*.woff2`
- **方向**：三个选项，按代价排序：① 什么都不做，但在 README / 发布说明里写明体积构成（零改动，先把事实说清楚）；② web 构建剔除它（只有桌面端保留）；③ 桌面端也改成按需资源（与「读者导入字体」走同一条链）。我建议先做 ①，等真有下载体积的抱怨再做 ②。
- **收益**：把「33 MB 应用」这件事从意外变成已知。
- **验证**：`du -sh dist`；`dist/assets/*.woff2 | wc -l`。

### P2-18 没有 i18n，文案硬编码散在 200+ 文件里

- **问题**：全部界面文案是中文硬编码。`ARCHITECTURE.md` 把 `i18n（en）` 放在 P2「锦上添花」，但成本是随时间增长的：每加一个面板就多几十个字符串。现在抽骨架最便宜。
- **位置**：全局；文案密集处 `SettingsPage.tsx`（1271 行）、`ReaderPage.tsx`、`ShelfGrid` / `BookCard` 的空状态与错误文案
- **方向**：**不做完整的 i18n 框架**。只做两件事：① 把「用户可见的长句」（空状态、错误、确认对话框、设置项描述）收进一个 `src/lib/copy.ts`，键值结构先立住；② 短标签（按钮、面板名）留在组件里。这样将来加 en 时，改动量集中在两处而不是两百处。
- **收益**：以极小的当前成本，把一个未来的大改动降级成中改动。
- **验证**：无（结构性改动）。

### P2-19 文档漂移：`ARCHITECTURE.md` 的命令表与例外数已经过期　【已修复】

- **问题**：文档写「71 个命令里 69 个由 specta 生成，**2 个例外**」，但 `ipc.ts` 现在有 **3 个**手写二进制命令（`book_asset` / `book_source_file` / `webview_capture_region`，后者是仿真翻页那轮加的，`commands/webview.rs` 存在且注册在 `generate_handler!` 里）。文档的 `commands/` 域表列了 11 个域，实际有 **22 个**文件（`backup` / `bookmark` / `clippings` / `dictionary` / `font` / `lookup` / `notes` / `pack` / `stats` / `tag` / `tts` / `webview` 都没进表）。`library/` 表列了 12 项，实际 23 个模块。
- **位置**：`ARCHITECTURE.md` §2 模块表、§4 IPC 契约；`src-tauri/src/lib.rs` 里 `collect_commands!` 上方的注释
- **已修（2026-09-28）**，数字都是重新量的，不是照旧文推算：
  - 命令数 **76**（`generate_handler!` 76 条 = `collect_commands!` 73 条 + 3 条二进制手写）。旧文的「71 / 69 / 2」三处全改。
  - 例外从 2 条补成 3 条：`webview_capture_region`（仿真翻页那轮加的）也是二进制通道，`lib.rs` 的注释和 §4 的约定条目一起补上。
  - `commands/` 那一行**不再手列文件名**：目录本身就是清单（21 个域，旧文列了 11 个）。手写清单必然漂，改成让它自己说。
  - `library/` 那一行补上「现在是一个 23 个文件的平铺桶」并指向本节的 P2-15。
  - 顺带核了一件事：用脚本比对了两个清单，**没有「只进 `collect_commands!`、没进 `generate_handler!`」的命令**——那种命令能通过 `tsc`、只在运行时炸，是这类双清单最容易埋的雷。这条双向核对写进了 §4 的约定。
  - 本报告自己也抄了过期的「71 / 68」，一并改。
- **方向**：① 命令表改成「按域列目录」而不是手写清单，让 `ls commands/` 就是唯一事实来源；② 例外数改成 3 并在 `collect_commands!` 的注释里点名 `webview_capture_region`（那里的注释目前只提了 2 个）；③ 文档已经 600 行且混着现状与历史（比如「历史：最早从屏幕上一个单元直接外推，报过 493/977/805 页」），把历史决策挪到 `docs/decisions.md`，`ARCHITECTURE.md` 只留现状。
- **收益**：文档重新变成可以信的入口；新人照着表找代码不会扑空。
- **验证**：无。

---

## 五、已知功能缺口（文档已记录，不是本轮新发现）

列在这里是为了让这份清单完整，并且标明哪些值得重新排期：

| 缺口                                                                         | 现状                                                | 是否值得动                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| 纯扫描版 PDF                                                                 | 没有文字层，不能划词、不能问 AI。OCR 不在本期范围   | 值得重估：这是 PDF 用户最常撞到的一堵墙 |
| epub 旧标注（迁移前、无 CFI）                                                | 仍在列表里，但不再上色、点击不跳转                  | 文档说「等真有抱怨再做」，同意          |
| 切换渲染通路不换算坐标                                                       | epub 首次以 foliate 打开时没有 CFI 可续，从书首开始 | 一次性代价，可接受                      |
| 双页中缝叶片、鼠标拖拽翻页                                                   | 明确不做（拖拽是划词语义）                          | 同意                                    |
| 代码签名                                                                     | 管线已就绪，只差 Apple / Windows 证书               | 发布门槛，但只影响他人首次打开的摩擦    |
| 笔记导出到 Anki / Obsidian、图谱可视化深化、金句分享图、快捷键自定义、多窗口 | P2 列表                                             | 按需                                    |

---

## 六、建议的落地顺序

**第一批（半天，纯修复）**：P0-1 焦点环 → P0-2 图标 → P0-3 元信息对齐 → P0-4 占位作者 → P1-10 空状态出口 → P1-11 文案。
全是几行到几十行的改动，可以合成 2 到 3 笔提交，每笔跑 prettier / oxlint / tsc（按仓库约定用 `pnpm exec` 那三条）。

**第二批（一天，数据与性能）**：P0-5 批量命令 → P1-6 封面回填并发 → P1-7 时钟下推 → P1-13 统计口径。
这一批要动 Rust 签名（`cargo test --lib specta_bindings::export_bindings` 后记得 `prettier --write src/lib/bindings.ts`），并且要复跑 `shelf-manage.spec.ts`。

**第三批（需要一次真机验证）**：P1-8 下拉弹出层。先截图确认属于三种情况里的哪一种，再决定动不动。

**第四批（结构性，按笔推进）**：P2-14 拆 `ReaderPage`（每笔一个 hook，每笔全量 e2e）→ P2-15 Rust 目录分层（纯移动）→ P2-16 拆 `local/backend.ts` → P2-19 文档。

---

## 附：本轮没有做的事

- 没有跑测试套件（`vitest` / `playwright` / `cargo test`），所以本文的结论全部来自**读代码 + 静态统计 + 截图取样**，不是来自测试结果。要动某一项之前，建议先按仓库既有校验链跑一遍基线。
- 没有在真机 WKWebView 里验证任何视觉结论。P1-8 明确标了待实测。
- 没有评估 AI / RAG / 图谱 / 书源 / 同步这几条链的**行为正确性**（它们有 421 个 Rust 单测兜着），本文只覆盖了结构与前端体验。
