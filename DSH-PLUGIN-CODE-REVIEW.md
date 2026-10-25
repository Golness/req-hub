# ReqHub 外部插件代码审查记录

- 审查日期：2026-10-25。
- 范围：当前工作区的 Host、Client、配置、构建与发布设置，包括尚未提交的 UI 修改。
- 依据：DSH 面向外部插件的 `cordis-plugin-development` 规范及其 references。规范入口和开发约束见 [AGENTS.md](./AGENTS.md)。
- 状态：以下 11 项已完成修复及逐项验证。各节的问题与旧行号保留为审查时的历史记录；当前实现及验收证据见末尾“修复验收”。
- 优先级：P1 优先处理，涉及访问边界、跨会话影响或取消后仍写入；P2 涉及规范符合性、兼容性、资源管理和交付完整性。
- 行号对应本次审查时的工作区，后续修改可能使行号变化；定位时同时检索所列函数或代码片段。

## 1. [P1] HTTP 接口绕过宿主认证

**位置：** [src/server/index.js:492](./src/server/index.js#L492)，`webServer.register(route)`。

**问题与触发条件：** 插件直接注册 `/req-hub/*` 原始 HTTP 路由，处理器未接入 Connection 的认证和 Host/Origin 校验。能够访问 DSH HTTP 端口的客户端可以直接请求工作区信息、读取或写入文件、修改配置以及启动任务。

**依据与证据：** DSH 的 `packages/host/webserver/src/index.ts` 直接分派请求至 route handler；认证发生在 `packages/client/connection/src/index.ts` 注册的共享 API 路由中，不会自动覆盖插件自行注册的路径。此项通过源码调用链确认，本次没有进行真实宿主未认证网络请求测试。

**修复方向：** 通过已认证的宿主操作入口暴露能力；确需原始 HTTP 路由时，使用当前 Connection 提供的请求准入机制，并验证 Host、Origin 和浏览器认证。

**验收：** 未认证或来源不允许的请求不能读取数据、改配置、写文件或启动任务；合法宿主调用仍正常工作。

## 2. [P1] 同步文件读取存在目录穿越，写入边界未处理链接

**位置：** [src/server/routes/sync-routes.js:1030](./src/server/routes/sync-routes.js#L1030)，`join(reqDir, fileName)`；[src/server/routes/tree-routes.js:373](./src/server/routes/tree-routes.js#L373)，`resolve(docsRoot, filePath)`。

**问题与触发条件：** `/sync-file` 将客户端传入的 `fileName` 直接拼接到需求目录后读取，没有验证最终路径仍属于授权目录，`../` 可以越界。`/write` 虽调用 `isInside()`，但该函数只校验解析后的字符串路径，无法阻止符号链接或 Windows junction 指向目录外。

**影响：** 请求可访问非预期文件；存在链接的文档目录中可能写入授权范围之外。

**修复方向：** 生成文件优先按服务端记录的 artifact ID 查询；验证实际文件路径和目录归属。针对已存在文件、待创建文件的父目录，以及符号链接/junction 分别处理。

**验收：** 覆盖 `..`、不同分隔符、绝对路径、目录前缀相似名称、Windows 大小写和链接越界；合法文档读写不受影响。

## 3. [P1] HTML 预览开放宿主同源脚本权限

**位置：** [src/client/components/FilePreview.js:276](./src/client/components/FilePreview.js#L276)，HTML `srcDoc` 预览及 `sandbox: 'allow-scripts allow-same-origin'`。

**问题与触发条件：** 打开带脚本的 HTML 文档时，iframe 同时允许脚本执行和同源访问，预览内容可以获得父页面及插件接口的访问能力。

**影响：** 文档内容可能读取宿主状态或调用具有副作用的接口，突破文件预览边界。

**修复方向：** 采用受限的预览权限和内容处理方式，不同时向不可信内容开放这两个 sandbox 权限。确需脚本的交互预览应另行设计隔离边界。

**验收：** 文档脚本不能访问父页面 DOM、宿主状态或以宿主权限操作数据；合法预览保持可用。本次结论来自代码检查，未在真实宿主执行恶意预览载荷。

## 4. [P1] 同步全局监听器会阻断无关会话

**位置：** [src/server/sync-controlled-tools.js:47](./src/server/sync-controlled-tools.js#L47)，`llm/stream` 全局监听器。

**问题与触发条件：** 监听器扫描所有请求消息中的 `REQHUB_SYNC_V2=UUID`，只要对应 runtime 不存在就抛出 `SYNC_RUNTIME_CLOSED`。普通会话引用旧同步日志或 marker，也会被误判为本插件任务。

**已验证：** 使用 `sessionId: 'unrelated-session'`，消息内容引用 `REQHUB_SYNC_V2=00000000-0000-0000-0000-000000000000`。实际输出为 `{"error":"SYNC_RUNTIME_CLOSED","forwarded":false}`，后续处理未被调用。

**修复方向：** 根据宿主拥有的 Agent/子会话与任务身份建立关联，再执行任务校验；不属于插件的请求必须继续 `next()`。不能将可被引用的文本 marker 作为权限或所有权凭据。

**验收：** 无关会话引用任意历史 marker 均正常执行；已撤销任务的真实子会话仍不能继续使用受控能力。

## 5. [P1] 分析任务取消后仍可能执行和写入

**位置：** [src/server/routes/analyze-routes.js:410](./src/server/routes/analyze-routes.js#L410)，取消处理；同文件两处 `analyzeRequirement()` 调用约在 256、307 行；[src/server/analyze-engine.js](./src/server/analyze-engine.js)，执行及 `.meta.json` 写入。

**问题与触发条件：** 取消接口仅设置 `cancelled` 和 `completed`，没有中止执行。路由调用分析引擎时未传递 `signal`，因此引擎已有的信号检查不起作用。

**影响：** UI 显示取消后，子代理仍可能消耗资源、完成分析并写入 `.meta.json`；旧任务还可能与后续操作发生竞争。

**修复方向：** 每个任务拥有独立 AbortController 和执行身份，将信号传入执行链；终止后等待收尾，提交前再次检查任务有效性，避免迟到回调更新新任务。

**验收：** 在子代理运行中取消，不能再发布 metadata；任务未收尾前不伪装成已完成；插件卸载也能终止并等待分析任务。

## 6. [P2] 外部插件直接加载 Harness Client 组件包

**位置：** [src/client/components/shared/Button.js:4](./src/client/components/shared/Button.js#L4)，以及 Input、ModalFrame、Select、Toast、TriggerButton、Checkbox 使用处和 `src/client/icons.js`。

**问题：** 多处直接加载 `@deepseek-ai/dsh-client-ui-primitives`。这些宿主内部组件 API 不保证外部兼容性，升级或组件参数变化可能导致整个 Slot 渲染失败。

**规范依据：** DSH 外部插件的 `references/practices.md` UI 部分明确禁止通过模块直接加载 Harness Client 包。此前把 DSH 内部功能包的“复用 ui-primitives”规则套用于本插件，判断需要纠正；前次 UI 修改引入的直接依赖同样在修复范围内。

**修复方向：** 参考宿主对应组件的结构、CSS 和交互，在插件内部统一实现；使用主题令牌并保留焦点、Escape、ARIA、键盘及定位行为，不通过 external 绕过限制。

**验收：** 源码与发布 Client 产物不再通过运行时模块引用 Harness Client 组件；在实际宿主中验证明暗主题、窄面板和交互。现有替身测试通过不能替代该验收。

## 7. [P2] 卸载时丢弃写作和知识库清理 Promise

**位置：** [src/server/index.js:84](./src/server/index.js#L84)，`void writing.dispose()` 和 `void knowledge.dispose()`。

**问题：** disposer 包装函数没有返回 Promise。外层 `await dispose()` 实际无法等待异步清理结束，异常也无法沿正常清理链传递。

**影响：** 插件卸载或 HMR 后，旧任务和数据库关闭过程可能仍在运行，与新实例竞争资源。

**修复方向：** 直接返回并等待清理 Promise，明确清理顺序和异常策略，确保一个清理失败不会跳过其他资源的释放。

**验收：** 让写作及知识库清理故意延迟，卸载必须等待；清理失败被正确报告，其他资源仍完成释放。

## 8. [P2] Agent preset scope lease 未释放

**位置：** [src/server/index.js:343](./src/server/index.js#L343)、同文件 452 行，以及 [src/server/prompts.js:237](./src/server/prompts.js#L237)，`agentPresets.acquireScope()`。

**问题：** 取得 lease 后未调用 `Symbol.asyncDispose`。其中部分路径仅取得 lease 后返回 `null`，依然持有引用。注释中“异步操作完成后自动释放”的假设不成立。

**依据与影响：** 宿主 `packages/preset/agent-preset-registry/src/index.ts` 的 `acquireScope()` 返回 AsyncDisposable；释放时才递减 generation 引用并触发回收。不释放会阻止旧 preset generation 被清理。

**修复方向：** 在所有成功、失败和提前返回路径通过 `finally` 等待 lease 释放；需要把作用域传给后续调用时，同时明确 lease 的所有者和生命周期。

**验收：** 正常读取、读取异常和提前返回均释放；多次刷新 preset 后旧 generation 可以回收。

## 9. [P2] 配置未使用 Cordis Config，且写入安装目录

**位置：** [src/server/config.js:12](./src/server/config.js#L12)，`CONFIG_FILE`；[src/server/index.js](./src/server/index.js)，未导出 Config schema；[src/server/routes/config-routes.js](./src/server/routes/config-routes.js)，配置合并及保存。

**问题：** 可调配置保存在包内 `config.json`，未在插件激活时进行 schema 校验；读取失败静默回退默认配置。关于 schema 包不可用的旧注释不能作为跳过当前宿主配置机制的依据。

**影响：** 共享同一包目录的多个 profile 可能串配置，更新安装包可能影响配置；非法值或损坏配置难以及时发现。

**修复方向：** 使用当前宿主支持的 Cordis Config schema，区分用户配置、界面选择状态和业务运行数据，迁移到对应作用域的持久化位置，并保留清晰的迁移与错误提示。

**验收：** 非法配置明确失败；不同 profile 的配置隔离；更新包不丢失用户配置；不能把损坏文件当作首次启动。

## 10. [P2] UI 数据操作缺少对应 Agent 操作入口

**位置：** [src/server/routes/writing-routes.js:68](./src/server/routes/writing-routes.js#L68)，写作优化编排；类似情况需检查配置、文档和知识库等 UI 操作。

**问题：** 用户级操作主要存在于 HTTP handler 中。现有 writing/sync tools 面向内部子代理的证据读取、编辑和提交，不等于提供了与 UI 等价的用户级操作工具。

**规范依据与影响：** `references/user-actions.md` 要求应用数据和配置操作由 Host 实现一次，再供 UI 与 Agent 工具共同调用。当前 Agent 无法通过对应入口完成同样操作，后续易产生两套实现。

**修复方向：** 将业务编排抽为 Host 方法，由 UI 的已认证入口和 Agent 工具共用，参数、结果和失败语义一致。纯视图操作不需要工具；授权与审批仍保持用户专属。

**验收：** 同一操作分别从 UI 和工具执行，状态变化、返回值与失败一致；Agent 不能替用户批准权限。

## 11. [P2] 发布产物缺少 bundle patch

**位置：** [package.json:21](./package.json#L21)，`files`；同文件 `dsh.bundle.patch` 指向 `./cordis.patch.yml`。

**问题：** `files` 白名单未包含 `cordis.patch.yml`。目录链接方式可能正常，但打包安装时缺少声明使用的组合配置。

**已验证：** 执行 `npm pack --dry-run --ignore-scripts --json`，解析发布文件清单，结果为 `patchIncluded: false`、`serverEntryIncluded: true`、`clientEntryIncluded: true`，共 59 个文件。

**修复方向：** 把 patch 和其他 manifest 引用资源加入发布清单，同时核对入口、相对导入、locale 元数据、图标和动态资源。

**验收：** dry-run 清单包含全部引用资源；在独立目录按实际发布包安装并验证加载，不仅验证源码目录链接。

## 初次审查的验证与限制（修复前）

- 已运行 `node node_modules/vitest/vitest.mjs run`：**46 个测试文件、378 项测试全部通过**，总耗时约 62 秒。
- 已运行独立最小请求验证第 4 项，确认无关会话会被错误阻断。
- 已检查发布包 dry-run 文件清单，确认第 11 项。
- 其余问题依据当前插件和 DSH 源码的调用链与资源契约判断；未声称全部完成真实宿主攻击载荷、卸载、profile 迁移或安装复现。
- 当前测试大量使用宿主替身，测试通过不能证明认证、跨会话隔离、完整卸载、发布安装和真实宿主 UI 已符合规范。
- 本次审查未修改业务代码；记录落库不代表任何问题已修复。后续修复应逐项补充变更位置、验证证据和状态。

## 初次审查建议的处理顺序

1. 修复认证、文件边界和 HTML 预览权限（1–3）。
2. 修复跨会话干扰、取消和异步清理、lease 释放（4、5、7、8）。
3. 按外部插件规范修正 Client 依赖、配置及用户操作入口（6、9、10）。
4. 补齐发布资源并完成真实宿主与独立安装验证（11）。

## 修复验收（2026-10-25）

| 项目 | 状态及当前实现 | 逐项验证 |
| --- | --- | --- |
| 1 认证 | 已修复。`plugin-boundaries.js` 使用实际 Connection `admit()`；所有插件 HTTP 路由统一接入。 | `review-boundaries.test.js` 验证拒绝时业务不执行；`dsh-composition.test.js` 使用真实 WebServer、Connection，验证无认证 401、错误 Origin 403、认证读写成功。 |
| 2 文件边界 | 已修复。`safe-path.js` 同时验证规范化路径、实际路径及链接；文档读写与同步文件读取接入检查。同步读取额外验证文档根目录仍处于工作区。 | `review-boundaries.test.js` 覆盖绝对路径、两种分隔符、越界、缺失父目录及链接；`review-plugin.test.js` 经实际路由验证穿越、junction 和文档根目录链接被拒绝，正常读写保留。 |
| 3 HTML 预览 | 已修复。`FilePreview.js` 移除 `allow-same-origin`，保留隔离脚本环境，增加 CSP 和 no-referrer；禁止内容连接宿主接口。 | `file-preview.test.js` 验证 sandbox、CSP、合法预览及默认 Markdown 模式。浏览器安全属性由 DOM 回归验证；未把恶意文档真实执行描述为已完成。 |
| 4 会话隔离 | 已修复。`delegation-context.js` 结合异步调用所有权、宿主子会话及父会话关系绑定 runtime；同步和写作均不再以文本 marker 判定所有权。补上启动中取消后迟到子代理的回收。 | 边界测试验证历史/当前 marker 不影响无关会话、辅助请求放行、真实撤销会话拒绝。真实 DSH spawn 子代理读取冻结证据并收尾后，其父会话引用旧 marker 仍可完成。 |
| 5 分析取消 | 已修复。分析路由的任务和 AbortController 按插件实例持有，信号传入引擎；取消后等待实际终止，卸载中止并等待，客户端不伪造完成。 | `review-analysis.test.js` 验证运行中取消不发布 metadata、卸载等待、正常任务发布；原有分析回归保留。 |
| 6 Client 依赖 | 已修复。`shared/controls.js` 与 CSS Modules 统一提供插件私有控件，参考实际 DSH 结构、令牌和交互；图标本地打包并保留许可，删除内部 Client 包运行时加载及测试替身。 | `ui-contract.test.js` 同时检查源码与构建产物；实际 DOM 验证菜单搜索、键盘和焦点。真实 DSH 验证明暗主题、窄侧栏、弹窗、菜单边界、预览/源码编辑保存、知识库入库及写作选择。 |
| 7 卸载 | 已修复。Host/Client 注册均由 effect 持有，清理幂等；`disposeAll` 等待异步收尾，一个资源失败仍清理其他资源并报告异常。 | 边界测试验证等待与异常聚合；实际插件测试延迟知识库 close，确认卸载等待；真实 Cordis 卸载后工具消失、路由返回 404。 |
| 8 scope lease | 已修复。两个 Skill 路由及 prompts 冷加载路径均在 finally 中等待 `Symbol.asyncDispose`。 | `review-plugin.test.js` 覆盖成功和失败，`review-boundaries.test.js` 覆盖冷路径提前返回；不再依赖自动释放假设。 |
| 9 配置 | 已修复。导出原生 Schemastery Config 图，支持宿主 schema 检查及校验；优先使用可选服务 `profileContext.dir`，独立环境才回退环境变量。原子保存到 profile，旧安装目录配置一次迁移且保留原文件，损坏配置明确失败。 | `config.test.js` 与边界测试验证非法值、损坏/不可读文件、迁移和 profile 隔离。真实 Cordis 集成提供与环境目录不同的 profileContext，确认配置只写入宿主 profile；发布包验证原生 schema。 |
| 10 共用操作 | 已修复。`operations.js` 维护一份 Host 操作分派，HTTP 和 `req_hub_action` 工具共用；调用者身份来自工具上下文，所选 DSH/Codex 证据 ID 保留，系统目录打开仍为用户操作。 | 边界测试比较 UI/工具的状态变化、失败状态及调用者身份。真实 DSH 工具注册后写入文档，再通过认证 HTTP 读取同一结果。 |
| 11 发布 | 已修复。白名单补全 patch、locale、icon、许可及运行依赖；`verify-package.mjs` 检查真实 npm tarball。 | 实际打包包含 69 个文件，独立安装目录导入 Host、检查 Config、执行 Client 工厂并核对所有 manifest 资源；构建产物无禁止的 Client 包加载。 |

### 总体验证与证据

- 全量回归：`npx vitest run`，50 个测试文件、400 项测试全部通过，包含真实 DSH 组合与 spawn 集成，未跳过这两项集成测试。
- 构建：`npm run build` 通过；发布验证：`npm run verify:package` 通过；差异空白检查：`git diff --check`。
- 真实宿主验证使用临时独立 profile、临时工作区及实际 DSH Web Client，加载本插件。完成文档预览/源码编辑保存、知识库构建、写作选择知识库和草稿、设置菜单及同步入口检查；已验证实例的浏览器控制台错误为 0。
- 本地验收记录位于 `.req-hub/review-final-tests.log`、`review-final-build.log`、`review-final-package.log`、`package-verification.json` 和 `live-ui-verification.json`。截图包括 `review-live-dark.png`、`review-live-light.png`、`review-live-narrow.png`、`review-live-writing.png`。该目录被 Git 忽略；持续回归依据为已落库的测试源码与验证脚本。
- 真实 spawn 验证使用实际 AgentLoop、工具注册、受控证据及子代理生命周期，仅外部模型边界采用确定性适配器。没有调用商业模型，不能据此宣称生成内容质量已经人工验收。
- 临时宿主已停止，临时工作区/profile 已清理；未修改或重启用户当前 DSH profile。Host 代码生效需要重新加载插件或重启对应 DSH 实例。本记录只覆盖上述 11 项及受影响路径，不代表项目所有功能和所有运行环境均不存在缺陷。
