# ColorReader

> AI Native · Local First · High Performance 的跨平台电子书阅读器。

[![CI](https://github.com/xlongDev/ColorReader/actions/workflows/ci.yml/badge.svg)](https://github.com/xlongDev/ColorReader/actions/workflows/ci.yml)
![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.88-000000?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)

桌面应用。**Rust 负责文本引擎、解析、索引与存储，React 负责交互与呈现，两者之间只走一层类型化的 Tauri IPC**——命令签名由 Rust 生成 TypeScript 绑定，漏掉一处接线 `tsc` 就报错，不会静默漂移。

三条贯穿全局的取舍：

- **Local First** —— 书、标注、进度、词典、字体都在本机。联网能力（AI、翻译、WebDAV 同步、自动更新）全部可选，一个都不配也照样读。
- **不打包任何数据集** —— 查词先问系统词典，再问读者自己导入的 StarDict / MDict，都不收录才交给 AI。所以「离线查词」不等于「附带几百 MB 词典」。
- **整本书不进 React** —— 阅读器只持有当前 viewport 与相邻 buffer，正文提取、切章与索引留在 Rust。

---

## 目录

- [能力](#能力) · [支持的格式](#支持的格式) · [技术栈](#技术栈)
- [快速开始](#快速开始) · [常用脚本](#常用脚本) · [质量门禁](#质量门禁) · [发布与部署](#发布与部署)
- [目录结构](#目录结构) · [文档](#文档) · [许可](#许可)

---

## 能力

### 阅读

| 能力                                       | 说明                                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 七种格式导入（SHA-256 去重）               | EPUB / PDF / MOBI / AZW3 / FB2 / CBZ / Markdown / TXT，拖进窗口或走选择器；同一份文件重复导入只留一本                 |
| 阅读器（paged / scroll 双模式）            | 分页与滚动可切换，字号、行距、段距、缩进、页边距均可调；进度按字数定位，续读不加载整本书                              |
| 自定义字体                                 | 导入 .ttf / .otf / .ttc / .woff / .woff2，经 `/font/{id}` 资源协议加载。**不内置字体**（体积与许可各自独立）          |
| 主题（浅色 / 深色 / 跟随系统）             | 外加「减少透明度」；所有动效统一尊重 `prefers-reduced-motion`                                                         |
| 划词标注 + 笔记                            | 高亮以 UTF-16 字符区间锚定在不可变的章节文本上（EPUB 走 CFI），可加笔记、侧栏按章列出、批量删除                       |
| 书签                                       | 独立于标注的阅读位置标记                                                                                              |
| 朗读（双引擎）                             | 系统 `speechSynthesis`（离线）与 **Edge TTS**（默认音色 Yunjian）；逐段高亮跟随、读完自动翻章，语速改动从当前位置重播 |
| 划词查词                                   | 平台词典 → 导入的本地词典 → AI 兜底，前两级全离线免 Key；StarDict 的 `.syn` 变形词也查（划 `ran` 能落到 `run`）       |
| 划词翻译 / 维基百科                        | DeepL 与 Wikipedia REST；没配 Key 时翻译与词典共用同一个 AI 流式回答                                                  |
| 深链 `colorreader://book/<id>?annotation=` | 三种位置模型（CFI / 章+偏移 / 页码）通解；Windows / Linux 由 single-instance 把第二进程的 argv 交给先到实例           |

### 书库

| 能力                            | 说明                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 书库 UI                         | 网格 / 搜索 / 排序（七档 × 升序降序）/ 分组（阅读状态 / 作者 / 格式，分节头可折叠）/ 收藏 / 标签 / 多选批量操作，滚动位置跨路由记忆 |
| 元数据与封面                    | Rust 侧解析并提取，封面走 `colorreader://` 协议；导入后仍可**手动纠正**书名 / 作者 / 出版社 / 语言 / 简介                           |
| 命令面板（⌘K）                  | 按书名 / 作者 / 标签搜书并打开，「继续阅读」跳到最近在读的那本                                                                      |
| 书源插件（在线找书）            | 一份用户可编辑的 JSON 规则（迷你 JSONPath 子集）描述一个网站接口的搜索 / 详情 / 章节 / 正文取法；下载后走既有导入管线               |
| Kindle 标注导入（My Clippings） | 按高亮文本在已入库正文里锚定 UTF-16 区间并回填标注                                                                                  |
| 阅读统计                        | 时长 / 进度 / 标注数与连续天数                                                                                                      |

### 检索与 AI

| 能力             | 说明                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 全文检索         | FTS5 外部内容索引（trigram 分词，中文子串也能命中）+ BM25 排序；书库侧与书内抽屉两处入口，查询不足 3 字自动退回 `LIKE` 子串匹配 |
| AI 阅读助手      | 任意 OpenAI 兼容端点（托管 API 或本地 Ollama / LM Studio），SSE 流式；划词问答、章节导读                                        |
| RAG 全书库问答   | 段落边界切块 + 向量暴力点积 Top-6，附编号引用，点引用直接跳到对应书的对应位置                                                   |
| 检索重排（可选） | Cohere 兼容 `/rerank`：先放宽召回再精排。**失败直接报错**而非静默降级                                                           |
| 知识图谱         | 由 AI 逐章抽实体与关系（附原文证据句），点实体看关系、点关系跳证据所在章节                                                      |

### 数据

| 能力                 | 说明                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Book Pack `.ctz`     | 一本书连同进度、收藏与全部标注导出成单个文件；只装原文件与阅读状态，章节与封面由既有管线重新提取，所以不存在两份数据对不上的可能     |
| 加密书档 `.ctzx`     | Argon2id 派生密钥 + AES-256-GCM，KDF 参数与 salt 作为 GCM 的附加数据参与校验                                                         |
| 笔记导出（md / csv） | 带回本应用深链                                                                                                                       |
| WebDAV 同步          | 进度 / 标注 / 书签同步到云端单个 `state.json`；进度按 `content_hash` 对齐，冲突 LWW + 墓碑传播，云端解析失败**直接中止**而不覆盖本地 |
| 全库备份 / 恢复      | 数据目录原样打包 zip（含书文件、词典、字体与阅读记录）；恢复在**重启时**替换，被替换的书库留在 `-previous` 目录                      |

### 平台

| 能力              | 说明                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| 自动更新          | Tauri updater + process，读 GitHub Releases 的 `latest.json`；签名用**自生成**的 minisign 密钥，不需要平台证书 |
| 单实例 + 深链合流 | 第二个进程把 argv 交给先到实例                                                                                 |

---

## 支持的格式

| 格式        | 扩展名                        | 正文来源                                       | 元数据               | 内嵌图片 |
| ----------- | ----------------------------- | ---------------------------------------------- | -------------------- | -------- |
| EPUB        | `.epub`                       | OPF spine 顺序                                 | Dublin Core / OPF    | ✅       |
| PDF         | `.pdf`                        | pdf.js 固定版式渲染 + 逐页文本（检索/朗读/AI） | Info 字典 + 书签目录 | ✅       |
| MOBI / AZW3 | `.mobi` `.azw` `.azw3` `.prc` | 单篇 HTML，按标题切章                          | EXTH（含 KF8 回退）  | 封面     |
| FB2         | `.fb2` `.fb2.zip`             | `<body>` 的 `<section>`                        | `<title-info>`       | ✅       |
| CBZ 漫画    | `.cbz`                        | 每页一张图                                     | 文件名               | ✅       |
| Markdown    | `.md` `.markdown`             | ATX 标题切分                                   | 首个标题             | ❌       |
| TXT         | `.txt`                        | `第N章` 标记切分                               | 文件名               | ❌       |

EPUB / MOBI / AZW3 走 vendored [foliate-js](./THIRD-PARTY-NOTICES.md) 渲染，其余由 Rust 纯文本管线处理，两侧共用同一份章节语料。PDF 按固定版式渲染（每一页所见即所得），封面取第 1 页，提取出的逐页文本供检索、朗读与 AI 使用——**纯扫描件仍只有图片页**，没有文字层可供检索。

---

## 技术栈

| 层         | 选型                                                         | 说明                                           |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------- |
| 桌面运行时 | **Tauri 2**                                                  | 不用 Electron，不引入 Node 作为桌面 Runtime    |
| 后端       | **Rust**（edition 2024，MSRV 1.88）                          | 文本引擎、解析、索引、搜索、文件 IO            |
| 前端       | **React 19** + **TypeScript 7**                              | 只用函数组件与 Hooks                           |
| 构建       | **Vite 8**                                                   | 路由级 `lazy` + 手工 vendor 分块               |
| 样式       | **Tailwind CSS v4**                                          | 自建 Design Token 与材质层，不套现成组件库视觉 |
| UI 状态    | **Zustand**                                                  | 交互 / 阅读器 / 设置 / 导航状态                |
| 异步数据   | **TanStack Query**                                           | 全部 Tauri IPC 数据、库查询、搜索、AI          |
| 动画       | **Motion**                                                   | 短、轻、自然                                   |
| 数据库     | **SQLite**（WAL）+ FTS5                                      | 单连接单写者；跨表写入一律走事务               |
| 测试       | **Vitest** + Testing Library · `cargo test` · **Playwright** | 见[质量门禁](#质量门禁)                        |
| 包管理     | **pnpm**                                                     |                                                |

---

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 挂载 git hooks（clone 后只需一次）——pre-commit 跑 prettier + oxlint + tsc + rustfmt + clippy
pnpm hooks

# 3. 桌面模式：完整 Tauri 壳 + 真实 Rust IPC
pnpm tauri dev

# 4. 纯前端模式：只跑 Vite，IPC 降级为浏览器兜底数据
pnpm dev        # 加 ?demo=1 得到一份样本书架（?demo=1&books=84 可放大到 84 本）
```

要求：**Node 22+、pnpm 11+、Rust 1.88+**；macOS 另需 Xcode Command Line Tools，Linux 需要 webkit2gtk / gtk 等打包依赖（见 `.github/workflows/ci.yml`）。

> 浏览器模式只是 UI 预览：没有后端，导入、foliate 渲染、PDF、搜索与书签都用不了。要看真东西请用 `pnpm tauri dev`。

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
| `pnpm test:e2e`    | Playwright（chromium **与** webkit 两个 project）  |
| `pnpm format`      | Prettier 格式化                                    |
| `pnpm verify`      | typecheck + lint + test + build（前端门禁）        |
| `pnpm verify:rust` | rustfmt 检查 + clippy（`-D warnings`）+ cargo test |
| `pnpm verify:all`  | 前端门禁 + Rust 门禁                               |
| `pnpm tauri build` | 打包当前平台安装包                                 |

Rust 侧另有 `pnpm rust:check` / `rust:fmt` / `rust:lint` / `rust:test`。

---

## 质量门禁

四项全绿才算通过，CI 与本地钩子跑的是同一套：

| 项           | 规模                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `tsc`        | 严格模式，0 错误                                                                |
| `oxlint`     | 0 warning / 0 error（错误逐条修，不降级、不加白名单）                           |
| Vitest       | **356** 用例 / 39 文件                                                          |
| `cargo test` | **400** 用例（解析器、章节识别、文本引擎、搜索、标注、Book Pack、数据库、词典） |
| Playwright   | **41** 用例 × 2 引擎 = 82 次运行                                                |
| bundle       | 入口 chunk **254 kB**（gzip 75 kB），Vite 的 500 kB 告警线内                    |

e2e 两个引擎是刻意的：**WebKit 正是 Tauri 实际渲染用的引擎**，只装 chromium 会让 webkit 那组起不来，等于没测。

Rust 侧硬约束：数据库是**单连接单写者**，所以解析、哈希、网络必须在拿锁之前做完；跨多表写入一律走事务；生产路径禁用 `unwrap` / `expect`。详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 发布与部署

| 工作流                               | 触发           | 产物                                                                                                     |
| ------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`           | push main / PR | Frontend gates（`verify` + e2e 双引擎）与 Rust gates；失败时把 e2e 原文写成 annotation 并上传 trace 制品 |
| `.github/workflows/deploy-pages.yml` | push main      | **纯前端预览站**部署到 GitHub Pages（无后端，`?demo=1` 提供样本书架）                                    |
| `.github/workflows/release.yml`      | `v*` tag       | 四平台安装包（macOS arm64 / macOS x86_64 / Linux / Windows）+ `latest.json` 自动更新清单                 |

打包时 `releaseDraft` 必须是 `false`：更新端点指向 `releases/latest/download/latest.json`，而 GitHub 的 `latest` 明确跳过草稿，草稿发布会让已安装的客户端永远查不到更新。

### 两个必须先备份的机密

- `TAURI_SIGNING_PRIVATE_KEY`（+ 密码，留空即空）——更新签名的私钥。**丢了它，已经装出去的版本再也收不到更新**，只能换密钥并让用户手动重装。
- **平台代码签名尚未做**（没有 Apple / Windows 证书）。产物在 macOS 上是 ad-hoc 签名，代价只是他人首次打开要绕过一次 Gatekeeper（右键「打开」，或 `xattr -dr com.apple.quarantine`），Windows 侧是 SmartScreen 的「未知发布者」。它不阻塞功能。

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
│   │   ├── motion/             # 封面飞行等共享动效件
│   │   ├── brand/              # 品牌标识
│   │   └── common/             # EmptyState 等通用件
│   ├── features/               # 按业务领域组织：library / reader / search / notes / graph / settings / source / stats / command
│   ├── hooks/                  # 29 个 hook：IPC 查询、热键、主题、朗读、手势……
│   ├── lib/                    # cn / ipc（IPC 单一出口）/ bindings.ts（Rust 生成）/ demo.ts
│   ├── stores/                 # Zustand：settings / commands / command-palette / reader / chrome / toasts / book-handoff
│   ├── styles/                 # globals.css = Design Token + 材质层
│   └── types/ipc.ts            # Rust 返回值的转出与少量别名
├── src-tauri/
│   ├── src/
│   │   ├── commands/           # 71 个 Tauri 命令，按域分文件（book / reader / annotation / search / ai / rag / graph / source / sync / dictionary / font / tts …）
│   │   ├── db/                 # SQLite 连接与迁移（WAL、单写者）
│   │   ├── document/           # 七格式的元数据 / 封面 / 章节提取（epub / pdf / mobi / fb2 / cbz / html / plain）
│   │   ├── ai/                 # AI 配置仓储 + 流式聊天 / embedding / rerank 客户端
│   │   ├── library/            # 导入 / 仓储 / 章节 / 标注 / 检索 / 书档 / RAG / 图谱 / 书源 / WebDAV 同步 / 词典（stardict + mdict）
│   │   ├── dictionary.rs       # macOS 平台词典（DictionaryServices FFI）
│   │   ├── tts.rs              # Edge TTS：WebSocket + Sec-MS-GEC 签名
│   │   ├── resource.rs         # colorreader:// 协议（封面 / 书源文件 / 字体）
│   │   ├── error.rs            # AppError：类型化 + 可序列化
│   │   ├── state.rs            # 全局 AppState
│   │   └── lib.rs              # 应用装配与 tracing 初始化
│   ├── capabilities/           # 最小权限集合
│   └── tests/fixtures/         # 第三方写入器产出的 MDict 夹具（正确性不靠自我印证）
└── e2e/                        # Playwright，19 个 spec
```

---

## 文档

| 文档                                               | 内容                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)               | 分层、数据模型、IPC 契约、Design System、安全、性能红线、尚未落地 |
| [CONTRIBUTING.md](./CONTRIBUTING.md)               | 分支模型、提交规范、代码规范、新增 IPC 命令的步骤                 |
| [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) | 第三方组件与许可                                                  |

---

## 许可

**AGPL-3.0-or-later**，见 [LICENSE](./LICENSE)。第三方组件许可见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
