# 05 — 平台化

> 运行时：以 Claude Code 为主设计，Codex 降级策略逐条注明。

---

## 5-1: Agent 模板市场

- [ ] 实现

> **审计备注**：已有基础 — `init_source_path`/`init_git_url` 可初始化工作区内容，`config/default-groups.json` 存在但为空，`AgentDefinitionsPage` 管理全局 Agent 定义。缺少"配置打包为模板 + 一键应用"。

**背景**：创建新工作区时需手动配置 system prompt、Skills、MCP servers、权限。

**目标**：打包 "Skills + MCP + permission + sandbox + model + runtime" 为可分享的 Agent 模板，内置 + 自定义 + 导入导出。

**Codex 兼容**：模板中的 `default_runtime` 字段区分 Claude/Codex。应用模板时：
- Claude 模板应用到 Codex 工作区：自动切换 `default_runtime` 或提示用户确认
- Codex 模板：Skills 和 MCP 配置可能不完全适用（降级提示）
- 模板 JSON 中标记 `compatibleRuntimes: ['claude', 'codex']`

**实现思路**：

1. 模板格式（JSON）：
   ```json
   {
     "name": "DevOps Agent",
     "description": "自动化 CI/CD、基础设施管理",
     "compatibleRuntimes": ["claude", "codex"],
     "defaultRuntime": "claude",
     "defaultModel": "sonnet",
     "skills": ["git-pr-reviewer", "git-ci-fixer"],
     "mcpServers": [],
     "permissionProfile": { "disallowedTools": ["TodoWrite"] },
     "sandboxConfig": { "mode": "workspace_only" },
     "systemPromptAppend": "你是一个专业的 DevOps 工程师..."
   }
   ```
2. API：
   - `GET /api/templates` — 内置 + 用户模板
   - `POST /api/templates` — 创建
   - `POST /api/templates/:id/apply` — 应用到工作区
   - `POST /api/templates/export` / `POST /api/templates/import`
3. 内置模板：DevOps Agent、技术写作 Agent、代码审查 Agent、数据分析 Agent
4. DB：`agent_templates` 表

**前端交互**：

1. **创建工作区选模板**：`NewConversationDialog` 增加第一步"选择模板"：
   - 网格卡片（图标 + 名称 + 描述 + 运行时标签 Claude/Codex/Both）
   - 顶部 "从空白开始" 默认选项
   - 底部 "导入模板 JSON"
   - 选模板后进入第二步（名称/路径），模板自动填充配置
2. **模板管理**：`SettingsPage` → `templates` tab：
   - 列表：我的模板 + 内置模板（内置不可编辑/删除）
   - 操作：创建、编辑、删除、导出 JSON
3. **从工作区保存**：ChatView 头部菜单 → "保存为模板" → Dialog 填名称/描述 → 自动抓取当前配置
4. **移动端**：模板选择改为竖向卡片列表

**涉及文件**：

- 新建 `src/routes/templates.ts`
- 修改 `src/web.ts`（挂载路由）
- 修改 `src/db.ts`（新表 `agent_templates`）
- 新建 `web/src/stores/templates.ts`
- 新建 `web/src/components/settings/TemplatesSection.tsx`
- 修改 `web/src/components/chat/NewConversationDialog.tsx`（模板步骤）
- 修改 `web/src/components/chat/ChatView.tsx`（"保存为模板"菜单项）

---

## 5-2: API 开放平台

- [ ] 实现

**背景**：HappyClaw 只能通过 Web/IM 界面使用。外部应用无法直接调用 Agent 能力。

**目标**：REST API + SSE 流式接口，让外部系统以 API 方式调用 Agent。支持 API Key 认证。

**Codex 兼容**：API 调用时 `runtime` 参数指定运行时。`POST /api/v1/run` 和 `/api/v1/stream` 在后端根据目标工作区的 `default_runtime` 或请求中的 `runtime` 字段路由到 `runHostAgent()`/`runContainerAgent()` 或 `runCodexHostAgent()`。

**实现思路**：

1. API Key 认证：
   - `users` 表新增 `api_keys JSON`（支持多个 key）
   - 每个 key：`{ id, prefix, hash, name, created_at, last_used_at, status }`
   - `Authorization: Bearer sk-xxxx` header 认证
   - Key 生成时一次性显示完整值，之后只存 hash
2. 核心 API：
   - `POST /api/v1/run` — 同步执行（等 Agent 完成返回结果）
     ```json
     {
       "group_folder": "main",
       "prompt": "...",
       "model": "sonnet",
       "runtime": "claude",
       "timeout": 300,
       "images": []
     }
     ```
   - `POST /api/v1/stream` — SSE 流式输出（`text/event-stream`）
   - `GET /api/v1/status/:runId` — 查询异步状态
   - `POST /api/v1/cancel/:runId` — 取消执行
3. 执行流程：验证 API Key → 查找工作区 → 构造消息 → `GroupQueue.enqueueMessageCheck()` → 等待结果或返回 runId
4. 速率限制：per-key 限流（令牌桶）

**前端交互**：

1. **API Keys 管理**：`SettingsPage` → `api-keys` tab：
   - 密钥列表表格：名称、前缀 `sk-...xxxx`、创建时间、最后使用、状态
   - "生成新密钥" → Dialog 填名称 → 确认后 **一次性** 显示完整 key
     - ConfirmDialog 提醒 "此密钥只显示一次，请立即复制"
     - 复制按钮
   - 操作：吊销、删除
2. **API 文档面板**：API Keys 页面下方：
   - 自动检测 `baseUrl`，生成 curl/Python/Node.js 代码示例
   - 端点列表 + 请求/响应 schema
3. **API 用量**：`UsagePage` → "API 调用"视图，按 key 分组
4. **移动端**：标准列表 + 底部 Sheet 创建

**涉及文件**：

- 新建 `src/routes/api-v1.ts`
- 新建 `src/middleware/api-key-auth.ts`（API Key 中间件）
- 修改 `src/db.ts`（api_keys 相关）
- 修改 `src/web.ts`（挂载路由）
- 新建 `web/src/components/settings/ApiKeysSection.tsx`
- 修改 `web/src/pages/SettingsPage.tsx`（注册 tab）
