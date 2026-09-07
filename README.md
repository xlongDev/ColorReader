# ColorReader

> AI Native + Local First + High Performance 的下一代电子书阅读器。

跨平台桌面应用。Rust 负责文本引擎、索引与存储，React 负责交互与呈现，两者之间只走一层类型化的 Tauri IPC。

参考产品能力基准：[ColorTxt](https://github.com/ssnangua/ColorTxt)（仅作为产品与 UX 参考，不复制其代码或架构）。

---

## 当前进度

**Phase 0（项目初始化）至 Phase 14（生产化）全部完成。**

| 能力                                           | 状态 | 阶段     |
| ---------------------------------------------- | ---- | -------- |
| Tauri 2 桌面壳 / 窗口 / 拖拽区                 | ✅   | Phase 1  |
| Liquid Glass 材质与 Design Token               | ✅   | Phase 1  |
| 侧边栏导航 + 折叠                              | ✅   | Phase 1  |
| 命令面板（⌘K）+ 命令注册表 + 快捷键系统        | ✅   | Phase 1  |
| 主题（浅色 / 深色 / 跟随系统）+ 减少透明度     | ✅   | Phase 1  |
| 设置页 + Rust 系统信息 IPC                     | ✅   | Phase 1  |
| Error Boundary + 前端结构化日志                | ✅   | Phase 1  |
| SQLite 书库（WAL + 自动 Migration）            | ✅   | Phase 2  |
| 七种格式导入（SHA-256 去重，见下表）           | ✅   | Phase 2  |
| 元数据解析 + 封面提取（`colorreader://` 协议） | ✅   | Phase 2  |
| 书库 UI（网格 / 搜索 / 排序 / 收藏 / 删除）    | ✅   | Phase 2  |
| 拖拽导入 + 原生文件选择器                      | ✅   | Phase 2  |
| 章节存储与全文提取（migration v2）             | ✅   | Phase 3  |
| Reader Core（章节导航 / 虚拟渲染 / 进度续读）  | ✅   | Phase 3  |
| 标注（划词高亮 / 列表 / 删除，migration v3）   | ✅   | Phase 4  |
| 全文检索（FTS5 + BM25 / 书库与书内搜索）       | ✅   | Phase 5  |
| Book Pack `.ctz` 导出 / 导入（含阅读状态）     | ✅   | Phase 6  |
| Book Pack `.ctzx` 加密（Argon2id + AES-GCM）   | ✅   | Phase 6  |
| AI 阅读助手（OpenAI 兼容 / 流式 / 划词问答）   | ✅   | Phase 7  |
| RAG（组块索引 / 全库检索问答 / 引用跳转）      | ✅   | Phase 8  |
| 知识图谱（实体 / 关系抽取 / 邻域查询）         | ✅   | Phase 9  |
| 检索重排（Cohere 兼容 `/rerank`，可选）        | ✅   | Phase 10 |
| 朗读 TTS（Web Speech / 逐段高亮 / 自动跨章）   | ✅   | Phase 10 |
| 书源插件（JSON 规则 / 搜索 / 下载进书架）      | ✅   | Phase 11 |
| WebDAV 进度同步（逐本 LWW / 冲突决策回报）     | ✅   | Phase 12 |
| 性能与代码分割（路由 lazy / vendor 分块）      | ✅   | Phase 13 |
| 生产化（CI / 多平台打包 / E2E / Benchmark）    | ✅   | Phase 14 |

### 支持的格式

| 格式        | 扩展名                        | 正文来源                                       | 元数据               | 内嵌图片 |
| ----------- | ----------------------------- | ---------------------------------------------- | -------------------- | -------- |
| EPUB        | `.epub`                       | OPF spine 顺序                                 | Dublin Core / OPF    | ✅       |
| PDF         | `.pdf`                        | pdf.js 固定版式渲染 + 逐页文本（检索/朗读/AI） | Info 字典 + 书签目录 | ✅       |
| MOBI / AZW3 | `.mobi` `.azw` `.azw3` `.prc` | 单篇 HTML，按标题切章                          | EXTH（含 KF8 回退）  | 封面     |
| FB2         | `.fb2` `.fb2.zip`             | `<body>` 的 `<section>`                        | `<title-info>`       | ✅       |
| CBZ 漫画    | `.cbz`                        | 每页一张图                                     | 文件名               | ✅       |
| Markdown    | `.md` `.markdown`             | ATX 标题切分                                   | 首个标题             | ❌       |
| TXT         | `.txt`                        | `第N章` 标记切分                               | 文件名               | ❌       |

PDF 按固定版式渲染（pdf.js，每一页所见即所得，字体与插图原样重现），书签目录由 pdf.js 解析文档 outline；封面自动取第 1 页；提取出的逐页文本供全文检索、朗读与 AI 使用。纯扫描件仍只有图片页，没有文字层可供检索。

Phase 2 交付物是**一个可用的书库**：把上表的文件拖进窗口或通过选择器导入，Rust 侧解析元数据与封面、写入 SQLite，前端以 TanStack Query 展示网格，支持搜索、排序、收藏与删除。

Phase 3 交付物是**一个可用的阅读器**：导入时一次性提取并落库章节正文（EPUB 走 spine 顺序，TXT/Markdown 按标题切分），阅读时按章节懒加载正文、段落虚拟化渲染，支持字号调节、`← →` 翻章与全局进度续读（按字数定位，续读不加载整本书）。

Phase 4 交付物是**一个可用的标注系统**：划词选中正文后浮出「高亮」按钮，高亮以字符区间锚定在不可变的章节文本上（UTF-16 偏移，前端计算、后端不透明存储），正文内联高亮渲染，侧栏按章节列出全部标注并支持删除。

Phase 5 交付物是**一个可用的全文检索**：章节正文上建 FTS5 外部内容索引（trigram 分词，中文子串也能命中），按 BM25 排序。书库侧提供「全文检索」页（侧边栏与 ⌘K 均可进入），书内提供搜索抽屉；命中结果带上下文片段，点击直接跳到对应章节并把命中段落滚动到视野中间，章节内所有匹配与标注一起高亮。查询不足 3 字时自动退回 `LIKE` 子串匹配。

Phase 6 交付物是**一个可搬家的书档**：一本书连同阅读进度、收藏与全部标注导出成单个 `.ctz` 文件；选择加密则写成 `.ctzx`，用 Argon2id 从密码派生密钥、AES-256-GCM 加密，KDF 参数与 salt 作为 GCM 的附加数据参与校验。书档只装原文件与阅读状态，章节和封面不打包，导入时由既有管线重新提取，所以不存在两份数据对不上的可能。导入加密书档会先要密码，重复导入同一份书档不会复制标注。

Phase 7 交付物是**一个 AI 阅读助手**：设置里配置任意 OpenAI 兼容端点（托管 API 或本地 Ollama / LM Studio），API Key 只存本地 SQLite、不进渲染层。阅读器内划词点「问 AI」针对片段提问，不带引用则附上整章；回答经 SSE 流式推送逐字渲染，一次一问，失败原因直说（Key 被拒 / 限流 / 服务端错）。

Phase 8 交付物是**全书检索问答（RAG）**：设置里填上向量模型后，可对任意一本书建立组块索引（按段落边界切成约 600 字的块，嵌入归一化后存 SQLite），AI 抽屉开启「检索全书库」即以问题向量对全库做暴力点积取 Top-6，作为上下文流式回答并附编号引用，点引用直接跳到对应书的对应章节位置。

Phase 9 交付物是**本书知识图谱**：阅读器侧边栏新增「知识图谱」面板，一键由 AI 逐章抽取实体（人物 / 地点 / 组织等）与关系（关系短语 + 原文证据句），实体按出现次数排序，点实体看它的全部关系，点关系直接跳到证据所在章节。抽取复用已配置的 AI 端点，进度实时汇报，中途失败保留旧图谱。

Phase 10 交付物是**检索重排与朗读**：设置里可选填重排模型（Cohere 兼容 `/rerank`），全书检索问答会先放宽召回再精排，命中更准；失败直接报错而非静默降级。朗读基于浏览器内建的 Web Speech API，底栏一键从本章头开始读，逐段高亮跟随、语速循环切换、读完自动翻章续读，无任何后端依赖。

Phase 11 交付物是**在线找书（书源插件）**：书架新增「在线找书」入口，书源是一份用户可编辑的 JSON 规则（迷你 JSONPath 子集 `$.a.b[*].c`），描述一个网站 JSON 接口的搜索、详情、章节列表与正文取法。搜索结果一键下载，Rust 逐章抓取拼成带「第N章」标记的 TXT，走既有导入管线（去重、哈希、切章全部复用），进度逐章汇报，下载完成直接跳书架。

Phase 12 交付物是**WebDAV 进度同步**：设置里配置任意 WebDAV 服务（坚果云、InfiniCloud 等），阅读进度以 `content_hash` 为键同步到云端单个 `state.json`，同一本书在多台设备间自动对齐。冲突按书逐本解决：两边进度相同视为一致，不同时时间戳新者胜、平局云端胜，每一本的决策（上传 / 下载 / 云端独有 / 一致）都会在同步结果里列出，绝不静默覆盖；云端文件解析失败时直接中止同步，绝不拿本地数据覆盖一个可能恢复的远端。凭据只存本地 SQLite。

Phase 13 交付物是**性能与代码分割**：主 chunk 从 719 kB 降到 285 kB（gzip 87 kB），消除 500 kB 告警。手段有三：阅读器 / 搜索 / 设置三个页面路由级 `React.lazy`，按需从本地磁盘加载；书架的重对话框（在线找书、书档导入导出）拆成独立 chunk，首次打开才加载；react-dom 与路由 / react-query 两个稳定 vendor 块单独成 chunk，只在依赖升级时失效，浏览器缓存长期命中。

Phase 14 交付物是**生产化**：GitHub Actions 双工作流（CI 全门禁 + tag 触发 tauri-action 多平台打包，产物为 draft release）；本地实测 `tauri build` 产出 ColorReader.app（arm64，ad-hoc 签名，7.7 MB 二进制）；Playwright E2E smoke（`pnpm test:e2e`）对生产构建验证四个路由渲染且零 console 错误，专防懒加载分包崩坏；可重复的 release 基准测试（600 章 / 2.7 MB 参考书）：导入含切章与 FTS 索引 60 ms、全文检索均值 1.3 ms、目录加载 0.6 ms。**代码签名与自动更新暂缓**：需要 Apple 开发者证书与 updater 签名密钥，工作流里已留好注入点，密钥到位后按 release.yml 注释补两步即可。

---

## 技术栈

| 层         | 选型                                         | 说明                                             |
| ---------- | -------------------------------------------- | ------------------------------------------------ |
| 桌面运行时 | **Tauri 2**                                  | 不用 Electron，不引入 Node 作为桌面 Runtime      |
| 后端       | **Rust**（edition 2024，MSRV 1.88）          | 文本引擎、解析、索引、搜索、文件 IO              |
| 前端       | **React 19** + **TypeScript 7** + **Vite 8** | 只用函数组件与 Hooks                             |
| 样式       | **Tailwind CSS v4**                          | 自建 Design Token 与材质层，不套用现成组件库视觉 |
| UI 状态    | **Zustand**                                  | UI / 阅读器 / 设置 / 导航状态                    |
| 异步数据   | **TanStack Query**                           | 所有 Tauri IPC 数据、库查询、搜索、AI            |
| 动画       | **Motion**                                   | 短、轻、自然；统一尊重 `prefers-reduced-motion`  |
| 测试       | **Vitest** + Testing Library / `cargo test`  |                                                  |
| 包管理     | **pnpm**                                     |                                                  |

---

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 挂载 git hooks（clone 后只需一次）
pnpm hooks

# 3. 浏览器模式：只跑前端，IPC 会降级为浏览器兜底数据
pnpm dev

# 4. 桌面模式：完整 Tauri 壳 + 真实 Rust IPC
pnpm tauri dev
```

要求：Node 22+、pnpm 10+、Rust 1.88+。macOS 还需要 Xcode Command Line Tools。

---

## 常用脚本

| 命令               | 作用                                               |
| ------------------ | -------------------------------------------------- |
| `pnpm dev`         | Vite 开发服务器（浏览器模式）                      |
| `pnpm tauri dev`   | 启动 Tauri 桌面窗口                                |
| `pnpm build`       | `tsc --noEmit` + `vite build`                      |
| `pnpm typecheck`   | TypeScript 严格模式检查                            |
| `pnpm lint`        | oxlint（0 warning / 0 error 为通过标准）           |
| `pnpm test`        | Vitest 单元测试                                    |
| `pnpm format`      | Prettier 格式化                                    |
| `pnpm verify`      | typecheck + lint + test + build                    |
| `pnpm verify:rust` | rustfmt 检查 + clippy（`-D warnings`）+ cargo test |
| `pnpm verify:all`  | 前端门禁 + Rust 门禁                               |
| `pnpm tauri build` | 打包当前平台安装包                                 |

Rust 侧也提供 `pnpm rust:check`、`pnpm rust:fmt`、`pnpm rust:lint`、`pnpm rust:test`。

---

## 目录结构

```text
.
├── src/                        # React 渲染层
│   ├── app/                    # providers（Query / Motion / Theme）、路由
│   ├── components/
│   │   ├── glass/              # 材质原语：Surface / Panel / Button / Input / Overlay / Sidebar
│   │   ├── layout/             # AppShell / TitleBar / NavList
│   │   ├── command/            # 命令面板 UI
│   │   ├── brand/              # 品牌标识
│   │   └── common/             # EmptyState 等通用件
│   ├── features/               # 按业务领域组织（library / reader / search / ai / settings ...）
│   ├── hooks/                  # useTheme / useHotkeys / useSystemInfo / useReader / useAnnotations / useSearch / useAi / useRag / useGraph / useSource
│   ├── lib/                    # cn / ipc / commands（命令评分）
│   ├── stores/                 # Zustand：settings / commands / command-palette / reader
│   ├── styles/                 # globals.css = Design Token + 材质层
│   └── types/ipc.ts            # Rust 命令返回值的镜像类型
└── src-tauri/
    ├── src/
    │   ├── commands/           # Tauri 命令（按域分文件：system / book / reader / annotation / search）
    │   ├── library/            # 导入 / 仓储 / 章节 / 标注 / 检索 / 书档
    │   ├── error.rs            # AppError：类型化 + 可序列化
    │   ├── state.rs            # 全局 AppState
    │   └── lib.rs              # 应用装配与 tracing 初始化
    └── capabilities/           # 最小权限集合
```

架构约定、IPC 命名规范与性能红线见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**，开发流程与提交规范见 **[CONTRIBUTING.md](./CONTRIBUTING.md)**。

---

## 许可

尚未确定，暂按私有项目处理。
