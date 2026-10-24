# Codex 会话读取来源

JSONL 元数据读取、文本提取、上下文过滤与镜像消息去重参考并改编自 [dsh-codex-migrate](https://github.com/polarskicpl/dsh-codex-migrate) 2.0.4 的 `lib/logic.js`、`lib/inventory/indexer.js` 和 `lib/bridge/adapters/codex.js`。

本插件增加只读 Codex SQLite 工作区与归档判断、完整轮次投影，以及独立的 ReqHub SQLite 和 Markdown 快照存储；不修改 Codex 数据，不创建 DSH 会话。

MIT License

Copyright (c) 2026 nightcrusing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
