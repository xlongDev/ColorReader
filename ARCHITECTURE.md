# ColorReader 架构

本文档记录**当前已落地**的架构，以及后续阶段的演进方向。只写已经存在的东西，未来计划单独标注。

---

## 1. 分层

```text
┌─────────────────────────────────────────────────────────┐
│  React 19 渲染层                                          │
│  UI / 交互 / Viewport / Selection / Animation             │
│  Zustand（UI 状态）  +  TanStack Query（IPC 数据）          │
└───────────────────────┬─────────────────────────────────┘
                        │  Tauri IPC（类型化、单一出口）
┌───────────────────────┴─────────────────────────────────┐
│  Rust                                                     │
│  文本加载 / 解析 / 索引 / 搜索 / 文件 IO / AI 编排           │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────┴─────────────────────────────────┐
│  SQLite（WAL）· FTS5 · sqlite-vec                         │
└─────────────────────────────────────────────────────────┘
```

边界规则（硬性）：

- **React 不直接访问本地文件系统。** 所有文件读写、目录扫描、导入导出都通过 Rust 命令。
- **整本书不进 React State，也不进 DOM。** 读取器只持有当前 viewport 与前后 buffer。
- **React 不执行大文件解析或模型推理。** 这些必须在 Rust 侧以异步任务运行。

---

## 2. Rust 侧

### 当前结构

单 crate（`src-tauri`），按职责分模块：

| 模块          | 职责                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands/`   | Tauri 命令，按域分文件（`system.rs` / `book.rs` / `reader.rs` / `annotation.rs` / `search.rs` / `export.rs` / `ai.rs` / `rag.rs` / `graph.rs` / `source.rs` / `sync.rs`），在 `lib.rs` 统一注册                                                                                                  |
| `db/`         | SQLite 连接（WAL、单写者 `Arc<Mutex<Connection>>`）+ `user_version` 迁移运行器                                                                                                                                                                                                                   |
| `ai/`         | AI 配置仓储（`settings` KV 表）+ OpenAI 兼容流式聊天客户端（SSE 解析为纯函数）+ embedding 客户端（批量、归一化、f32 序列化）+ rerank 客户端（Cohere 兼容）                                                                                                                                       |
| `library/`    | 导入管线（去重、文件落盘、元数据提取）+ 书籍仓储（查询 / 统计）+ 章节仓储 + 标注仓储 + 全文检索 + 书档（导入 / 导出 / 加密）+ 笔记导出（Markdown / CSV）+ RAG（组块 / 索引 / 暴力检索）+ 知识图谱（LLM 抽取 / 存储 / 邻域查询）+ 书源（JSON 规则 / 搜索 / 下载）+ WebDAV 同步（进度 / LWW 合并） |
| `document/`   | 七种格式的元数据、封面与章节正文提取：`epub`（OPF / spine）、`pdf`（逐页文本）、`mobi`（PDB 容器 + PalmDOC / HUFF-CDIC + EXTH）、`fb2`（XML，含 `.fb2.zip`）、`cbz`（图片页）、`plain`（TXT / Markdown），`html.rs` 为前三者共用的 HTML → 段落解析器                                             |
| `resource.rs` | `colorreader://` 自定义协议：封面图片按 id 从 Rust 流式返回                                                                                                                                                                                                                                      |
| `error.rs`    | `AppError`：thiserror 定义，实现 `Serialize`，统一转成 `{ message }` 交给前端                                                                                                                                                                                                                    |
| `state.rs`    | `AppState`（启动时间、数据目录布局、书库句柄），通过 `app.manage` 注入                                                                                                                                                                                                                           |

### 数据层

SQLite（rusqlite，bundled，WAL）。Schema 通过 `user_version` pragma 做版本化迁移：每个迁移在一个事务里同时执行 DDL 与版本号更新，崩溃只停留在上一个版本；迁移**只增不改**。书库身份键是 `content_hash`（源文件 SHA-256），同时是导入去重键；`sort_title` 在 Rust 侧预计算，避免向 SQLite 注入 collation。

```text
books ─┬─ book_authors ── authors      作者多对多，按 position 保序
       └─ book_tags   ── tags         标签多对多
       └─ chapters                   章节正文（book_id + idx 复合主键，级联删除）
       └─ annotations                标注（book_id 级联删除，chapter_idx + start_char 索引）
       └─ entities / entity_relations 知识图谱（migration v7，book_id 级联删除）

chapters_fts（FTS5 外部内容表，内容指向 chapters，由触发器维护）

settings（KV：AI / 同步凭据 / 词典与字体列表，migration v5）· chunks（RAG 向量，v6）
sources（书源规则，v8）· bookmarks（v9）· reading_sessions（阅读时长，v13）
annotation_tombstones / bookmark_tombstones（删除墓碑，供 WebDAV 同步，v15）
```

`chapters` 存的是**已提取的纯文本章节**，不是原始文件字节。主键 `(book_id, idx)` 保证一本书内章节顺序唯一；`chars` 是正文去空白后的字符数，用于进度定位。

### 阅读引擎与进度模型

章节正文在**导入时一次性提取并落库**，阅读阶段不再解析源文件。EPUB 按 OPF spine 顺序逐个 `itemref` 提取，`<head>/<style>/<script>/<svg>/<math>` 丢弃，块级边界切段落、首个标题当章节名；MOBI 是单篇 HTML，走同一个 `html.rs` 解析器按标题切章（超长章按段落边界再切，避免整本一章）；FB2 按 `<body>` 里的 `<section>` 分章；CBZ 每页图片一章；PDF 每页一章；TXT/Markdown 按标题标记（ATX `#` / `第N章` / `Chapter N`）切分，无标记则整本单章。

内嵌图片统一记成带内标记段落（`\u{FFFC}` + 容器内的可寻址名字），阅读时按需经 `book.asset` 取字节：EPUB / CBZ 按 ZIP 条目名，FB2 按 `#<binary id>`（base64 内联），其余格式没有内嵌资源。

**PDF 是唯一的固定版式例外**：阅读器不走文字段落，而是用 pdf.js（懒加载独立 chunk）把每页原样画到 canvas，`book.source_file` 返回整份文件字节。提取的逐页文本仍落库，供全文检索、朗读与 AI 使用，但不负责显示。PDF 排版不走 prose 的 multicol 分栏（页盒画布进分栏必溢出一栏，读起来就是整页空白），由独立的固定高度容器承载。目录面板由 pdf.js `getOutline()` 解析（named dest、`/A` action、UTF-16 标题均已处理，映射到 0-based 页码）；没有书签的 PDF 回退到逐页列表。封面同理由前端渲染第 1 页成 PNG，经 `book.cover_save` 落盘（书库挂载时对缺封面的 PDF 自动补一次）。pdf.js 在画布之上渲染**文本层**，选区解析、划词高亮与问 AI 全走文本层：`pdfTextSelection.ts` 的 `resolveLayerSelection` / `paintPageHighlights` / `askAboutSelection` 负责选区→字符区间、`ReaderPage` 把 `onSelection` / `onAnnotationClick` / `annotations` 接给 `PdfPageView`，`createHighlight` 以 `chapterIdx = page - 1` 落库——**文字版 PDF 的标注与划词问 AI 已与 epub / 纯文本同权**（画布本身不可划选，但文本层可，二者不矛盾）。唯一的真缺口是**纯扫描件**：没有文字层，文本层为空，既不能划选也不能问 AI，OCR 不在本期范围。

阅读器**一次只加载一章**，整本书既不进 React State 也不进 DOM。全局进度 `0..1` 通过 `chars` 前缀和映射到章节与章内比例（`locateChapter` / `globalProgress`），定位时不需要加载任何正文。Phase 3 之前导入的书没有 `chapters` 行，`reader_toc` 在首次读取时用 `ensure_chapters`（`with_tx` 内二次检查，防并发重复插入）惰性补建索引。

页码指示器有三种范围（隐藏 / 当前章 / 全书），「当前章」永远是排版**实测**的页数，全书页数则按格式走两条不同的通路，因为两种渲染器能测到的东西本就不同。**foliate 的书（EPUB / MOBI）用 foliate 自己给的位置编号**：`SectionProgress` 把书的字节切成固定刻度（1500 字节一格），relocate 带出 `location = { current, next, total }`，`bookPageFromLocation` 只需去掉 0-based 并夹住上界（`current + 1`，封顶 `total`）。这一串数字是**书的属性**——总量只由书的字节数决定，位置只增不减，既不随翻页变也不随字号变，因此**不带「约」**；readest 展示的也正是这个计数器（只有书自带 paper page-list 时才换用真页码）。**「当前章」那一档数的是列，也就是实际页数**：relocate 另外带出节内计数 `page = { current, total }`，而 foliate 给的 `fraction` 是**列**偏移、`size` 是一次翻页覆盖的比例，所以 `total = columnCount / size` 正好等于这一节的列数，`current = round(fraction / size) × columnCount + 1` 是当前这屏的第一列 —— 单页排版列数 1、一次翻一列，双页排版一屏两列、**一次翻页走过两页，页码也跟着走两格**（翻页单位与 readest 相同：都是一屏；差别只在这张计数器换算成了实际页数，而不是让一屏算一页）。**纯文本 / Markdown 没有这种刻度**，只能靠测：`bookPagesOf` 把「已读过的章」按实测页数计入，未读的章按已测章得出的「每页多少字」估一个页数（下限一页），所以总量随阅读**收敛**而不是随光标摆动，这也是唯一带「约」的一路。**章即页的格式**（PDF、CBZ：一章恰好一个渲染单元）两者都不用，直接读 `章节序号 / 章数`。历史：最早从屏幕上那**一个**单元直接外推（`total = 单元页数 / 单元占比`），同一本 EPUB 因此报过 493、977、805、2202、939 页；随后改成「Σ实测页数 / Σ占比」，量到的占比不足 2%（封面、扉页）时退回单元页码——它不再乱摆，但对未读的章仍靠占比摊派，短章会因为「末页永远不满」把总量拖走一页。排版指纹（字号 / 行距 / 段距 / 缩进 / 页边距 / 排版模式）一变，旧高度量出来的页数属于一个已经消失的排版，纯文本那张表整表作废重来；foliate 的刻度与排版无关，不必作废。

### 标注模型

标注是一条指向章节正文的**不可变字符区间**：`(book_id, chapter_idx, start_char, end_char)` 加一份落库的 `text` 摘录。偏移量是 UTF-16 code unit 计数，**由前端计算、前端解释**，后端只做不透明存储（校验非空与区间有效性），`text` 作为列表里展示的摘录。因为章节正文对一本书而言不可变（重新导入得到新的 `content_hash`），偏移量永远不会因文本更新而失效，所以本阶段**不引入 re-location 引擎**；将来若出现可编辑正文，再以 `text` 为锚点补定位。

前端侧：`selection.ts` 把 DOM 选区经 `TreeWalker` 还原成 joined text（`paragraphs.join("\n")`）上的 UTF-16 区间，`highlightSegments` 把标注区间与搜索命中一起反切成段落内的高亮段（`<mark>`）。选区在 `mouseup` 时解析成「待确认」高亮，由浮层按钮显式落库，避免滚动/复制误触发。

### 检索模型

`chapters_fts` 是挂在 `chapters` 上的 **FTS5 外部内容表**（`content='chapters'`），正文在磁盘上只存一份，migration v4 的三个触发器（`ai` / `ad` / `au`）负责与源表同步。分词器选 **trigram**（`tokenize='trigram'`）而不是默认的 `unicode61`：后者按空格和标点切词，中文整段会退化成一个「词」，子串查询命中不了；trigram 对 CJK 子串天然可用，代价是索引更大。

排序用 SQLite 内建的 **BM25**（`ORDER BY bm25(chapters_fts)`，值越小越相关），不自己实现打分。查询串一律用双引号包成字面量后再交给 FTS5，避免用户输入的 `*`、`OR` 被当成查询语法。查询不足 3 个字符时 trigram 索引无意义，退回 `LIKE '%…%'` 子串匹配（`LIKE` 的通配符在 Rust 侧转义）。

命中结果带三样东西：上下文片段、命中在章节 joined text 里的字符偏移、章节序号。片段里被命中的那一段用两个控制字符包裹（`U+0002` / `U+0003`），前端 `parseSnippet` 按它们切开渲染——用控制字符而不是 HTML 标签，是因为正文里不可能出现它们，且后端不必假设前端怎么渲染。

`search_query` 在 `spawn_blocking` 里跑，且先为「没有 chapters 行的书」补建索引（Phase 3 之前导入的书），保证检索覆盖全库。书库侧的「全文检索」页与书内搜索抽屉共用同一条命令，只是前者不传 `book_id`。点击命中结果跳到对应章节，并把偏移换算成段落下标后滚动到视野中间。

实测（release，内存库，Apple Silicon，600 章 / 828,000 字）：索引构建 25.8 ms，单次查询 0.64–0.75 ms（返回 50 条 BM25 排序命中）。远在交互预算内，因此暂不做结果缓存与增量索引；Phase 13 建立正式 Benchmark 时再拿真实书库复测。

### 书档模型

`.ctz` 是一个 ZIP，装三样东西：`pack.json`（格式标识与版本）、`source.<ext>`（**原文件字节，一字不改**）、`reading.json`（进度、收藏、全部标注）。

书档**不装章节和封面**。两者都能在导入时从原文件重新提取，多存一份只会引入两份数据对不上的可能；原文件进包则保证书档永远能还原出和导出时一模一样的书。

`.ctzx` 是同一个 ZIP 整体加密的结果，布局是 `header_len(LE u32) || header(JSON) || nonce(12B) || ciphertext`：

- 密钥：**Argon2id**（19 MiB / t=2 / p=1，OWASP 交互登录下限）从密码派生；salt 每次导出重新生成，所以密钥也是新的，nonce 永不复用。
- 加密：**AES-256-GCM**，整个归档一次性封箱。
- **头部明文但参与认证**：KDF 参数与 salt 作为 GCM 的 AAD。篡改它们会得到「认证失败」而不是被悄悄降级成弱参数。
- 全部构件来自 RustCrypto（`argon2` / `aes-gcm`），不自研原语。GCM 分不清「密码错」和「文件坏」，错误信息也不替用户区分。

实测（release，Apple Silicon，2 MiB 归档）：加解密各约 30 ms，其中 AES-GCM 只占 1 ms 量级，其余全是 Argon2id——这正是它该有的样子，代价花在抗离线爆破上，而不是花在用户体验上。

导入路径：`import_files` 按扩展名分流，书档先解包、把原文件**暂存进书库自己的目录**（与落盘同盘，避免跨卷复制）再走既有管线，最后套用 `reading.json`；暂存文件无论成败都在返回前删除。标注按 `(chapter_idx, start, end)` 去重，重复导入同一份书档是幂等的。

`password` 作为 `book_import` 的**参数**而非回调里的提示传入：整批文件在一条 `spawn_blocking` 任务上跑完，中途弹窗会打断批处理。前端只在批次里出现 `.ctzx` 时先要一次密码，明文文件照常导入。

### 笔记导出

标注与笔记可以导出成两种**不依赖本应用**的文件，格式由目标扩展名决定（`notes.export`，与书档同一套契约）：`.md` 按章节分组、引用原文、笔记跟在引用下面；`.csv` 一行一条，带原文 / 笔记 / 颜色 / 样式。目标扩展名不认识就直接拒绝，不猜。

它和书档回答的是两个问题：书档为了把**阅读状态还原**回去（装原文件与 `reading.json`），导出文件为了**在应用之外被读**（纯文本，没有 schema，不需要本应用打开）。

两个刻意的取舍：**章节只写序号**，不查 `chapters` 表取标题——foliate 书籍的标注按 section 编号，用这个序号去取标题会整体错位，而序号与阅读器标注面板显示的完全一致；**CSV 带 UTF-8 BOM**，否则 Excel 按系统代码页猜编码，中文直接变乱码。颜色与样式为空的条目留空而不填默认值：「从没选过」和「选了黄色」是两件事，文件不该替用户编一个。

每条标注还带一个点回本应用的深链，见下节。

### 深链

导出文件里每条标注都带一个 `colorreader://book/<bookId>?annotation=<annotationId>`：点击即回到应用并定位到那条高亮。生产端是 `library/export.rs::link`，消费端是 `AppShell` 挂的 `useDeepLink`，中间由 `tauri-plugin-deep-link` 把系统递来的 URL 变成事件。

**链接只带身份，不带位置**，这是被证据逼出来的设计。本应用有三种互不通约的位置模型——foliate 用 CFI、纯文本用「章节 + 字符偏移」、PDF 用页码——写进 URL 的无论哪一种，用另外两种打开就是错的。而标注行自己知道它属于哪一种，所以 URL 只写 id，位置由应用查出来。同一个链接因此对三种通路都成立，将来加第四种也不用改。

解析分两层：`src/lib/deeplink.ts::parseDeepLink` 是纯函数，对系统递来的任何字符串都不信，解析不了就丢弃；`useDeepLink` 把它变成 `/reader?book=…&annotation=…`，与搜索结果走同一套查询参数，不另开一条进入阅读器的通路。阅读器侧有一条硬约束：**初始位置必须在 render 期确定，不能靠 effect 回填**（`ReaderView` 的既有判据），所以路由层在链接指名了标注时先等标注列表加载完再挂载阅读视图——foliate 书把该标注的 CFI 喂给 `startCfi`，视图 `init()` 时就落在高亮上（改成挂载后再滚会是一次看得见的跳），纯文本书则把章节喂给初始 `chapterIdx`。链接指向的标注已删除或尚未铸锚时退化为「打开这本书」，而不是打不开。

scheme 与资源协议同名（`resource.rs` 的 `colorreader`），靠 host 区分：`book` 是链接，`localhost` 是资源。两者职责不重叠——资源 URL 只在 webview 内部被 `src` 消费，从不外流。

**scheme 的注册全发生在打包期**：macOS 的 `CFBundleURLTypes` 由打包器从 `plugins.deep-link.desktop.schemes` 生成，Windows 的 NSIS / MSI 安装器写 `Software\Classes\colorreader`，Linux 的 deb 与 AppImage 带一份 `MimeType=x-scheme-handler/colorreader` 的 `.desktop`——因此不需要运行时 `register_all()` 兜底（那只对裸跑 AppImage、绿色版 exe 这类旁路安装有意义）。代价是注册只存在于打包产物里：**`tauri dev` 的窗口永远收不到链接**，macOS 实测必须 `--bundles app` 并安装到 `/Applications`（该平台不支持运行时注册，插件的 `register` 直接返回 `UnsupportedPlatform`）。

Windows / Linux 是另一套机制：系统不认识「已在运行的那个实例」，而是**再启动一个进程**，把 URL 当作唯一参数递过去。于是这一侧由 `tauri-plugin-single-instance` 承担合流，且**必须在所有插件之前注册**——「这个进程是否留下」是它在自己的 setup 里决定的：第二进程把 argv 交给先到的实例，然后退出。开启它的 `deep-link` feature 后，这次交接在进入回调之前就被转成与 macOS 同一个 `deep-link://new-url` 事件，所以 `useDeepLink` 不必区分来源；回调只剩一件事——把窗口调到前面，否则读者在浏览器里点了链接，应用却在后面。首启就带参的情况由 deep-link 插件自己处理（它 setup 时读一遍 `std::env::args`）。

### AI 助手

Provider 选型收敛为一件事：**OpenAI 兼容的 `/chat/completions`**。Ollama、LM Studio、vLLM 与托管 API 都说这个协议，所以「OpenAI 兼容」不是厂商绑定，而是事实标准；用户只需要改 `base_url`。配置（地址、Key、模型、系统提示词）存 migration v5 引入的 `settings` KV 表——**Key 只存 Rust 侧**，渲染层 localStorage 里放 Key 等于向所有能读 profile 目录的东西公开，而发请求本来也是后端的事。

流式链路：`ai_chat` 发起请求后立即返回，增量文本经 `ai://stream` 事件推送（带 `requestId` 防串台，`done` 事件收尾并可携带错误）。SSE 解析是纯函数 `feed(buffer, chunk)`：跨网络分片可恢复（只消费到最后一个换行），`[DONE]` 终止，解析不了的帧跳过而不是断流。流式循环里区分 `Delta` / `Finish` / `Done` 三类事件，部分 Provider 发完 finish reason 就关连接不发 `[DONE]`，由命令层兜底补发收尾事件。

安全默认值：明文 `http://` 只接受 loopback（`localhost` / `127.0.0.1` / `[::1]`），外网必须 TLS，否则 Key 明文过网。前端侧 `useAiChat` 维持一次一问：新提问替换上一轮问答，过期 `requestId` 的事件直接丢弃。

### 查词与翻译

划词后的动作各走最短的一条路，**离线的两条排在最前**。

**词典是「平台词典 → 导入的本地词典 → AI」这条链**，全部由 `lookup_dictionary` 一个命令走完。返回 `Found{text, source}` / `Missing` / `Unavailable` 三态**标记值而非错误**——「词典里没有」和「这里根本没有词典」都是答案，前端对两者都回落到 AI，且只对前者提示。`source` 告诉弹窗这条是哪个词典给的：系统词典为 `null`（不标注），导入的词典填自己的名字。

**第一级：平台词典**（macOS 的 `DictionaryServices`，`dictionary.rs`）。本地、瞬时、免 Key，返回纯文本词条（音标、词性、义项、`▸` 例句标记原样透传，没有标记要剥）。这不是「内置一份词典数据」——不打包也不下载任何数据集：中文系统查英文词给出中文义项加拼音，反之亦然。两条实测结论让它不必配启发式：**整段选中不是查询**（`hello world`、整句、长中文从句一律无词条），所以句子自然而然落到下一级；而 `"  spaced  "` 能剥掉空白命中 `space`。**这是 macOS 专属能力**：Windows / Linux 上返回 `Unavailable`，第二级于是成为那些平台唯一的离线来源。

**第二级：读者导入的本地词典**（注册表 `library/dictionaries.rs` + 两个格式层 `stardict.rs` / `mdict.rs`）。读者选一个文件（`.ifo` 或 `.mdx`），bundle 收进 `<data dir>/dictionaries/<id>/`，**按元数据里的 `kind` 分派到对应读取器**。列表存 `settings` 的单个 JSON（`lookup.dictionaries`），所以**不需要迁移**；查询按列表顺序试，第一个命中即返回。

**StarDict**（`.ifo` + `.idx` + `.dict`，外加可选的 `.syn`）：**`.dict.dz` 在导入时就解压**——gzip 没有随机访问，每次查词都从头解压整本，比多占一份磁盘贵得多。索引不整份驻留：扫一遍只记下**每条词条的起始偏移**（4 B/条，70 万条约 2.8 MB），查词时二分再按需 `seek` 读那一条。三处收窄（都在导入时报明确理由）：只支持 32 位偏移、`sametypesequence` 只接受单一文本类型、二进制字段（图片 / 声音）跳过。

**`.syn` 变形词表和索引共用同一个读取器**：一条 `.syn` 记录与一条索引记录的差别只在终止符之后——「词 + 4 B 条目序号」对「词 + 4 B 偏移 + 4 B 长度」——所以记录扫描泛化成 `record_offsets(bytes, value)`，两侧都只驻留偏移表（4 B/条）。查词因此是四条支路：**精确 → 小写**各试一次索引与变形词表，变形词命中的是**条目序号**而不是偏移，越界即报错（一份损坏的 `.syn` 不能把进程带走）。这是「只收 `run` 的词典划 `ran` 也能落到 `run`」的唯一通路，也是它值得单独一遍二分的原因。

**MDict**（`.mdx`）是逆向格式——MDict 闭源、没有官方规范，所以收窄得更狠：只支持 **2.0 + UTF-8 + 未加密**。1.2 会把每个尺寸字段从 8 字节换成 4，其它编码要 GBK / Big5 解码器，加密有两条各自以邮箱 / 设备 ID 为密钥的路径；这些在读头部时**按名拒绝**，而不是半解析——猜错产出的是「看起来合理的乱码」，比拒绝更糟。键与正文都在压缩块里，所以一次查词是「**按块的首 / 末键选出键块 → 解压 → 块内扫描 → 取记录偏移 → 定位记录块 → 解压 → 读到 NUL**」，只解压两块。文件里三种字节序的校验和全部校验：头部小端、键区前言大端、每块大端且算在**解压后**的数据上。`.mdd` 资源包不导入。

读取器的正确性不靠自我印证：夹具 `src-tauri/tests/fixtures/mini.mdx` 由**第三方写入器**（`writemdict`，见 `scripts/generate-mdx-fixture.py`）产出、并被**第三方读取器**接受，Rust 测试打的就是这个文件。

**翻译**走 DeepL（`lookup_translate`，Key 存 `settings`，按 `:fx` 后缀选免费 / 付费主机），一次往返、不流式；没配 Key 就与词典共用同一个 AI 流式回答。**维基百科**（`lookup_wikipedia`）取 REST summary：先精确标题、再走搜索索引兜底、再换语言版本，同样不需要 Key。

DeepL / Wikipedia 在**后端**发请求，因此 Key 永远不进渲染层，CORS 也从不适用于 webview；两条离线链则连网络都不需要。

### RAG 模型

**不用向量数据库扩展，检索是 Rust 里的暴力点积。** 一个个人书库的组块量级是几千而不是几百万（600 章 ≈ 数千块），768 维归一化向量全量扫一遍是毫秒级；sqlite-vec 的加载、版本与平台问题在这个量级下全是纯开销。等数字证明需要 ANN 时再引入，`chunks` 表的形态不会因此改变。

组块：按**段落边界**把章节正文切成约 600 字的块（单段超长则整段一块，不切断句子），`start_char`/`end_char` 与标注、搜索命中同处一个坐标系（章节 joined text 的 UTF-16 偏移）。段落是语义上最干净的切分线，块内不出现 `\n`，命中区间可直接映射到段落。

存储：向量 **L2 归一化后以 f32 LE 字节存 BLOB**，检索退化为点积（即余弦相似度）。`model` 与 `dims` 随行入表并参与过滤——不同模型的向量不在同一个空间，混比是噪声；换向量模型后重建索引即切换空间。

管线：`rag_index_book` 按批（16 条/请求）嵌入并 emit `rag://index-progress`，旧索引与新块同事务替换，失败保留原索引；`rag_chat` 把问题嵌入后取 Top-6（跨书或限单书），编号片段拼进提示词，回答流式推送、引用随 `done` 事件返回，前端点引用按既有 `chapter + offset` 参数跳转。

### 检索重排与朗读

**重排是可选的第二阶段**。重排没有 OpenAI 标准，但 Cohere 的 `/rerank` 线格式成了事实标准（Jina、SiliconFlow 等同型），所以 `rerank_model` 留空即关闭；配置后 `rag_chat` 把第一阶段召回放宽到 Top-24，再由重排模型挑出最终 Top-6。重排失败**直接报错**而不是静默降级：配置错了却每问都「碰巧还能用」，比诚实失败更难排查。

**朗读是双引擎的**：系统 `speechSynthesis`（离线、不引依赖）与 **Edge TTS**（Rust 侧 WebSocket，`tts.rs`）。之所以要有第二个，是因为默认音色 **Yunjian 是服务语音**（`zh-CN-YunjianNeural`）——`AVSpeechSynthesisVoice` 与任何系统清单里都没有它，而它正是这个阅读器想给出的默认声音。Edge 那条**必须走 Rust**：握手要一个浏览器不允许脚本设置的 `Cookie` 与 `Origin`，`Sec-MS-GEC` 是按原始时钟签的，渲染层既拿不到它也不该被信任持有。两个引擎在 `voice.ts` 里按 `edge:` 前缀分派，Edge 不可达时回落到系统音色并在面板上给出错误与重试。

播放本身仍是**一次一段**：段落边界就是天然的进度条，当前段落高亮、滚出视野才跟随滚动，本章读完自动翻章续读，generation 计数器防「cancel 后残留 end 事件重启朗读」的平台怪癖。语速属阅读设置，改动从**当前位置**重播（不是等下一句）。

### 知识图谱模型

**不引入图数据库，图就是两张表加 SQL。** 一本书的实体量级是几十到几百，邻域查询是 `(book_id, subject)` 与 `(book_id, object)` 两个索引上的普通 SELECT；真正的成本在 LLM 抽取，存储侧的任何「专用图引擎」都是纯开销。

抽取复用聊天通道：逐章把指令与正文发给 `/chat/completions`（要求裸 JSON），回答收集成字符串后取第一个 `{` 到最后一个 `}` 解析——模型偶尔包 markdown 围栏，这样切一刀就够了，不为此接 structured output 专有协议。抽取**不走**用户配置的阅读助手系统提示词，避免人设干扰指令跟随。

合并规则（Rust 侧纯函数 `merge`）：实体按名字去重、mentions 累加，空名与超过 30 字的「名字」（基本是模型在粘贴散文）丢弃；关系按 `(subject, relation, object)` 去重，保留首次出现的证据句与章节。关系**直接存名字而不是实体 id**：模型可能抽出实体表里没有的关系端点，外键只会把它悄悄扔掉。

整本重建：逐章抽取（40 字以下的章跳过）、进度经 `graph://build-progress` 推送，最后旧图与新图同事务整体替换——中途失败保留旧图谱，永远不会有半张图。

### 书源模型

**书源是一份用户可编辑的 JSON 规则**，存 `sources` 表（migration v8，整份定义一个 JSON 列：书源在 UI 里按单文档编辑，没有任何查询需要触及单条规则）。规则语言是刻意收窄的 JSONPath 子集 `$.a.b[*].c`，手写约 60 行求值器——足够表达真实书源，小到一眼可审计；不引 scraper / JSONPath 依赖，HTML 网页源暂不支持（仅 JSON 接口源）。

五个阶段对应书源的五组规则：`search`（搜索地址 `{{keyword}}` 手写百分号编码，无需 urlencoding 依赖）→ `book`（详情）→ `chapters`（目录）→ `content`（正文，字符串按行切或字符串数组）→ `download`。必填规则缺失在保存时 `validate` 拦下，可选字段（作者 / 简介 / 封面）求值失败降级为空串而不是整条失败。

**下载产物走既有导入管线**：逐章抓取、拼成带「第N章」标记的 TXT（书源自带标记的标题原样保留），写入暂存文件后调用 `import_files`——去重、哈希、章节切分全部复用，下载的书和本地导入的书在书架上没有区别。进度经 `source://download-progress` 逐章推送，暂存文件无论成败都清理。

### 同步模型

**同步对象有三样：阅读进度、标注与书签。** 进度以 `content_hash` 为键——同一份书文件在任何设备上哈希相同，天然对齐，无需中央注册表；标注与书签以各自的 UUID 为键，创建它的设备生成一次、其余设备原样沿用，所以同一个 id 处处指同一条。云端是一个 WebDAV 目录下的单个 `state.json`（`version` 现为 2；v1 旧文件仍能解析，新增的两张表默认空），HTTP 只用三个动词：GET 取状态、PUT 写状态、MKCOL 补缺失的祖先目录。同步凭据存 `settings` KV 表（`sync.webdav`），与 AI Key 同一安全模型：渲染层永不持有；`sync.device_id` 首次同步时生成。

合并是三个 LWW 纯函数（`merge` / `merge_annotations` / `merge_bookmarks`）。进度逐本合并：**两边进度相同视为一致**（不看时间戳，否则每次同步都会因时钟翻新产生无谓重传），进度不同时时间戳新者胜、平局云端胜（两台设备同一秒写入时收敛而不是来回翻）。标注与书签逐条合并，规则同此，只在两处收紧：`updated_at` 相同时**删除胜过活项**（否则删掉的标注会被一个同秒的旧副本复活），且两边 `same_payload` 时只保留较新的时钟、不产生写入（同样是为了不 churn）。删除靠**墓碑**传播——`delete` 把行真删（本地所有查询因此都不需要「未删除」过滤），并在 `annotation_tombstones` / `bookmark_tombstones` 留一行，`for_sync` 把墓碑与活行一并交给合并。远端赢的条目只在本地导入了那本书时才落库（按 `content_hash` 解析出本地 `book_id`），否则留在状态里，等有这本书的设备来取。

每本书的决策（上传 / 下载 / 云端独有 / 一致）连同标注、书签的计数（上传 / 下载 / 删除，只报数量、不列条目）随 `sync_now` 返回给 UI 展示。两条安全底线：**云端 JSON 解析失败直接中止同步**——绝不拿本地数据覆盖一个可能恢复的远端；PUT 前只应用「胜出」的值，本地赢时写回的是相同值，不产生回退。

两处刻意的简化：墓碑不剪枝（个人量级下每次删除多几行而已，`for_sync` 的注释写了升级路径）；同一句话在两台设备离线各划一次会得到两条——uuid 不同，不做按区间折叠，罕见且可手删。

### 导入管线

`book_import` 接收绝对路径数组，`spawn_blocking` 中逐个处理，每个文件完成后向前端 emit `book://import-progress` 事件（`{ done, total, path }`）。单文件流程：读取字节 → SHA-256 → 命中 `content_hash` 即返回 `duplicate` → 按格式解析元数据与封面 → 书籍文件与封面复制进 app data 目录 → 事务写入。三种结果：`imported` / `duplicate` / `failed`，批量结束一次性返回，UI 不因单个失败文件中断。

### 资源协议

封面不经过 `file://`，走 `Builder::register_uri_scheme_protocol` 注册的 `colorreader://`。URL 形态因平台而异（macOS `colorreader://localhost/cover/{id}`，Windows/Linux `http://colorreader.localhost/cover/{id}`），由 `resource::resource_origin()` 在编译期编码，前端只拿后端拼好的 `coverUrl`。处理链：校验 id 形态（UUID 字符集、长度上限、拒绝 `..`）→ 查库定位封面路径 → 读文件按 MIME 返回，非法 id 一律 404。同一协议还承担两件事：**书籍源文件**（`/book/{id}`，支持 `Range`，让开书不再随文件体积增长）与**导入的字体**（`/font/{id}`）。字体那条多了两个必须的头：`Access-Control-Allow-Origin: *` —— 字体是跨源加载且受 CORS 约束，漏了就是静默回退到别的字体；`Cache-Control: immutable` —— URL 里是导入时新生成的 UUID，内容不可能变，而一个 20 MB 的中文字体若每上一屏就重取一次，就是肉眼可见的卡顿。

### 自定义字体

中文字体是几十兆字节、许可也各自独立，所以**不内置任何字体**，读者把自己已有的文件导入进来（`font.import`，接受 `.ttf` / `.otf` / `.ttc` / `.woff` / `.woff2`）。副本落在 `<data dir>/fonts/<uuid>.<ext>`，列表存 `settings` 的单个 JSON（`reading.fonts`），与词典同一套零迁移做法。`.ttc` 收进来了但只加载其中第一个字面形：CSS 无法指定集合里的第几个，拒绝文件则是把一种能用的字体变成不能用。

命名是这条链的关键一步：字体在 CSS 里叫 `cr-<id>`，设置里选中它用 `custom:<id>`，**两个名字都由 id 推出来**。这让 `resolveFont` 保持成一个对设置值的纯函数——选择器有列表，样式构建器没有。

`@font-face` 要**分别**声明在两处，因为书的一节是一个独立文档，应用文档里的声明进不去它：书的那份随注入的样式表一起进 section（`FoliateStyle.fontFaces`），应用侧这份在 `AppShell` 里渲染一个 `<style>`，覆盖 prose 通路与设置界面。`font-display: swap` 是必需的：默认行为会在字体下载完之前不显示文字，而中文面孔有几十兆。

最后两处容易漏：CSP 的 `font-src` 必须放行资源协议的源，否则 iframe 里的字体被策略挡掉；删除一个正在使用的字体时，`useDeleteFont` 会把设置退回 `system` —— 否则阅读面会去请求一个再也没有 `@font-face` 声明过的族名，文字悄悄变成浏览器的兜底字体，屏幕上没有任何解释。

### 演进为 Workspace 的触发条件

规范里给出的 `crates/` 划分（`reader-core` / `document-parser` / `search-engine` / `database` / …）**刻意推迟**。拆分时机是当出现下面任一信号：

1. 单个模块超过约 800 行且存在两个以上互不相关的变更理由；
2. 某个模块需要被第二个 crate 复用（例如 `database` 同时被 `reader-core` 和 `rag` 依赖）；
3. 某个模块的编译时间开始主导增量构建。

在此之前，一个 crate + 清晰的模块边界比十几个空壳 crate 更利于维护。原则：**模块边界必须清晰，而不是为了目录好看而拆包。**

### 错误处理

生产路径禁止 `unwrap()` / `expect()`。所有命令返回 `Result<T, AppError>`，错误必须满足：类型化、可序列化、对用户友好、已记录日志。日志走 `tracing`，默认 `colorreader=info`，用 `RUST_LOG` 提级。

---

## 3. 前端架构

Feature-oriented：`components/` 放可复用 UI，`features/` 放业务领域。路由是单一 `AppShell` + `Outlet`。

### 状态归属

| 状态类型          | 归属               | 例子                                   |
| ----------------- | ------------------ | -------------------------------------- |
| UI / 交互 / 偏好  | **Zustand**        | 侧边栏折叠、主题、命令注册表、面板开关 |
| 服务端（IPC）数据 | **TanStack Query** | 系统信息、书库列表、搜索结果、AI 回答  |
| 派生数据          | `useMemo`          | 命令面板的评分与分组                   |

禁止把 IPC 返回值塞进 Zustand，也禁止把所有业务状态塞进 Zustand。

### 阅读渲染：两条通路，一份语料

| 通路                   | 何时使用                          | 渲染                                                                     |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Document Model         | pdf / fb2 / cbz / markdown / txt  | Rust 抽取纯文本段落 → 段落索引 → FTS5 / 标注 / 朗读 / RAG 全基于段落索引 |
| foliate-js（原书排版） | mobi / azw / azw3 / **epub** 恒用 | `makeBook()` + `<foliate-view>` 渲染原书 XHTML + CSS                     |

两个**容器格式**都走 foliate：KF8 把正文拆成 skeleton + fragment，部首页壁纸、
插图、字体与配色全在原书 CSS 里；EPUB 自带样式与固定版式（fixed-layout）同理。
抽成纯文本段落必然丢排版——这是反复修不好的根因，不是某个解析 bug。

FB2 / CBZ / TXT / MD 仍走 Document Model——它们的原书样式几乎没有内容；
PDF 走自己的 pdf.js 通路，foliate 的 `pdf.js` 已打桩禁用。

**一份语料**：`document::read_chapters` 对七种格式（含 mobi、epub）统一抽纯文本
入库，导入期由 `library/import.rs` 落表。所以不论哪条通路在渲染，FTS5 / RAG 组块 /
书内检索命中的都是同一份章节文本。双轨只存在于**渲染侧**：标注、划词、朗读定位
在 foliate 通路上以 CFI 为锚，在 Document Model 上以「章 idx + 偏移」为锚。
这点正是我们没有照搬 readest 全量方案的原因——它把渲染全交给 foliate 后，
不得不自建「每本书一个索引库 + 反抽正文」才拿回检索与 RAG；我们导入期就有。

- 入口：`src/features/reader/FoliateBookView.tsx`，路由级 lazy，仅上述书籍打开时加载。
- 位置：CFI 存 `books.location`（`readerSetProgress` 的 `location` 参数）；
  旧的 `localStorage: colorreader:foliate:<bookId>` 只作一次性兜底读取。
  🔴 切通路不换算坐标：epub 首次以 foliate 打开时没有 CFI 可续，从书首开始；
  之后位置一直是 CFI。
- foliate 通路已对齐：标注回显（`draw-annotation` + `create-overlay` 重绘）、
  书内检索（`view.search()`）、TTS 起读与洗色、页码与目录，均以 CFI 为锚。
- 🟡 迁移前已有的 epub 标注没有 CFI：仍在标注列表里，但不再上色、点击不跳转。
  新标注一律带 CFI。要补就得按 `text` 反查 CFI，等真有抱怨再做。
- **fixed-layout**（`rendition:layout = pre-paginated`）：`view.open()` 自动切到
  `foliate-fxl`（`fixed-layout.js` 动态分块，32 kB）。接线只有两处：
  ① `applyLayout` 给它 `spread` 属性——它不认 paginator 的 `max-column-count`；
  ② 页面反色靠 `foliate-view[data-fxl-night]::part(filter)` 反色 iframe
  （view 元素上补了 `exportparts`，把 renderer 的 `filter` part 转出到文档样式）。
  固定版式不吃排版设置：字号、行距、段距、首行缩进对它无效，这是版式本身决定的。
  🔴 **该属性只在 `view.isFixedLayout` 且用户开了「夜间图片 → 反色」时才加**
  （`syncPageInvert`）：paginator 给**每一个** section iframe 也挂了 `part="filter"`
  （`paginator.js:780`），所以在可重排书上标记 view 会把**已经排好的夜色页面**整体
  反相——`#15181d` 纸面 + `#c9ced8` 墨色反成「浅纸 + 深墨」，插图一起反相，看上去
  与夜间模式完全没生效一模一样。诊断时 🔴 别只看 `getComputedStyle`：CSS filter 是
  绘制期效果，computed 值永远正确，只有像素（或截图）能证伪。
- **排版与主题注入**（`src/features/reader/foliateStyle.ts`）：一份字符串注入每个 section
  文档，light 只给排版，dark 再叠 readest 的色彩方案。要点：
  - `html` 上发 `--theme-bg-color` / `--theme-fg-color` / `--override-color: true`，
    paginator 的 `#background` 层据此把「无图页面」的填充换成主题色，带 `url()`
    的纸面（Kindle 水彩、章节图版）原样保留。
  - **元素级重漆**：`html, body` 的 `color` 只够到达直接继承的文本；Calibre 系
    转换书把颜色写在每个自有 class 与行内 `style` 上，所以还要给块级/内联元素
    加 `color: fg !important`——否则夜间就是「黑字压夜色」。`background-color`
    故意不强制：section 自己的背景交给上面的 resolver 处理。
  - **图片封顶**：`img/svg/video/canvas` 加 `max-width/height: 100% !important` +
    `object-fit: contain`，另给带像素 `width` 属性的元素（`width="900"` 这类印刷稿）
    加 `max-width: 100% !important`。paginator 的 `setImageSize` 在横向分页下以
    「元素自己的 CSS 宽度」为准，只在没有作者宽度时才回落到父级 100%，所以书把
    图包进印刷宽度盒子时图会溢出栏位——规则补的就是这一段。
  - **图片反色是 opt-in**（设置「夜间图片 → 原色/反色」，store `invertBookImages`，
    默认关）：dark 且开启时在 sheet 末尾追加 `img, svg, video, canvas, image
{ filter: invert(1) hue-rotate(180deg) }`；prose 通路（FB2/CBZ/TXT/MD）用
    `.invert-book-images` 挂同一条规则；PDF 另有自己的 `pdfInvertImages`。默认关的
    理由：调色板已经把纸面压暗，反相的照片是缺陷不是功能；开是给「整页就是一张亮
    位图」的书（漫画、扫描图版）省亮度用的。
  - 🔴 全链路禁写 `color-scheme`（注入样式、index.html、App 根都不写）：WebKit 里
    used color-scheme ≠ normal 会把「根透明」的 iframe 画布画成不透明，盖死身后
    的 `#background` 层与壁纸。模板字面量里的注释也禁写反引号（会提前闭合模板）。
- **vendored fork 的本地补丁**（`src/vendor/foliate-js/`，均为 `// local patch` 注释）：
  ① `epub.js` 的 `loadReplaced`：把资源重写成 `blob:` 时，同时把容器内路径写到元素
  的 `data-path` 上——section 文档里 `src` 全是 blob URL，书内图片浏览器按档案路径
  索引，除这里之外无处可join；② `paginator.js` 的暗色背景 resolver 保图不保色；
  ③ `pdf.js` 打桩禁用（本项目 PDF 走自己的 pdf.js 通路）。
- **书内图片浏览器**：正文里点图 → 该 section 的 `click` 监听（`attachSection`，与
  keydown/mouseup 同一入口，幂等）读 `data-path` → `onImageOpen` → `ReaderPage`
  在 `book_images` 里定位 → 打开 `ImageLightbox`。渲染框任一边小于 48px 的图不当
  可点目标（书里的分隔线、项目符号也是图片）。
- 协议：ColorReader 为 AGPL-3.0-or-later，foliate-js 为 MIT，
  见 `THIRD-PARTY-NOTICES.md` 与 `THIRD-PARTY-foliate-js-LICENSE`。

### 命令系统

命令注册表是**单一事实来源**，键盘、命令面板、菜单、右键菜单统一从这里取：

```text
Command（lib/commands.ts）
  ├── id / title / description / group / keywords
  ├── shortcut?: Shortcut[]        → useHotkeys 全局监听
  ├── icon?: ReactNode
  ├── isEnabled?: () => boolean
  └── run: () => void | Promise<void>
```

`useHotkeys` 在可编辑元素（`input` / `textarea` / `[contenteditable]`）内不触发，避免与输入框抢键。

### 路由

桌面应用没有地址栏，使用 `createMemoryRouter`。命令 → 路由跳转通过一个 `CustomEvent` 桥接（`useNavigationBridge`），因为命令注册表本身在 React Router 之外。

---

### 命令系统（续）：错误处理与日志

| 层     | 机制                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 渲染层 | `ErrorBoundary`，根节点一个 + 路由出口一个。崩溃只影响一个页面，侧边栏与命令面板仍可用 |
| 数据层 | 调用点自行处理。IPC 拒绝与 Query 错误不冒泡到 ErrorBoundary                            |
| 日志   | `lib/log.ts` 的 `createLogger(scope)`：结构化载荷，开发 `debug` / 生产 `info`          |

`ErrorBoundary` 是全项目唯一的 class 组件（React 没有对应的 Hook），只用 `getDerivedStateFromError` + `componentDidCatch`，不碰任何旧式生命周期。它是**兜底隔离墙，不是错误处理**：预期内的失败必须在发生处处理，禁止用 `console.log` 代替。日志禁止写入书籍正文、用户输入的完整内容、API Key。

---

## 4. IPC 契约

### 命名

命令按域分组，一个域一个 `src-tauri/src/commands/<domain>.rs`，命令名是 `<域>_<动作>`：

```text
ai.*          annotation.*  book.*        bookmark.*    clippings.*
dictionary.*  font.*        graph.*       lookup.*      notes.*
pack.*        rag.*         reader.*      search.*      source.*
stats.*       sync.*        system.*      tag.*         tts.*
```

示例：`system_info`、`book_import`、`reader_chapter`、`search_query`、`annotation_create`、`pack_export`。

Tauri 命令名在 Rust 里是 snake_case，前端通过 `src/lib/ipc.ts` 的单一出口调用，**不散落 `invoke` 调用**。返回值类型由 Rust 签名生成，落在 `src/lib/bindings.ts`（`src/types/ipc.ts` 只做转出与少量别名）。

### 绑定由 Rust 生成（tauri-specta）

71 个命令里 69 个由 `#[specta::specta]` 标注生成，2 个例外见下。生成产物 `src/lib/bindings.ts`
**要提交**，改动 Rust 签名后重新生成：

```sh
cd src-tauri && cargo test --lib specta_bindings::export_bindings
pnpm exec prettier --write src/lib/bindings.ts   # 生成物未格式化，pre-commit 会卡住
```

几条不能忘的约定：

- **派发仍是 `tauri::generate_handler!`**，`tauri-specta` 只当类型生成器。`book_asset` / `book_source_file`
  返回 `tauri::ipc::Response`（二进制通道），specta 建不了模；而 `tauri::ipc::Invoke` 没有 `Clone`，
  两个 invoke handler 拼不起来。代价是命令清单写两遍，但漏加会让 `tsc` 直接报错，不会静默漂移。
- `.error_handling(ErrorHandlingMode::Throw)`：生成的 `Promise<T>` 在 `Err` 时 reject，TanStack Query 的
  `onError` 语义不变（默认的 Result 联合类型会逼所有调用点改错误处理）。
- `.dangerously_cast_bigints_to_number()` 必开，否则 `u64`/`usize` 拒绝导出。
- `AppError` 的 `Type` 必须**手写成 String**（它的 `Serialize` 是纯字符串，derive 会变成 tagged enum）。
  注意路径是 `specta::datatype::DataType`，写错会让所有 `Result<T, AppError>` 报一堆假错误。
- 事件负载不在任何命令签名里，必须 `.typ::<T>()` 显式注册（`ImportProgress`、`AiDelta`、
  `RagProgress`、`GraphProgress`、`SourceProgress`）。
- 生成类型是 Rust 类型的事实：`f64` → `number | null`；`#[serde(default)]` → 可选字段；
  `skip_deserializing` → `_Serialize` / `_Deserialize` 分裂（如 `Font`，前端取 `Font_Serialize`）。

### 事件

事件名统一为 `<域>://<事件名>`，Rust 侧是 `commands/<域>.rs` 里的
`pub const <X>_EVENT`，负载类型由 Rust 生成（见上），经 `src/types/ipc.ts` 转出：

```text
book://import-progress       { done, total, path }
ai://stream                  { requestId, text, done, finishReason, error, citations? }
rag://index-progress         { done, total }
graph://build-progress       { done, total }
source://download-progress   { done, total, chapter }
```

目前只有这五个事件；TTS 的音频走 `tts_edge_speak` 的返回值、同步结果是 `sync.now` 的
返回值，两者都不发事件。

---

## 5. Design System

### Token

全部定义在 `src/styles/globals.css` 的 `@theme` 中，通过 Tailwind v4 暴露为工具类：

| 类别 | Token                                                                                  |
| ---- | -------------------------------------------------------------------------------------- |
| 圆角 | `--radius-sm 14px` · `md 18px` · `lg 24px` · `xl 28px` · `2xl 32px` · `3xl 40px`       |
| 模糊 | `--blur-sm 12px` · `md 20px` · `lg 30px` · `xl 48px`                                   |
| 缓动 | `--ease-out` · `--ease-in-out`                                                         |
| 阴影 | `--shadow-glass` · `--shadow-panel`                                                    |
| 颜色 | `--color-surface-1/2/3` · `--color-hairline` · `--color-text-1/2/3` · `--color-accent` |

圆角下限是 **14px**。规范里点名的 4–8px"后台式圆角"不出现在这个代码库里。

### 材质层级（重要）

Liquid Glass 的代价是 `backdrop-filter`：**嵌套的玻璃会把模糊一层层叠加，既糊又慢**。因此材质被分成三级，只有顶层材质带模糊：

| 级别        | 工具类        | 用途                             | 模糊                        |
| ----------- | ------------- | -------------------------------- | --------------------------- |
| elevation 1 | `glass`       | 面板内部的卡片、行、图标底座     | 无                          |
| elevation 2 | `glass-2`     | 顶层表面：侧边栏、主面板、对话框 | `blur(30px) saturate(180%)` |
| elevation 3 | `glass-solid` | 浮在内容之上的气泡 / 提示        | 无                          |

`GlassSurface` 是唯一入口，组件通过 `elevation` 选择材质，不自己拼 `backdrop-filter`。

### 可访问性

- `prefers-reduced-motion` → `MotionConfig reducedMotion="user"` 全局降级，各组件另用 `useReducedMotion()` 兜底。
- `prefers-reduced-transparency` 与设置项「减少透明度」→ 顶层材质转为接近不透明并关闭模糊。
- `prefers-contrast: more` → 提高描边与正文对比度。
- 焦点环统一由 `focus-ring` 工具类提供。

### 对比度预算

文字 token 的 alpha 按**它们实际所落的最暗表面**（dark 下约 `#161922`，light 下约 `#fdfeff`）校验，而不是按 `app-bg` 单独校验。当前实测值：

| Token    | dark            | light           | 用途                       |
| -------- | --------------- | --------------- | -------------------------- |
| `text-1` | 0.92 → 约 14:1  | 0.90 → 约 13:1  | 标题、正文                 |
| `text-2` | 0.64 → 约 7.7:1 | 0.70 → 约 5.3:1 | 次要说明、表值             |
| `text-3` | 0.52 → 约 5.1:1 | 0.62 → 约 4.5:1 | 12px 元信息，仍须过 AA     |
| `accent` | 白字约 8.4:1    | 白字约 5.4:1    | 主按钮填充、焦点环、选中态 |

`text-3` 承载 12px 文字，所以不能按"三级灰就该淡"来给值；light 主题的 `accent` 由 `#a9671b` 下调到 `#96591a`，因为前者白字只有 3.9:1，按钮文案过不了 AA。改动任何一个文字或强调色 token，都要重算这张表。

### 浏览器默认表面

`::selection`、caret、滚动条、`::placeholder`、`accent-color`、下划线偏移都不由组件绘制，但都会出现在界面上。它们在 `globals.css` 中统一接管，不在组件里各写一份。z-index 只有四层：`-1` 窗口背景、`0` 内容、`50` 弹层、`60` 颗粒层（fixed、禁用命中、永不加在滚动容器上）。

---

## 6. 安全

- **最小权限，且权限是逐命令的**：`capabilities/default.json` 目前授予 `core:*`（app / event / window）+ `core:window:allow-start-dragging` / `is-fullscreen` / `set-fullscreen` / `set-theme`、`dialog:allow-open`、`dialog:allow-save`、`deep-link:default`、`opener:allow-open-url`（白名单只放行本仓库与维基百科）。**每个条目必须对应一个真实存在的调用**，并说明理由。
  🔴 两个坑：其一，`dialog:allow-open` **不放行** `save`——该插件没有 `default` 权限集，只能逐条列；被 ACL 拒绝时前端拿到的是 **reject**，于是空 `catch {}` 会让它退化成「按钮没反应」，源码里查不出（`save` 的两个调用点因此共用 `src/hooks/useSavePath.ts` 收口这条接缝）。其二，capability 是**编进 Rust 二进制**的，改完必须重启 dev / 重新打包。
- **不给渲染层 `fs *` / `shell *` / `process *`。**
- **不暴露 `file://`**：资源走 `colorreader://resource/{id}`，由 Rust 校验 id → 路径后流式返回（Phase 2 落地）。
- CSP 已收紧为 `default-src 'self'`，样式允许内联（Tailwind 运行时需要）。

---

## 7. 性能红线

以下属于**架构层约束**，不是调优项：

| 红线                              | 约束                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| 整本书进内存 / React State / DOM  | 禁止。走 Document Model → 章节索引 → 段落索引 → viewport → 虚拟渲染 |
| 主线程同步解析大文件              | 禁止。Rust 侧异步任务 + 进度事件                                    |
| 主线程同步执行 AI 调用            | 禁止。流式事件增量渲染                                              |
| JS `String.includes()` 做全文搜索 | 禁止。用 SQLite FTS5 + BM25                                         |
| 无 Benchmark 支撑的性能结论       | 禁止。所有数字必须实测                                              |
| 主 chunk 超 500 kB                | 禁止。路由级 lazy + vendor 分块（`advancedChunks`）保持告警静默     |

---

## 8. 测试策略

| 层        | 工具                     | 覆盖                                                      |
| --------- | ------------------------ | --------------------------------------------------------- |
| Rust 单元 | `cargo test`             | 解析器、章节识别、文本引擎、搜索、标注、Book Pack、数据库 |
| 前端单元  | Vitest + Testing Library | store、hooks、工具函数                                    |
| 集成      | `cargo test` + Tauri IPC | 导入、数据库、搜索、阅读器                                |
| E2E       | Playwright（Phase 3 起） | 启动 → 导入 → 阅读 → 标注 → 搜索 → 关闭 → 恢复进度        |

---

## 9. 尚未落地（后续阶段）

阶段计划（P0–P14）已全部完成。剩余项集中在下述两档；三项已于此日落地——「标注 + 书签 WebDAV 同步（墓碑）」（见「同步模型」）、「离线基础词典」（见「查词与翻译」）与「自动更新」（见下）——故 P0 只余**代码签名**一项，而它并不阻塞功能。

### P0（发布门槛）

| 主题     | 阻塞点                          | 补齐路径                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 代码签名 | Apple 开发者证书 / Windows 证书 | 证书进 GitHub Secrets，`release.yml` 注入 `APPLE_CERTIFICATE` 等环境变量。**无证书不阻塞功能**：本地 ad-hoc 签名已实测可打包运行；代价只是他人首次打开要绕过一次 Gatekeeper（右键「打开」，或 `xattr -dr com.apple.quarantine`），Windows 侧是 SmartScreen 的「未知发布者」 |

**自动更新已落地**（2026-09-15）。机制是 Tauri 的 updater + process 两个插件：`check()` 读 `plugins.updater.endpoints` 指向的 `latest.json`（GitHub Releases 的 `releases/latest/download/` 路径），验签通过后 `downloadAndInstall()`，再 `relaunch()` 换到新版本。**它的信任根是一对自己生成的 minisign 密钥**（`pnpm tauri signer generate`；公钥钉在 `tauri.conf.json`，私钥只进 GitHub Secrets）——与 Apple / 微软证书无关，所以没有平台证书也能做。

capability 只放行实际用到的三条：`updater:allow-check`、`updater:allow-download-and-install`、`process:allow-restart` —— `relaunch()` 走的是 `plugin:process|restart`，`exit` 没有放行。入口在设置的「关于」区，**只做手动检查**：自动检查需要一个能自己冒出来的通知面（横幅或角标），那个还不存在，而静默到达的更新比读者主动要的更新更糟。

两条必须成对记住的约束：① `releaseDraft` 必须是 `false` —— GitHub 的 `releases/latest` 明确跳过草稿，草稿发布会让已安装的客户端永远查不到东西；② **私钥丢失后，已经装出去的版本再也收不到更新**（只能换密钥 + 让用户手动重装），所以它是必须先备份的机密。

### P1（高价值，中等工作量）

**已清空**（2026-09-19）。

- **StarDict `.syn` 变形词。** 同一批文件里真正被丢掉的一件：`.ifo` 里 `synwordcount=` 声明的第四个文件 `.syn`（`synonym_word\0` + 4 B 的 `.idx` 条目序号）此前既不导入也不查，于是只收 `run` 的词典划 `ran` 落空。落地方式见「查词与翻译」——记录扫描泛化后两侧共用同一个 `Index`，查词加一条支路。🔴 **此日之前导入的词典目录里没有 `variants.syn`，变形词不会追溯生效，要重新导入一次**；`.syn` 本来就比索引小一个量级，只驻留它的偏移表，整本词典的内存代价仍是 4 B/条。

**两项已于此日落地**（2026-09-15）：

- **epub 旧标注 CFI 回填。** 原本写的是「打开时批量反查落库」，实际缺口比想象的小、也更具体：`resolveAnchors` 的过滤条件是「有文本且没有 CFI」，本来就覆盖任何无锚标注，不只是 Kindle 导入。真正坏掉的只有**跳转**这一条 —— `if (annotation.cfi)` 让无锚标注点下去什么也不发生。修法是 `FoliateHandle::goToHighlight`：先用**章的 fraction** 落到那一章（不走 section 序号，因为 foliate 的 section 与导入器的章是两套编号，`rememberFoliateLocation` 那条 fraction 桥才是既有的换算），再轮询 `getContents()` 用文本铸出 CFI、落库、跳过去。铸锚用的是新抽出的 `textAnchor.ts::findInSections`，与 Kindle 导入共用 `indexText` / `findRange`。
- **自定义字体导入**（见「自定义字体」一节）。

### P2（锦上添花）

- 笔记导出到 Anki（`.apkg`）/ Obsidian（`[[wikilink]]`）
- 知识图谱力导向可视化深化（`GraphPanel` 已有基础）
- 金句卡片分享图 · PDF 扫描件 OCR · 快捷键自定义 · 多窗口对照 · i18n（en）

### 明确不做

自建云同步、自建 AI、书源加 HTML 规则（规则语言扩张是维护陷阱）、多用户协作（与 Local First 冲突）。

### 生产化基线（Phase 14）

- **CI**：`.github/workflows/ci.yml`（push/PR 跑 `verify` + Rust 三件套 + bundle size 摘要）、`release.yml`（`v*` tag → tauri-action 四平台 draft release，打包前先跑 Rust 门禁）。
- **打包**：`pnpm tauri build` 本地实测产出 `ColorReader.app`（arm64，ad-hoc 签名，二进制 7.7 MB）；dmg 由 CI 产出。
- **E2E**：`pnpm test:e2e`（Playwright + chromium）对 `vite preview` 的生产构建做路由 smoke：书库 → 搜索 → 设置 → 书库各页渲染且 console/pageerror 为空，懒加载 chunk 加载失败会在此暴露。
- **Benchmark**：`cargo test --release bench -- --ignored --nocapture`（600 章 / 2.7 MB 参考书）：导入（切章 + FTS 索引）60 ms，检索均值 1.3 ms，目录加载 0.6 ms。Apple M 系列、release profile。

> 文档同步备忘：本节的 PDF 段落已据代码实际状态订正（此前写「PDF 不可标注」已失效——文字版 PDF 标注 + 划词问 AI 均已落地）；「同步模型」一节已改写为「进度 + 标注 + 书签」，P0-① 标注/书签同步随之从待办移出。
