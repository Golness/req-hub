# 测试基础设施

本目录包含 ReqHub 项目的测试基础设施。

## 目录结构

```
test/
├── setup.js                    # 全局测试配置和 mock 工具
├── server/                     # 服务端模块测试
│   ├── task-executor.test.js   # 任务执行器测试
│   ├── sync-state.test.js      # 同步状态管理测试
│   ├── tree.test.js            # 文档树构建测试
│   ├── analyze-engine.test.js  # 分析引擎测试
│   └── config.test.js          # 配置管理测试
└── client/                     # 客户端组件测试
    └── components.test.js      # 组件导出和工具函数测试
```

## 运行测试

```bash
# 运行所有测试
pnpm test

# 监听模式（开发时使用）
pnpm test:watch

# 生成覆盖率报告
pnpm test:coverage
```

## 测试框架

- **Vitest**: 现代化测试框架，支持 ES modules
- **覆盖率**: 使用 @vitest/coverage-v8

## Mock 工具

`test/setup.js` 提供了以下全局 mock 工具：

- `createMockCtx()`: 创建 mock DSH 上下文
- `createMockRun()`: 创建 mock subagent run 对象
- `createMockParentAgent()`: 创建 mock 父 agent
- `createMockLLM()`: 创建 mock LLM 服务
- `createMockFS()`: 创建 mock 文件系统
- `createMockLogger()`: 创建 mock logger

这些工具在测试中通过 `globalThis.__testHelpers` 访问。

## 测试覆盖

### 服务端模块

- **TaskExecutor**: 前置条件验证、模板变量检查、输出提取、错误处理
- **SyncState**: 状态加载/保存、活动同步管理、历史记录、中止控制
- **Tree**: 文档树构建、需求目录解析、文件统计
- **AnalyzeEngine**: 需求分析流程、错误处理、LLM 集成
- **Config**: 配置加载/保存、自动默认值设置

### 客户端模块

- 工具函数导出验证（parseBranchName, getDocIcon, sanitizeHtml 等）
- 组件模块导出验证
- 共享组件导出验证

## 注意事项

1. 所有测试文件使用 `.test.js` 后缀
2. 使用 ES module 语法（import/export）
3. 文件系统操作和 LLM 调用都已 mock
4. 测试不依赖真实的 DSH 环境
