# readest 翻页动画原理剖析 + 项目借鉴评估

> 参考仓库：`github.com/readest/readest`（本文基于 2026-09 的 main 分支快照，本地克隆在 `/tmp/readest`）。
> 本文只做原理提炼与方案评估，**不复制其代码**（项目纪律：参考 readest / ColorTxt，禁复制实现）。

---

## 一、readest 翻页动画的三层结构

readest 的翻页不是"一个动画"，而是一套按平台能力分派的三层管线。先看清分层，才知道"效果完全相同"到底要复制什么。

| 层           | 职责                                                       | 关键文件                                                                                                                         |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **手势识别** | 判定「这一下触摸是不是翻页」，并给出 `progress` / 释放速度 | `paginator.js`（fork 内建 arena）、`app/reader/utils/turnGestureArena.ts`、`useTouchInterceptor.ts`、`useCapturedTurn.ts`        |
| **编排**     | 捕获 → 挂载覆盖层 → 底层瞬时翻页 → 播放/跟手 → 拆除        | `app/reader/utils/capturedTurn.ts`（`CapturedPageTurn` 类，1300 行）、`paginator.js#viewTransitionTurn`                          |
| **渲染**     | 真正画出"纸"的运动                                         | `utils/pageCurl.ts`（WebGL 网格卷曲）、`utils/pageSlide.ts`（2D canvas 平移）、`utils/pagePush.ts`、`paginator.js` 注入的 VT CSS |

### 1.1 三种翻页风格

`ViewSettings.pageTurnStyle: 'push' | 'slide' | 'curl'`：

- **Push** — 不设 `turn-style`，走 paginator 原生的列带平移（`cssAnimateScroll` / `rafAnimateScroll`）。等价于我们的「左右平移」。
- **Slide（≈覆盖）** — 旧页快照平移出场 / 入场，带边缘阴影，Apple Books 手感。
- **Curl（≈仿真）** — 真正的卷曲。

### 1.2 分派规则（关键）

`getCapturedTurnStyle(viewSettings, isFixedLayout)`（`useCapturedTurn.ts:61`）：

```
非 Tauri            → null（交给浏览器 View Transition）
无 animated / 滚动排版 / eInk → null（瞬时）
curl                → 'curl'（Tauri 上永远走"捕获"通路）
push                → 固定排版（PDF/CBZ）才走 'push'，否则 null（用 paginator 原生 push）
slide               → 移动端 Tauri，或引擎无 View Transition 组支持 → 'slide'
其余                → null（用浏览器 VT）
```

**结论**：readest 桌面版（Tauri）的「仿真」= **原生截图 + WebGL 网格卷曲**；它的 VT `curl` 只在 Web（Chromium 140+）上用。
所以"仿真的最终形态"要分两条路看，下面分述。

---

## 二、手势识别（Gesture Arena）

### 2.1 浏览器 VT 通路（paginator 内建）

在 `paginator.js` 里，`#layeredDragStart` 用一组常量做"竞技场"判定：

| 常量                               | 值     | 含义                                         |
| ---------------------------------- | ------ | -------------------------------------------- |
| `LAYERED_EDGE_REGION`              | `0.18` | 左右各 18% 为边缘区                          |
| `LAYERED_EARLY_CLAIM_PX`           | `6`    | 中心区快速认领距离                           |
| `LAYERED_EARLY_SAMPLE_INTERVAL_MS` | `80`   | 两次同向样本的最大间隔                       |
| `LAYERED_VERTICAL_REJECT_PX`       | `8`    | 纵向超过 8px 且大于横向 → 判为纵向，永久放弃 |
| `LAYERED_FALLBACK_CLAIM_PX`        | `24`   | 模糊轨迹的兜底距离                           |
| `LAYERED_FALLBACK_DOMINANCE`       | `1.5`  | 方向优势比                                   |

三条认领路径（满足其一即接管这次触摸）：

1. `edgeClaim` — 起点在边缘区 + 首个明确向内样本 + 明确横向；
2. `earlyCenterClaim` — 中心区 + 2 个连贯同向样本 + ≥6px；
3. `fallbackClaim` — ≥24px 且 `|dx| ≥ 1.5|dy|`。

**设计要点**：一旦认领，即使这一翻因书的首/尾边界无法真正翻页，也**咬住这次触摸**（`layered-turn-gesture-claimed` 事件），避免松手时浏览器补发合成 click 打到工具栏。

### 2.2 Tauri 捕获通路（`turnGestureArena.ts`）

同一套常量在 JS 侧复刻一遍（`TURN_EDGE_ZONE_RATIO`、`TURN_FAST_CLAIM_DISTANCE_PX` 等），因为捕获通路要抢在 paginator 的 `no-swipe` 之前自己接管。多出来的两条规则：

- `earlyClaimBlocked`：起点落在左侧保留区（亮度手势条 / `TURN_GESTURE_LEFT_INSET`）内 → 禁止快速认领，必须走 24px 兜底。
- 让位条件：有活动选区、有对话框遮挡、`renderer.scrollLocked`（长按划词锁）、程序化翻页在飞、或 layered turn 已接管 → `gestureClaimed` 闭锁，整次触摸永不变翻页。

### 2.3 跟手与释放

- **跟手**：`progress = 距离 / 页宽`（slide/push 扣掉认领时已消耗的距离，避免首帧跳变）；`grabY = 0.5 + deltaY / 高度`，钳制在 `[0.05, 0.95]` —— 这就是"捏住书页哪个高度"的捏点。
- **释放判定**：
  - slide / push：把最近 90ms 的速度向前投影 240ms，`projectedProgress = progress + v·240/页宽`，> 0.5 提交。距离和速度连续贡献，不是两个硬阈值。
  - curl：整手势速度 > 0.3 px/ms 即提交，否则看 progress > 0.5。
- **回弹**：`endDrag(false)` 先把覆盖层动画回 progress 0（旧页平铺盖住），**再**把底层视图翻回去 —— 任何时刻都不会闪错页。

---

## 三、渲染方式

### 3.1 覆盖（Slide）

**VT 通路**：`document.startViewTransition` 快照旧页，`::view-transition-old(foliate-turn)` 上跑 300ms `translateX(∓100%)`，带 `box-shadow: 0 0 24px rgba(0,0,0,.35)`，`z-index: 1` 压在静止的新页之上。前进 = 旧页滑出；后退 = 新页滑入。方向/书口由 `foliate-vt-forward/backward`、`foliate-vt-left/right` 类组合。

**捕获通路**（`pageSlide.ts`）：2D canvas 画位图，外面包一层 `sheet` div 只做 `translate3d`，边缘用 28px 静态渐变代替整画布模糊（省掉一圈巨大的阴影栅格）。

一个容易被忽略的细节：两层都**必须遮蔽而不是混合**。UA 默认给 old/new 配 `mix-blend-mode: plus-lighter` 做交叉淡入，会让静止那页"闹鬼"。readest 显式 `mix-blend-mode: normal` + 用 `--theme-bg-color` 给两层垫底色。

### 3.2 仿真（Curl）

#### (a) WebGL 网格卷曲 —— readest 的真身（`utils/pageCurl.ts`）

64×64 顶点网格铺满整页位图，顶点着色器把每个顶点绕一根圆柱包起来：

```
s = dot(p - uFold, uDir)              // 到折痕的有向距离
if (s < π·r)  包裹段： p -= uDir·(s - r·sin(s/r))，z = r(1-cos(s/r))
else          已翻过半： p -= uDir·(2s - π·r)      // 关于折痕精确镜像
gl_Position.z = -lift·0.5              // 抬起的部分画在上层
```

- 片元着色器用 `gl_FrontFacing` 分正反：正面是纸，背面是「主题纸」（`mix(内容, paper, 0.72)`）+ 卷起处 `sin(s/r)` 阴影。
- `travel = 页宽 + π·endRadius`，保证 progress=1 时整页完全翻过；`radius = max(24, 0.16·页宽·(1-0.4·progress))`，越翻越紧。
- `tilt = (grabY - 0.5)·1.8·(1 - progress)`：捏角起手时是斜折，随进度拉正 —— 这就是"捏住书角翻页"的手感来源。
- 双页排版时只有外侧一页是"叶片"，铰接在中缝（`uLeaf` 限制可变形区间），落到内侧页上成为精确镜像。

#### (b) VT curl —— Web 降级

`paginator.js` 注入的 CSS：以**书脊**为 `transform-origin: left center`，`perspective(1600px) rotateY(-96deg)`，`backface-visibility: hidden` 在 90° 时退休（快照没有背面，否则会闪出镜像文字）。420ms `cubic-bezier(.25,.46,.45,.94)`。

⚠️ 这条是**卡片翻转近似**，不是网格卷曲：没有圆柱包裹、没有背面纸张、没有捏角倾斜。readest 自己的注释也承认 flat snapshot 无法 mesh-bend。

### 3.3 捕获管线的 orchestration（为什么它这么长）

`CapturedPageTurn` 之所以 1300 行，是因为它要解决"位图不是活页"带来的一串问题：

1. **预烤表面**：空闲时就把当前页截好、解码、上传纹理、以 `opacity: 0.004` 挂在真实容器里过一帧合成 —— 手势开始时不付这份延迟。全进程只允许 1 块全屏表面（高 DPI 下几十 MB），用 `preparedSurfaceOwner` / `activeSurfaceOwners` 记账。
2. **捕获期可能跨越布局变化**：旋转、网格替换、对话框弹出 → 每次 await 后重新比对 rect / dpr / epoch，不匹配就重截或放弃。
3. **模态遮挡门禁**：`isCaptureAllowed()` 在挂载前、导航前各查一次，防止把对话框的像素烤进纸背。
4. **取消要还原**：`onCancelled` 把工具栏/滚动锁恢复，且恢复发生在覆盖层还平铺着的时候。
5. **释放加速**：按释放速度提高 playbackRate（slide/push 上限 2×、curl 1.5×），并把 easing 从 `easeInOutQuad` 按 ≤1/3 的比例混向 `easeOutCubic` —— 避免最大甩动时起步速度是均速的 3 倍。

---

## 四、我在 ColorReader 落地了什么

| 文件                                      | 改动                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/features/reader/theme.ts`            | `PageTransition` 增加 `"slide"`；选项列表加「覆盖」，`paper` 标签收成「仿真」                                             |
| `src/features/reader/FoliateBookView.tsx` | `slide → turn-style="slide"`；补全顶部注释，写明 `pan` = readest 的 Push、`slide/fade/paper` = 分层 VT                    |
| `src/features/reader/paging.ts`           | 纯文本 / MD 通路新增 `slide`：`translateX(±100%) → none`，300ms，曲线沿用 VT keyframes 的 `cubic-bezier(.25,.46,.45,.94)` |
| `src/features/reader/paging.test.ts`      | 新增一条：前进从右进、后退从左进                                                                                          |
| `src/features/reader/pdfTurn.ts`          | **paged PDF 通路**：`goTo` 之前把当前 canvas 拷成 overlay，动画出场后移除。见下文                                         |

门禁：`tsc --noEmit` 0 · `oxlint` 0/0 · `vitest` 398 passed · `vite build` OK · `prettier --check` OK。

### 关键发现：我们 vendor 的就是 readest 的 foliate fork

`src/vendor/foliate-js/paginator.js` 里已经**完整带上了 readest#555 的分层翻页**：

- `#layeredTurn` 支持 `slide | curl | fade | peel-br | peel-tr`；
- 注入的 CSS 含 slide / fade / curl / peel 全套 keyframes（含"必须遮蔽不混合"、"垫 `--theme-bg-color`"两条修正）；
- 内建手势 arena（边缘 18% / 6px 快认领 / 8px 纵锁 / 24px 兜底）；
- 支持 `data-view-transition-root`（我们的 host div 已经标了）；
- 支持跟手 scrub（`foliate-vt-scrub` + `KeyframeEffect.updateTiming`）。

也就是说：**在 foliate 通路（EPUB / MOBI / AZW3）上，「覆盖」和「仿真」与我们 vendor 的 readest 代码是同一份实现**，不是仿写。之前只是 `slide` 没接出来。

`--theme-bg-color` 也已由 `foliateStyle.ts` 发布，VT 的垫底色是对的。

---

## 五、与 readest 的真实差距（诚实版）

| 项                           | readest                                                | ColorReader                      | 差距性质                     |
| ---------------------------- | ------------------------------------------------------ | -------------------------------- | ---------------------------- |
| 覆盖（Slide）· foliate 通路  | VT slide / 移动 Tauri 走捕获                           | **VT slide（同一份 fork 代码）** | 🟢 一致                      |
| 覆盖 · 纯文本 / MD 通路      | 同左                                                   | 新页滑入近似（无法快照旧页）     | 🟡 观感近似，机制不同        |
| 仿真（Curl）· foliate 通路   | **Tauri：原生截图 + WebGL 网格卷曲**；Web：VT 书脊翻转 | VT 书脊翻转                      | 🔴 **桌面端观感不同**        |
| 手指跟手 scrub               | 有（VT 与捕获两条都有）                                | 有（paginator 内建）             | 🟢 一致                      |
| 释放速度投影 / 回弹不闪错页  | 有                                                     | 有（paginator 内建）             | 🟢 一致                      |
| 双页中缝铰接（readest#6106） | 有（叶片模型）                                         | VT curl 不在中缝                 | 🟡 双页时差异更明显          |
| 预烤表面 / GPU 预算          | 有（1300 行编排）                                      | 不需要（VT 由引擎快照）          | 🟢 VT 通路天然免了这笔复杂度 |

**要真正做到桌面端"仿真"完全一致，缺的是一件事：webview 区域截图。**

需要补一块：`capture_webview_region(rect) -> PNG/JPEG bytes`

- macOS：objc 找到 WKWebView → `takeSnapshotWithConfiguration:`（依赖 `objc2` / `objc2-web-kit`）；
- Windows：WebView2 `CapturePreviewAsync`（依赖 `windows` crate）；
- Linux：WebKitGTK `webkit_web_view_get_snapshot`（依赖 `webkit2gtk`，或整体放弃走 VT）。

再叠一个 `PageCurlRenderer`（WebGL，约 400 行）+ 一份精简编排（约 300 行，可以砍掉 readest 的预烤表面 / 多 cell 预算 / 双页叶片 / iOS cover 等我们不需要的部分）。

**代价**：新增 3 个平台相关 Rust 依赖 + 无法在本机 GUI 上验证的原生代码（WKWebView 需要遍历视图层级去捞），写错就是翻页时白屏或崩溃。
**收益**：仿真从"书脊翻转"升级为"真卷曲（圆柱包裹 + 背面主题纸 + 捏角倾斜）"。

> 我没有在本轮直接写这块原生代码 —— 它不是能靠 typecheck/lint 验证的改动，而项目门禁要求 `cargo clippy -D warnings` 全绿。要不要上，请你拍板；上面的剖析已经把它拆到可以直接开工的粒度。

### PDF 通路：同一个形状，但快照是免费的

paged PDF 不走 foliate —— 它是我们自己的 `PdfPageView`（pdf.js 的一张 canvas），所以 VT 那套对它完全不适用。但它恰好把 readest 最贵的一步变成了零成本：

| readest 捕获通路                                  | 我们                                 |
| ------------------------------------------------- | ------------------------------------ |
| 原生 webview 截图（macOS / Android / iOS 各一份） | `drawImage(src)` —— 页面本来就是像素 |
| 预烤表面、GPU 预算、每次 await 后复核 rect/dpr    | 不需要：同步，中间没有 await         |
| 模态遮挡门禁、捕获期布局变化                      | 不需要：拷的是自己的 canvas          |
| WebGL 网格卷曲 / 2D canvas 平移                   | WAAPI 变换一张 overlay canvas        |

`src/features/reader/pdfTurn.ts` 就是这份差价，约 130 行。它只做**出场**动画：paged PDF 的 canvas 跨页存活（挂 `key` 会闪白，见 `pdf.md`），所以任何入场动画都会淡入上一页的位图 —— 这也是之前「paged PDF 没有翻页动画」这条注释的由来。

顺带绕开了 WebKit 的门：readest 的分层 VT 在 WebKit 上被 `CSS.supports('view-transition-group', 'nearest')` 挡掉（iOS 18 有 API，但分层快照会崩 WebContent 进程），而这套方案不依赖 VT，桌面端 WKWebView 上一样跑。

没做的：手指跟手 scrub、双页中缝铰接的叶片模型、WebGL 真卷曲。前两个是观感细节，第三个要上面那块原生截图。

---

## 六、readest 全项目可借鉴评估

### P0 · 直接复用思路 / 已有基础，性价比最高

| #   | 能力                          | readest 的做法                                                   | 我们的现状                  | 建议                                                                                  |
| --- | ----------------------------- | ---------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| 1   | **翻页动画分层 VT**           | 见上文                                                           | 已 vendor 同一份 fork       | 🟢 接出 `slide` 已完成；考虑把 `peel-br/peel-tr`（对角捏角翻页）也接出来当第 5 种风格 |
| 2   | **阅读标尺 ReadingRuler**     | 半透明横条跟随视线下移，压暗其余部分，减少跳行                   | 无                          | 🟢 纯 DOM + 一个 Y 位置，约 100 行。CJK 长段落收益明显                                |
| 3   | **库内全文检索 worker**       | `librarySearchIndex.ts` + `librarySearchWorker.ts`，建索引后台跑 | 只有书内检索（`search.rs`） | 🟡 中等工作量；对"几千本找一句话"是刚需                                               |
| 4   | **下拉书签 BookmarkPullDown** | 顶部下拉一段距离松手即书签，带橡皮筋                             | 只有按钮书签                | 🟢 小改动，移动端/触屏手感提升直接                                                    |

### P1 · 值得做，但要控制范围

| #   | 能力                               | 说明                                                                                                                                 |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **中位页时长统计**                 | `useMedianPageDurationSecs`：用中位数而非均值估"还剩多久读完"，抗离群（发呆、切走）。我们的 `StatsPage` 已有骨架，换成中位数口径即可 |
| 6   | **硬件翻页器 / 手柄 / 音量键映射** | `PageTurnerSettings` + `useGamepad` + 原生按键拦截。桌面端可只做键盘/手柄，跳过移动端的原生音量键拦截                                |
| 7   | **RSVP 速读**                      | 逐词闪读（一分钟 300+ 词）。已有 `rsvp/` 组件。我们 TTS 与划词已成熟，RSVP 是自然的第三个入口                                        |
| 8   | **竖排 CJK（vertical-rl）**        | readest 的 paginator 为竖排专门做了两阶段翻页。我们 `max-column-count` 只处理横排；中文古籍 / 日漫需要                               |
| 9   | **词典 gloss / WordLens**          | 划词即译 + 生词难度标注。我们有 `dictionary.rs` / `lookup.rs`，但**用户已明确不做生词本**，所以只做"即译"不做"积累"                  |

### P2 · 锦上添花 / 与我们定位不符

| #   | 能力                                      | 判断                                                                 |
| --- | ----------------------------------------- | -------------------------------------------------------------------- |
| 10  | 云同步 CRDT replica / 多端冲突解决        | 我们已明确**不做自建云同步**（只同步进度/标注/书签，WebDAV）。不跟进 |
| 11  | OPDS / Hardcover / Readwise / Notion 集成 | 生态型功能，取决于是否要做"联网"。目前 Local First 定位下优先级低    |
| 12  | 有声书 + 媒体会话                         | 我们有 TTS，但没有 audiobook 容器与系统媒体控件                      |
| 13  | E-Ink 模式 + 深度刷新                     | 桌面端无 e-ink 面板，跳过                                            |
| 14  | 校对 / Proofread、AI 翻译对照             | 我们已有 AI 问答与划词工具，可并入现有面板而非单独开模块             |

### 架构层面的三条真经

1. **能力探测先行**（`detectViewTransitionGroup`）：VT 有"能调 API"和"能跑分层快照"两档，readest 用 `CSS.supports('view-transition-group','nearest')` 区分，因为 iOS 18 WebKit 会对分层快照崩 WebContent。
   → 我们的 paginator 只查 `startViewTransition`。**macOS WKWebView 上若出现翻页崩溃，这是第一个要加的门**。
2. **平台能力分派集中在一处**（`getCapturedTurnStyle` + `applyPageTurnAttributes`）：一个函数回答"这次翻页该走哪条路"，属性设置也只从这里出。我们对应的是 `FoliateBookView.applyLayout` —— 保持它单一出口。
3. **编排层与平台层解耦**（`CapturedTurnHost` 接口）：`CapturedPageTurn` 只管 DOM + 渲染，截图 / 导航 / 几何 全靠 host 回调注入，因此能在纯浏览器里跑单测（`captured-turn.browser.test.ts`）。这个"host 接口 + 浏览器可测"的切法值得照搬到任何新的平台相关交互上。

---

## 七、建议的下一步顺序

1. 先在真机上把「覆盖」和「仿真」过一遍（EPUB + MOBI 各一本），确认分层 VT 在你本机 WKWebView 上不崩、不闪。
2. 若崩 / 若想更稳：加 `CSS.supports('view-transition-group','nearest')` 门禁，不支持时降级到「左右平移」（即 readest 的 Push 策略）。
3. 拍板是否上 **原生截图 + WebGL 仿真** —— 上则从第 5 节的 `capture_webview_region` 开工。
4. 之后按 P0 表做 阅读标尺 → 库内检索 → 下拉书签。
