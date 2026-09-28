# ColorReader 代码与体验审查 · 改进建议清单

日期：2026-09-28　范围：全仓（前端 / Rust / 构建 / 文档）
方法：读源码 + 实测统计 + 对两张截图做像素级取样核对。**技术栈与架构不动，不推倒重写。**

> 本文所有结论都标了文件与行号，或标了实测数字。凡是我没能验证的（例如真机 WKWebView 上原生下拉弹出层的实际配色），我标成「待实测」而不是当成结论。

## 进展

**第一批已提交并推送**（`58d8535` + `f9d519d`，本文档本身是第二笔）：P0-1（4 处焦点环）、P0-2（含 `NotesPage` 上同一处图标）、P0-3、P0-4、P1-10、P1-11 —— 9 个文件 +145/−12。校验链全绿（prettier / oxlint 0 error / tsc / vitest 548 条 / playwright 170 条）。

**第二批已落地**（2026-09-28，改动留在工作区，未提交）：P0-5、P1-6、P1-7、P1-13 —— 11 个文件。Rust 侧新增 `book_delete_many` / `book_set_favorite_many` 两条命令（含 `bindings.ts` 重新生成），前端批量条改走它们；`usePdfCovers` 改成串行 + 单次失效；时钟从 `LibraryPage` 下推到 `ShelfHeader`；`LibraryStats.reading` 的口径收紧。

校验链全绿：`cargo fmt --check` / `clippy --all-targets -D warnings` / `cargo test`（418 条）/ prettier / `oxlint .`（0 warning）/ `tsc` / vitest 548 条 / playwright 170 条。新增的统计断言验过在旧口径上会红（`reading: 2` vs `1`）。

### 实施中发现的两条 flake（与本次改动无关，但值得记）

- `cargo test` 里 `dictionary::tests::the_system_dictionary_answers_a_real_word`（macOS 系统词典 FFI）**在并行负载下会偶发失败**：同一次全量里它失败，单独跑 3/3 过，HEAD 全量也过，重跑全量又 418/0。它只在 macOS 上编译，CI 跑 ubuntu 不受影响，**但本地全量跑会出现假红**。
- `e2e/selection-toolbar.spec.ts:101` 在 10 分钟的全量里 `page.goto` 超时一次，单独跑双引擎 6/6 过。

两条都建议单独处理（`#[ignore]` 或加重试），不要把它们当成「改动引入的回归」。

**待做**：第三批只剩 P1-8（真机验证原生下拉配色）；第四批是结构性的（P2-14 起）。

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
