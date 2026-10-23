# ReqHub — 需求中心

> DeepSeek Harness 插件：需求文档管理、AI 分析、文档同步、需求追溯

## 1. 插件定位

ReqHub 是面向 **DeepSeek Harness（DSH）** 的需求管理插件，解决以下核心问题：

- **需求文档散落** — 需求文档、技术方案、CR 记录分散在代码仓库中，缺乏统一管理
- **代码与文档脱节** — 代码变更后，需求文档没有同步更新，导致文档过期
- **需求追溯困难** — 无法快速定位某个功能点对应的需求文档和代码变更
- **AI 分析缺失** — 需求文档缺乏结构化元数据（功能点、字段、标签），无法智能搜索

ReqHub 将需求文档组织为 **开发者 → 需求 → 文件** 三级目录结构，支持代码变更同步到文档，并从选中文件构建工作区知识库，以全文检索查找知识与来源。

---

## 2. 功能概览

### 2.1 需求目录管理

- **三级目录树**：开发者 → 需求（日期-标题）→ 文档文件
- **Git 分支自动解析**：从 `feature/<开发者>/<日期>-<标题>` 格式分支名自动创建需求目录
- **多工作区支持**：切换不同 DSH 工作区，每个工作区独立管理需求文档
- **文件预览**：支持 Markdown、HTML、TXT 文件预览，含 Mermaid 图表和代码高亮

### 2.2 工作区知识库

- **独立入口**：侧边栏点击“知识库”；与“查看”复用同一文件树、筛选、排序、拖宽和预览组件。
- **跨需求多选**：点击文件行预览，复选框选择文件；切换需求目录保留选择，切换工作区清空选择。目录勾选只作用于当前筛选结果，隐藏选择保留。
- **显式分析**：在右侧点击“分析（N）”，本地解析选中文件并将完整正文入库。无需模型、子代理或活跃会话。仅处理选中文件，支持 MD/TXT/TEXT/HTML/HTM/JSON，每次最多 200 个文件，每个文件最多 2 MiB。
- **增量与恢复**：已成功且内容/分析配置未变的文件跳过；支持取消、部分失败重试、刷新恢复进度，重启后的未完成任务标记为中断。已发布的成功文件保留。
- **文档与版本**：按文件路径分别保存完整正文、来源和版本；同名文件及内容差异独立保留，更新时替换该文件全文并同步更新索引。
- **存储**：所有工作区共用 `<DSH_HOME>/req-hub/knowledge/knowledge.sqlite`（未设置 DSH_HOME 时为 `~/.dsh/req-hub/knowledge/knowledge.sqlite`），采用 SQLite FTS5；同目录 `documents/` 保存带来源元数据的 Markdown 正文副本。数据库是内容、版本与任务的权威来源，Markdown 副本可在启动时恢复，不直接编辑回写源文件。旧工作区数据库直接删除，不迁移、不适配，源文件不删除。需要 Node.js ^22.19.0 或 >=24.0.0，并支持 `node:sqlite` 和 FTS5。
- **参考移植**：存储、检索与版本设计来自 dsh-knowledge 2.15.4，保留 [MIT 许可与来源说明](src/server/knowledge/NOTICE.md)。知识库数据已从 Git 默认跟踪范围排除。

### 2.3 文档同步

- **基准分支**：默认检查本地 `main`，不存在则使用 `master`，均不存在时提示手动填写。
- **Commit 多选**：列出目标分支相对基准分支独有的提交，默认全选，支持筛选、勾选、全选/清空；实际同步使用所选提交的差异。分支更新后需刷新列表。未提交改动可单独选择是否包含。

- **分阶段同步**：代码差异分析 → 会话提取 → 讨论差异分析 → 增量合并 → 保存文件
- **Git 代码差异**：自动分析分支与基准分支的代码变更
- **DSH 会话集成**：提取相关 DSH 会话的对话内容，分析讨论差异
- **增量合并**：AI 将代码变更智能合并到现有文档，而非覆盖
- **同步历史**：记录每次同步的完整过程和结果，支持回溯查看
- **构建分析 & 索引**：同步完成后可选执行 AI 分析和搜索索引重建

### 2.4 搜索

- **独立搜索入口**：点击侧边栏“搜索”或 Ctrl/Cmd+K，搜索整个知识库，覆盖统一数据库中所有已入库文档，不受当前工作区限制。
- **本地全文检索**：FTS5 候选、中文关键词补召回和相关性排序；无需活跃会话或模型调用。直接查询同一数据库，所有文档统一排序，显示更多时最多 100 条，达到上限可收窄查询。部分工作区不可用时保留其他结果并提示检索不完整。
- **知识与来源**：结果标明所属工作区，详情、版本及原文件按来源工作区读取；来源被修改会标注过期，已删除或不可读的唯一来源不会继续参与搜索。
- **工作台仅保留索引**：旧需求元数据和索引接口保留兼容，工作台不再提供分析、搜索页签。旧 `.meta.json` / `docs/.index/search-index.json` 与新知识库相互独立。

更新插件源码后请重新加载/重启对应 DSH 插件进程，使新增服务端知识库路由注册生效；`npm run build` 生成客户端产物。知识库可重建，备份时应连同 SQLite 数据库及其 WAL 一起处理，建议先停止插件再备份。

### 2.5 模板生成

- **三种模板**：需求文档、技术方案、CR 记录
- **AI 辅助生成**：基于模板和上下文自动生成文档内容
- **预览与编辑**：生成后可预览和编辑

### 2.6 需求追溯

- **时间线视图**：展示需求从创建到同步的完整时间线
- **会话关联**：查看与需求相关的 DSH 会话
- **文件变更追踪**：追踪需求文档的历次变更

### 2.7 其他功能

- **日志系统**：分类日志（级别 + 标签），实时查看和过滤
- **技能浏览**：查看 DSH 技能列表和内容预览
- **设置管理**：AI 配置、模型选择、Prompt 模板管理
- **文件树侧边栏**：可拖拽调整宽度的文件列表，支持按类型过滤和排序

---

## 3. 架构

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    DeepSeek Harness                      │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │   Client     │    │   Server     │                   │
│  │  (Browser)   │◄──►│  (Node.js)   │                   │
│  │              │    │              │                   │
│  │  React UI    │    │  HTTP Routes │                   │
│  │  25 组件     │    │  42 路由     │                   │
│  │  CJS 格式    │    │  ESM 格式    │                   │
│  └──────┬───────┘    └──────┬───────┘                   │
│         │                   │                            │
│         │         ┌─────────▼─────────┐                 │
│         │         │   服务层 (14 模块)  │                 │
│         │         │  ai-engine, sync,  │                 │
│         │         │  tree, index, ...  │                 │
│         │         └────────────────────┘                 │
│         │                   │                            │
│         │         ┌─────────▼─────────┐                 │
│         │         │   文件系统          │                 │
│         │         │  docs/<dev>/<req>/ │                 │
│         │         │  sync-logs/        │                 │
│         │         │  .meta.json        │                 │
│         │         └────────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

### 3.2 客户端架构

```
src/client/
├── index.js              # Cordis 插件入口（注册 Tab、Slot、触发按钮）
├── constants.js          # 常量定义（路由前缀、Tab ID、脚本 ID）
├── context.js            # React Context（跨组件通信）
├── icons.js              # SVG 图标系统（38+ 图标，工厂模式）
├── styles/               # 6 个 CSS 文件（tokens/base/layout/components/markdown/animations）
├── components/           # 25 个 React 组件
│   ├── DocsViewerBody.js # 主布局容器（三区域布局）
│   ├── FileTreeSidebar.js# 文件树侧边栏（可拖拽、过滤、排序）
│   ├── TopBar.js         # 顶部工具栏
│   ├── panels/           # 各功能面板
│   │   ├── SyncPanel.js       # 文档同步
│   │   ├── AnalyzePanel.js    # AI 分析
│   │   ├── SearchPanel.js     # 搜索
│   │   ├── IndexPanel.js      # 索引管理
│   │   ├── TemplatesPanel.js  # 模板生成
│   │   ├── TracePanel.js      # 需求追溯
│   │   ├── LogPanel.js        # 日志查看
│   │   └── SettingsPanel.js   # 设置
│   ── shared/           # 共享组件（Modal、Spinner 等）
├── hooks/                # 自定义 Hooks
│   ├── useAnalysis.js    # AI 分析逻辑
│   ├── useSearch.js      # 搜索逻辑
│   └── useScript.js      # CDN 脚本懒加载
└── utils/                # 工具函数
    ├── getDocIcon.js     # 文件类型图标映射
    ├── getMermaidTheme.js# Mermaid 主题切换
    ├── parseBranchName.js# Git 分支名解析
    └── sanitizeHtml.js   # HTML 净化
```

**构建流程**：

- 使用 `tsdown`（基于 Rolldown）构建
- 入口：`src/client/index.js` → 输出：`lib/client.js`（CJS 格式）
- CSS 通过 Rolldown 插件内联为 `<style>` 标签
- 外部依赖：React、ReactDOM、Cordis、DSH UI 组件库（由宿主提供）
- CDN 依赖：`marked`、`mermaid`、`highlight.js`（运行时懒加载）

### 3.3 服务端架构

```
src/server/
├── index.js              # 插件入口（注入 10 个 DSH 服务，注册路由）
├── routes/               # 6 个路由模块（42 个 API 端点）
│   ├── config-routes.js  # 配置、LLM、Prompt 相关（6 路由）
│   ├── tree-routes.js    # 目录树、工作区、索引、文件读写（10+ 路由）
│   ├── analyze-routes.js # AI 分析（5 路由，含 SSE 流）
│   ├── search-routes.js  # 搜索（2 路由：精确 + AI）
│   ├── sync-routes.js    # 文档同步（12+ 路由，含 SSE 流）
│   └── template-routes.js# 模板生成（2 路由）
└── 服务模块（14 个）
    ├── ai-engine.js          # AI/LLM 交互核心
    ├── analyze-engine.js     # 需求分析编排
    ├── phased-sync-engine.js # 分阶段同步引擎
    ├── sync-engine.js        # commit 同步基准、分支解析与代码差异
    ├── sync-state.js         # 同步状态持久化
    ├── sync-snapshots.js     # 成功同步版本的快照读取与对比
    ├── sync-timeline.js      # 同步记录转追溯事件
    ├── session-selector.js   # 会话关联查找
    ├── session-utils.js      # 会话对话提取
    ├── content-extractor.js  # 内容提取
    ├── doc-reader.js         # 文档读取
    ├── tree.js               # 目录树构建
    ├── index-manager.js      # 搜索索引管理
    ├── config.js             # 配置加载/保存
    ├── prompts.js            # Prompt 模板管理
    ├── task-executor.js      # 子代理任务执行
    ├── token-utils.js        # Token 估算
    ├── cache.js              # 内存缓存
    ├── meta.js               # .meta.json 读写
    ├── logger.js             # 分类日志
    └── utils.js              # 通用工具
```

### 3.4 API 路由总览

| 模块 | 路由数 | 关键端点 |
|------|--------|----------|
| 配置 | 6 | `/config`, `/llm-config`, `/ai-config`, `/prompt-registry` |
| 目录树 | 10+ | `/workspaces`, `/tree`, `/read`, `/create-dir`, `/rebuild-index`, `/index-status` |
| AI 分析 | 5 | `/analyze-preview`, `/analyze-stream` (SSE), `/analysis-status`, `/analysis-cancel` |
| 搜索 | 2 | `/search` (精确), `/ai-search` (语义) |
| 同步 | 12+ | `/phased-sync` (SSE), `/sync-history`, `/sync-detail` |
| 模板 | 2 | `/templates`, `/generate-template` |
| 内联 | 5 | `/logs`, `/skills`, `/skill-content` |

### 3.5 数据流

```
用户操作 → React 组件 → fetch('/req-hub/xxx') → 路由处理 → 服务模块 → 文件系统/LLM/Git
                                                              ↓
                                                         SSE 流式返回 → 组件实时更新
```

### 3.6 目录约定

```
docs/
├── <开发者A>/
│   ├── 2026-10-10-包材报价管理-增加导出功能/
│   │   ├── 需求文档.md
│   │   ├── 技术方案.md
│   │   ├── CR-2026-10-12.md
│   │   ├── .meta.json          # AI 分析元数据
│   │   └── sync-logs/          # 同步历史
│   │       ├── .sync-state.json
│   │       └── sync-<timestamp>/
│   └── 2026-10-08-xxx/
├── <开发者B>/
│   └── ...
└── .index/
    └── search-index.json       # 搜索索引
```

**Git 分支命名规范**：
- `feature/<开发者>/<日期>-<标题>` → 自动解析为需求目录
- 支持 `YYYY-MM-DD` 和 `YYYYMMDD` 两种日期格式

---

## 4. 使用流程

### 4.1 安装

1. 将插件放入 DSH 的插件目录
2. 确保 `cordis.patch.yml` 已配置：
   ```yaml
   - insert:
       - id: req-hub
         name: '@local/req-hub'
   ```
3. 构建客户端：
   ```bash
   pnpm install
   pnpm run build
   ```
4. 重启 DSH，在右侧边栏找到 "Req Hub" 按钮

### 4.2 初始化

1. **选择工作区**：点击顶部"工作区"下拉框，选择目标 DSH 工作区
2. **设置文档路径**：点击"项目路径"，配置需求文档根目录（默认 `docs`）
3. **创建需求目录**：
   - 确保 Git 分支名符合 `feature/<开发者>/<日期>-<标题>` 格式
   - 点击 Rail 栏"新建"按钮，自动解析分支名并创建目录
   - 或手动在 `docs/<开发者>/` 下创建 `YYYY-MM-DD-标题` 格式目录

### 4.3 日常使用

#### 查看和编辑文档

1. 在左侧目录树中选择需求
2. 点击 Rail 栏"查看"按钮，打开文件树侧边栏
3. 在文件树中点击文件，右侧面板显示预览
4. 支持 Markdown 渲染、Mermaid 图表、代码高亮

#### AI 分析

1. 在左侧目录树中选择需求（或不选以全量分析）
2. 点击 Rail 栏"工作台" → "分析"标签页
3. 选择分析范围（当前需求 / 全部需求）
4. 点击"开始分析"，实时查看进度
5. 分析完成后，`.meta.json` 自动写入需求目录

#### 文档同步

1. 确保当前 Git 分支对应目标需求
2. 在左侧目录树中选择需求
3. 点击 Rail 栏"同步"按钮
4. 选择同步类型（需求文档 / 技术方案）
5. 系统自动执行分阶段同步：
   - **初始化**：检测代码变更
   - **会话提取**：提取相关 DSH 会话对话
   - **代码差异分析**：分析代码变更内容
   - **讨论差异分析**：分析会话中的讨论内容
   - **增量合并**：AI 将变更合并到文档
   - **保存文件**：写入更新后的文档
6. 同步完成后可在"同步历史"中查看详细信息

#### 搜索

1. 点击 Rail 栏"工作台" → "搜索"标签页
2. **精确搜索**：输入功能点、字段名或标签名
3. **AI 搜索**：输入自然语言描述，LLM 理解后返回相关需求
4. 搜索结果点击可在右侧面板预览

#### 模板生成

1. 点击 Rail 栏"模板"按钮
2. 选择模板类型（需求 / 方案 / CR）
3. 填写必要信息
4. AI 自动生成文档内容
5. 预览并保存到需求目录

#### 需求追溯

1. 在左侧目录树中选择需求
2. 点击 Rail 栏"追溯"按钮
3. 查看需求时间线：创建、同步、分析等事件
4. 点击事件可查看详细信息

### 4.4 配置

通过顶部"设置"按钮或编辑 `config.json` 配置：

```json
{
  "docsDir": "docs",
  "workspaceId": "<工作区 ID>",
  "developerName": "<开发者名>",
  "requirementId": "<需求 ID>",
  "ai": {
    "selectedModel": "<模型名>",
    "prompts": {
      "<prompt-key>": "<自定义提示词>"
    },
    "skillBindings": {
      "phased-code-analysis-requirement": null
    }
  }
}
```

### 4.5 开发模式

```bash
# 监听模式（自动重新构建）
pnpm run dev

# 单次构建
pnpm run build
```

修改客户端代码后，DSH 会自动热重载（HMR）。修改服务端代码后需要重启 DSH。

---

## 5. 技术栈

| 层面 | 技术 |
|------|------|
| 客户端框架 | React（通过 DSH 宿主提供） |
| 客户端构建 | tsdown（Rolldown） |
| 客户端样式 | 原生 CSS + DSH Token 体系 |
| 服务端运行时 | Node.js（DSH 插件机制） |
| 依赖注入 | Cordis |
| AI/LLM | DSH LLM 服务（可配置模型） |
| 文档渲染 | marked + mermaid + highlight.js（CDN） |
| 版本控制 | Git（代码差异分析） |
| 实时通信 | SSE（Server-Sent Events） |
