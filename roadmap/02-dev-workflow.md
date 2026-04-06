# 02 — 开发者工作流深度集成

> 运行时：以 Claude Code 为主设计，Codex 降级策略逐条注明。

---

## 2-1: Git 工作流自动化

- [ ] 实现

**背景**：Claude Code 天生擅长代码操作，但缺少与 Git 平台的结构化集成。`code-reviewer` sub-agent 只做本地审查，无法在 PR 上留 comment。

**目标**：一组可复用的 Skills，让 Agent 完成 Git 工作流闭环：review PR → 提交修复 → 更新 PR 状态。配合 1-1a Webhook 实现 GitHub 事件自动触发。

**Codex 兼容**：Skills 是 `.md` 文件，通过容器/宿主机 symlink 挂载。Claude Agent 通过 Skills 系统发现并使用。Codex Agent 不使用 Skills 系统，但可以通过 `CLAUDE.md` 或自定义命令间接引用 Skill 内容（降级：需手动在 Codex 工作区的指令中描述工作流）。

**实现思路**：

1. `container/skills/git-pr-reviewer.md`：
   - 接收 PR URL → `gh pr checkout` → 审查代码 → 生成结构化 review
   - 可通过 `gh pr review` 或 `gh pr comment` 在 PR 上留 comment
   - YAML frontmatter 声明需要 `Bash`、`Read`、`Grep` 工具
2. `container/skills/git-ci-fixer.md`：
   - 接收 CI 日志 → 分析失败原因 → 尝试修复 → 提交 commit → 推送
   - 安全约束：只修改测试/配置文件，不改核心逻辑（可配置）
3. `container/skills/git-release-notes.md`：
   - 读取 `git log` + change-history → 生成版本说明
   - 输出格式：Markdown（可直接粘贴到 GitHub Release）
4. Webhook 配合：GitHub PR/CI Webhook → 1-1a 端点 → payload 中的 PR URL 自动触发对应 Skill

**前端交互**：

1. **Skills 展示**：`SkillsPage` "项目级 Skills" 分类下显示 Git 套件卡片（名称、描述、标签 `git`/`ci`/`review`）
2. **触发方式**：自然语言（"帮我 review 这个 PR: https://..."）或 Webhook 自动触发
3. **无额外配置 UI**：Skills 通过容器挂载自动生效

**涉及文件**：

- 新建 `container/skills/git-pr-reviewer.md`
- 新建 `container/skills/git-ci-fixer.md`
- 新建 `container/skills/git-release-notes.md`

---

## 2-2: 项目管理闭环

- [ ] 实现

**背景**：已接入 Atlassian MCP Server，Agent 可以读写 Jira/Confluence。但缺少结构化的工作流编排：Issue → 代码 → PR → 状态更新。

**目标**：Agent 可以自动读取 Issue 描述 → 理解需求 → 实现代码 → 提交 PR → 更新 Issue 状态。支持每日站会摘要和自动提取 Action Items。

**Codex 兼容**：Codex 工作区可以通过 MCP Server 配置接入 Atlassian（`mcp-servers/{userId}/servers.json`）。但 Codex CLI 对 MCP Server 的支持取决于 Codex 版本 — 如果不支持，降级为：Agent 在宿主机通过 `curl` 或 `jira` CLI 与 Jira 交互。

**实现思路**：

1. 新建 `container/skills/jira-workflow.md`：
   - 输入：Jira Issue key（如 `PROJ-123`）
   - 流程：MCP 读取 Issue → 分析需求 → 在工作区实现 → `git commit` → `gh pr create` → MCP 更新 Issue 状态为 "In Review" + 关联 PR 链接
   - 支持批量：传入多个 Issue key，逐个处理
2. 新建 `container/skills/daily-standup.md`：
   - 每日站会摘要 Skill：汇总昨天所有工作区的 Agent 活动（读取 daily-summary）+ Jira 状态变更
   - 输出格式化的站会报告
3. 自动 Action Item 提取：
   - 利用 1-3a 记忆索引，在 PreCompact hook 中识别对话中的 TODO/Action Item
   - 如果用户配置了 Jira 集成，自动创建 Jira Issue

**前端交互**：

1. **Skills 展示**：与 2-1 相同，在 `SkillsPage` 显示项目管理类 Skills
2. **Jira 连接状态**：`SettingsPage` → MCP Servers tab 中显示 Atlassian MCP 连接状态
3. **站会摘要入口**：`MemoryPage` 或 dashboard 中展示每日站会摘要（复用 1-3b 的卡片布局）

**涉及文件**：

- 新建 `container/skills/jira-workflow.md`
- 新建 `container/skills/daily-standup.md`
- 修改 `container/agent-runner/src/index.ts`（PreCompact 中 Action Item 提取，可选）
