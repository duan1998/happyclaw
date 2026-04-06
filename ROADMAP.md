# HappyClaw 功能演进路线图

> **产品定位**：单人多龙虾 — 一个人指挥多个 Agent 同时工作。
>
> **运行时原则**：所有功能以 **Claude Code**（Claude Agent SDK）为主设计和实现，
> 尽量兼顾 **Codex**（`codex exec --json` CLI）。Codex 仅支持宿主机模式且不经过
> agent-runner，部分 SDK 特性（hooks、MCP tools、canUseTool）在 Codex 路径不可用，
> 需要在对应条目中注明降级策略。
>
> 本路线图面向 AI 执行者。每个条目包含背景、实现思路、前端交互和涉及文件，
> AI 可以逐条领取并实现。完成后在对应条目前打 `[x]`。

## 文件索引

| 文件 | 主题 | 条目 |
|------|------|------|
| [01-agent-intelligence.md](roadmap/01-agent-intelligence.md) | Agent 智能层 | 1-1 事件驱动触发（Webhook + 文件监听 + 跨 Agent 总线）、1-2 Daemon Agent、1-3 记忆进化 |
| [02-dev-workflow.md](roadmap/02-dev-workflow.md) | 开发者工作流 | 2-1 Git 工作流自动化、2-2 项目管理闭环 |
| [03-execution.md](roadmap/03-execution.md) | 执行层增强 | 3-1 智能模型路由、3-2 审批流（Human-in-the-Loop）、3-3 多 Agent 编排 |
| [04-user-experience.md](roadmap/04-user-experience.md) | 用户体验 | 4-1 Artifact 交互式输出、4-2 对话分支与回溯、4-3 语音交互 |
| [05-platform.md](roadmap/05-platform.md) | 平台化 | 5-1 Agent 模板市场、5-2 API 开放平台 |

## 实施顺序

```
Phase 1 (基础管道):
  1-1a Webhook → 3-1 模型路由 → 3-2a 审批流(Claude) → 2-1 Git Skills

Phase 2 (智能增强):
  1-1b 文件监听 → 1-1c 跨 Agent 总线
  1-3 记忆索引 → 1-3b 智能摘要
  2-2 项目管理闭环

Phase 3 (体验飞跃):
  4-1 Artifact → 4-2 对话分支 → 4-3 语音
  3-3 多 Agent 编排

Phase 4 (平台化):
  5-1 模板市场 → 5-2 API 开放
  1-2 Daemon Agent
```

## 通用规范

每完成一个条目后：
1. `make typecheck` 确保类型安全
2. `make test` 确保不破坏现有功能
3. 更新 `CLAUDE.md` 中相关章节
4. commit 格式：`功能: 简要描述`
