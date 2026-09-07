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

| 模块          | 职责                                                                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commands/`   | Tauri 命令，按域分文件（`system.rs` / `book.rs` / `reader.rs` / `annotation.rs` / `search.rs` / `ai.rs` / `rag.rs` / `graph.rs` / `source.rs` / `sync.rs`），在 `lib.rs` 统一注册                                                                                    |
| `db/`         | SQLite 连接（WAL、单写者 `Arc<Mutex<Connection>>`）+ `user_version` 迁移运行器                                                                                                                                                                                       |
| `ai/`         | AI 配置仓储（`settings` KV 表）+ OpenAI 兼容流式聊天客户端（SSE 解析为纯函数）+ embedding 客户端（批量、归一化、f32 序列化）+ rerank 客户端（Cohere 兼容）                                                                                                           |
| `library/`    | 导入管线（去重、文件落盘、元数据提取）+ 书籍仓储（查询 / 统计）+ 章节仓储 + 标注仓储 + 全文检索 + 书档（导入 / 导出 / 加密）+ RAG（组块 / 索引 / 暴力检索）+ 知识图谱（LLM 抽取 / 存储 / 邻域查询）+ 书源（JSON 规则 / 搜索 / 下载）+ WebDAV 同步（进度 / LWW 合并） |
| `document/`   | 七种格式的元数据、封面与章节正文提取：`epub`（OPF / spine）、`pdf`（逐页文本）、`mobi`（PDB 容器 + PalmDOC / HUFF-CDIC + EXTH）、`fb2`（XML，含 `.fb2.zip`）、`cbz`（图片页）、`plain`（TXT / Markdown），`html.rs` 为前三者共用的 HTML → 段落解析器                 |
| `resource.rs` | `colorreader://` 自定义协议：封面图片按 id 从 Rust 流式返回                                                                                                                                                                                                          |
| `error.rs`    | `AppError`：thiserror 定义，实现 `Serialize`，统一转成 `{ message }` 交给前端                                                                                                                                                                                        |
| `state.rs`    | `AppState`（启动时间、数据目录布局、书库句柄），通过 `app.manage` 注入                                                                                                                                                                                               |

### 数据层

SQLite（rusqlite，bundled，WAL）。Schema 通过 `user_version` pragma 做版本化迁移：每个迁移在一个事务里同时执行 DDL 与版本号更新，崩溃只停留在上一个版本；迁移**只增不改**。书库身份键是 `content_hash`（源文件 SHA-256），同时是导入去重键；`sort_title` 在 Rust 侧预计算，避免向 SQLite 注入 collation。

```text
books ─┬─ book_authors ── authors      作者多对多，按 position 保序
       └─ book_tags   ── tags         标签多对多
       └─ chapters                   章节正文（book_id + idx 复合主键，级联删除）
       └─ annotations                标注（book_id 级联删除，chapter_idx + start_char 索引）
       └─ entities / entity_relations 知识图谱（migration v7，book_id 级联删除）

chapters_fts（FTS5 外部内容表，内容指向 chapters，由触发器维护）
```

`chapters` 存的是**已提取的纯文本章节**，不是原始文件字节。主键 `(book_id, idx)` 保证一本书内章节顺序唯一；`chars` 是正文去空白后的字符数，用于进度定位。

### 阅读引擎与进度模型

章节正文在**导入时一次性提取并落库**，阅读阶段不再解析源文件。EPUB 按 OPF spine 顺序逐个 `itemref` 提取，`<head>/<style>/<script>/<svg>/<math>` 丢弃，块级边界切段落、首个标题当章节名；MOBI 是单篇 HTML，走同一个 `html.rs` 解析器按标题切章（超长章按段落边界再切，避免整本一章）；FB2 按 `<body>` 里的 `<section>` 分章；CBZ 每页图片一章；PDF 每页一章；TXT/Markdown 按标题标记（ATX `#` / `第N章` / `Chapter N`）切分，无标记则整本单章。

内嵌图片统一记成带内标记段落（`\u{FFFC}` + 容器内的可寻址名字），阅读时按需经 `book.asset` 取字节：EPUB / CBZ 按 ZIP 条目名，FB2 按 `#<binary id>`（base64 内联），其余格式没有内嵌资源。

**PDF 是唯一的固定版式例外**：阅读器不走文字段落，而是用 pdf.js（懒加载独立 chunk）把每页原样画到 canvas，`book.source_file` 返回整份文件字节。提取的逐页文本仍落库，供全文检索、朗读与 AI 使用，但不负责显示。PDF 排版不走 prose 的 multicol 分栏（页盒画布进分栏必溢出一栏，读起来就是整页空白），由独立的固定高度容器承载。目录面板由 pdf.js `getOutline()` 解析（named dest、`/A` action、UTF-16 标题均已处理，映射到 0-based 页码）；没有书签的 PDF 回退到逐页列表。封面同理由前端渲染第 1 页成 PNG，经 `book.cover_save` 落盘（书库挂载时对缺封面的 PDF 自动补一次）。画布不可划选，标注/划词问 AI 在 PDF 上暂不可用。

阅读器**一次只加载一章**，整本书既不进 React State 也不进 DOM。全局进度 `0..1` 通过 `chars` 前缀和映射到章节与章内比例（`locateChapter` / `globalProgress`），定位时不需要加载任何正文。Phase 3 之前导入的书没有 `chapters` 行，`reader_toc` 在首次读取时用 `ensure_chapters`（`with_tx` 内二次检查，防并发重复插入）惰性补建索引。

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

### AI 助手

Provider 选型收敛为一件事：**OpenAI 兼容的 `/chat/completions`**。Ollama、LM Studio、vLLM 与托管 API 都说这个协议，所以「OpenAI 兼容」不是厂商绑定，而是事实标准；用户只需要改 `base_url`。配置（地址、Key、模型、系统提示词）存 migration v5 引入的 `settings` KV 表——**Key 只存 Rust 侧**，渲染层 localStorage 里放 Key 等于向所有能读 profile 目录的东西公开，而发请求本来也是后端的事。

流式链路：`ai_chat` 发起请求后立即返回，增量文本经 `ai://stream` 事件推送（带 `requestId` 防串台，`done` 事件收尾并可携带错误）。SSE 解析是纯函数 `feed(buffer, chunk)`：跨网络分片可恢复（只消费到最后一个换行），`[DONE]` 终止，解析不了的帧跳过而不是断流。流式循环里区分 `Delta` / `Finish` / `Done` 三类事件，部分 Provider 发完 finish reason 就关连接不发 `[DONE]`，由命令层兜底补发收尾事件。

安全默认值：明文 `http://` 只接受 loopback（`localhost` / `127.0.0.1` / `[::1]`），外网必须 TLS，否则 Key 明文过网。前端侧 `useAiChat` 维持一次一问：新提问替换上一轮问答，过期 `requestId` 的事件直接丢弃。

### RAG 模型

**不用向量数据库扩展，检索是 Rust 里的暴力点积。** 一个个人书库的组块量级是几千而不是几百万（600 章 ≈ 数千块），768 维归一化向量全量扫一遍是毫秒级；sqlite-vec 的加载、版本与平台问题在这个量级下全是纯开销。等数字证明需要 ANN 时再引入，`chunks` 表的形态不会因此改变。

组块：按**段落边界**把章节正文切成约 600 字的块（单段超长则整段一块，不切断句子），`start_char`/`end_char` 与标注、搜索命中同处一个坐标系（章节 joined text 的 UTF-16 偏移）。段落是语义上最干净的切分线，块内不出现 `\n`，命中区间可直接映射到段落。

存储：向量 **L2 归一化后以 f32 LE 字节存 BLOB**，检索退化为点积（即余弦相似度）。`model` 与 `dims` 随行入表并参与过滤——不同模型的向量不在同一个空间，混比是噪声；换向量模型后重建索引即切换空间。

管线：`rag_index_book` 按批（16 条/请求）嵌入并 emit `rag://index-progress`，旧索引与新块同事务替换，失败保留原索引；`rag_chat` 把问题嵌入后取 Top-6（跨书或限单书），编号片段拼进提示词，回答流式推送、引用随 `done` 事件返回，前端点引用按既有 `chapter + offset` 参数跳转。

### 检索重排与朗读

**重排是可选的第二阶段**。重排没有 OpenAI 标准，但 Cohere 的 `/rerank` 线格式成了事实标准（Jina、SiliconFlow 等同型），所以 `rerank_model` 留空即关闭；配置后 `rag_chat` 把第一阶段召回放宽到 Top-24，再由重排模型挑出最终 Top-6。重排失败**直接报错**而不是静默降级：配置错了却每问都「碰巧还能用」，比诚实失败更难排查。

**朗读用 Web Speech API，零后端**。`speechSynthesis` 是浏览器内建的，Tauri 的系统 WebView 直接可用，不引入 TTS 引擎、不调云端语音。实现是一次一段（`SpeechSynthesisUtterance` per paragraph）：段落边界就是天然的进度条，当前段落高亮、滚出视野才跟随滚动；本章读完自动翻章续读，generation 计数器防「cancel 后残留 end 事件重启朗读」的平台怪癖。语速属阅读设置，循环切换、下一句生效。

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

**同步对象只有阅读进度**，以 `content_hash` 为键——同一份书文件在任何设备上哈希相同，天然对齐，无需中央注册表。云端是一个 WebDAV 目录下的单个 `state.json`（结构带 `version` 字段供未来迁移），HTTP 只用三个动词：GET 取状态、PUT 写状态、MKCOL 补缺失的祖先目录。同步凭据存 `settings` KV 表（`sync.webdav`），与 AI Key 同一安全模型：渲染层永不持有；`sync.device_id` 首次同步时生成。

合并是逐本的 LWW 纯函数 `merge`：**两边进度相同视为一致**（不看时间戳，否则每次同步都会因时钟翻新产生无谓重传）；进度不同时时间戳新者胜、平局云端胜（两台设备同一秒写入时收敛而不是来回翻）。每本书的决策（上传 / 下载 / 云端独有 / 一致）随 `sync_now` 返回给 UI 展示。两条安全底线：**云端 JSON 解析失败直接中止同步**——绝不拿本地数据覆盖一个可能恢复的远端；PUT 前只应用「胜出」的值，本地赢时写回的是相同值，不产生回退。标注与书档同步刻意推迟：删除同步需要墓碑机制，复杂度翻倍。

### 导入管线

`book_import` 接收绝对路径数组，`spawn_blocking` 中逐个处理，每个文件完成后向前端 emit `book://import-progress` 事件（`{ done, total, path }`）。单文件流程：读取字节 → SHA-256 → 命中 `content_hash` 即返回 `duplicate` → 按格式解析元数据与封面 → 书籍文件与封面复制进 app data 目录 → 事务写入。三种结果：`imported` / `duplicate` / `failed`，批量结束一次性返回，UI 不因单个失败文件中断。

### 资源协议

封面不经过 `file://`，走 `Builder::register_uri_scheme_protocol` 注册的 `colorreader://`。URL 形态因平台而异（macOS `colorreader://localhost/cover/{id}`，Windows/Linux `http://colorreader.localhost/cover/{id}`），由 `resource::resource_origin()` 在编译期编码，前端只拿后端拼好的 `coverUrl`。处理链：校验 id 形态（UUID 字符集、长度上限、拒绝 `..`）→ 查库定位封面路径 → 读文件按 MIME 返回，非法 id 一律 404。

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

按域分组，点号分隔：

```text
book.*        reader.*      search.*      annotation.*
pack.*        ai.*          rag.*         tts.*         sync.*
settings.*    system.*
```

示例：`system_info`、`book_import`、`reader_chapter`、`search_query`、`annotation_create`、`pack_export`。

Tauri 命令名在 Rust 里是 snake_case，前端通过 `src/lib/ipc.ts` 的单一出口做类型转换，**不散落 `invoke` 调用**。返回值类型镜像在 `src/types/ipc.ts`。

### 事件

统一命名，负载带类型标签：

```text
book.import.progress    { type, bookId, progress }
book.index.progress
ai.stream               { type, conversationId, delta }
tts.progress
sync.progress
download.progress
```

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

- **最小权限**：`capabilities/default.json` 只授予 `core:default`、`core:app`、`core:event`、`core:window` 与 `core:window:allow-start-dragging`。新增权限必须对应一个真实存在的命令，并在 PR 中说明理由。
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

阶段计划（P0–P14）已全部完成，仅剩需要外部凭据的两项：

| 主题     | 阻塞点                          | 补齐路径                                                                  |
| -------- | ------------------------------- | ------------------------------------------------------------------------- |
| 代码签名 | Apple 开发者证书 / Windows 证书 | 证书进 GitHub Secrets，`release.yml` 注入 `APPLE_CERTIFICATE` 等环境变量  |
| 自动更新 | updater 签名密钥与更新源        | `tauri signer generate` 生成密钥，`tauri.conf.json` 开 `updater` 并填公钥 |

### 生产化基线（Phase 14）

- **CI**：`.github/workflows/ci.yml`（push/PR 跑 `verify` + Rust 三件套 + bundle size 摘要）、`release.yml`（`v*` tag → tauri-action 四平台 draft release，打包前先跑 Rust 门禁）。
- **打包**：`pnpm tauri build` 本地实测产出 `ColorReader.app`（arm64，ad-hoc 签名，二进制 7.7 MB）；dmg 由 CI 产出。
- **E2E**：`pnpm test:e2e`（Playwright + chromium）对 `vite preview` 的生产构建做路由 smoke：书库 → 搜索 → 设置 → 书库各页渲染且 console/pageerror 为空，懒加载 chunk 加载失败会在此暴露。
- **Benchmark**：`cargo test --release bench -- --ignored --nocapture`（600 章 / 2.7 MB 参考书）：导入（切章 + FTS 索引）60 ms，检索均值 1.3 ms，目录加载 0.6 ms。Apple M 系列、release profile。
