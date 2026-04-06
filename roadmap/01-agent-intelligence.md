# 01 — Agent 智能层：从"被动响应"到"主动感知"

> 运行时：以 Claude Code 为主设计，Codex 降级策略逐条注明。

---

## 1-1: 事件驱动的 Agent 触发

当前 Agent 只有两种启动方式：用户消息 + 定时任务。需要扩展为三种新的触发源，分步实现。

### 1-1a: Webhook 入口

- [ ] 实现

**背景**：外部系统（GitHub PR、CI 失败、监控报警）无法直接触发 Agent，只能人工复制到聊天窗口。

**目标**：`POST /api/webhook/:groupFolder` 端点，接收 JSON payload 触发 Agent。

**Codex 兼容**：Webhook 注入的消息进入 `GroupQueue`，与运行时无关 — Claude 和 Codex 工作区均可被触发。

**实现思路**：

1. 新建 `src/routes/webhook.ts`：
   - `POST /api/webhook/:groupFolder` — 核心端点
   - 认证：每个群组可配置 webhook secret（HMAC-SHA256 签名校验），存储在 `registered_groups` 新增 `webhook_secret` 列
   - 请求体：`{ "content": "...", "source": "github|ci|monitoring|custom", "metadata": {...} }`
2. 路由处理器：校验签名 → 查找 `registered_groups` by folder → 构造消息 → `storeMessageDirect()` + `broadcastNewMessage()`
   - 消息 `source` 标记为 `webhook:{source}`，前端可识别来源
3. 在 `src/web.ts` 挂载（不经过 cookie 认证中间件，使用自身 HMAC 校验）
4. DB migration：`registered_groups` 新增 `webhook_secret TEXT`

**前端交互**：

1. **入口**：右侧面板新增 `webhook` tab（图标 `Link2`），仅工作区 owner 可见
2. **面板内容**：
   - Webhook URL 展示（`{baseUrl}/api/webhook/{folder}`）+ 复制按钮
   - Secret：遮罩显示，点击切换明文，"重新生成"按钮（ConfirmDialog）
   - curl 示例：折叠区域，自动填入 URL 和 secret
   - 最近 10 条 webhook 调用记录（时间、来源、状态）
3. **消息标签**：webhook 触发的消息在 `MessageBubble` 显示来源标签（`🔗 GitHub`）
4. **空状态**：未配置时显示引导卡片 + 一键生成 secret
5. **移动端**：webhook 配置在"更多"菜单 → 底部 Sheet

**涉及文件**：

- 新建 `src/routes/webhook.ts`
- 修改 `src/web.ts`（挂载路由）
- 修改 `src/db.ts`（新增列 + migration）
- 修改 `src/schemas.ts`（请求体校验）
- 新建 `web/src/components/chat/WebhookPanel.tsx`
- 修改 `web/src/components/chat/ChatView.tsx`（注册 tab）
- 修改 `web/src/components/chat/MessageBubble.tsx`（来源标签）
- 修改 `CLAUDE.md`

---

### 1-1b: 文件系统监听

- [ ] 实现

**背景**：工作区内文件变化（如 `git push` 后代码更新、CI 产物落盘）无法自动触发 Agent 审查。

**目标**：可选的 per-group 文件监听器，匹配到变化时自动注入消息触发 Agent。

**Codex 兼容**：文件监听在主进程层面（`src/`），触发后走 `GroupQueue.enqueueMessageCheck()`，Claude 和 Codex 均可。

**实现思路**：

1. `registered_groups` 新增 `file_watch_config JSON`：
   ```json
   {
     "enabled": false,
     "patterns": ["**/*.ts", "**/*.py"],
     "ignore": ["node_modules/**", "dist/**"],
     "debounceMs": 5000,
     "promptTemplate": "文件发生变更：\n{changes}\n请审查这些变更。"
   }
   ```
2. 新建 `src/file-watcher.ts`：
   - 使用 `fs.watch`（recursive）或 `chokidar` 监听 `data/groups/{folder}/` 或 `customCwd`
   - 变更事件 debounce 后，构造消息注入 `storeMessageDirect()` + `broadcastNewMessage()`
   - 消息 `source` 标记为 `file_watch`
3. 在 `loadState()` 中初始化已启用的 watcher，配置变更时热重启

**前端交互**：

1. **入口**：右侧面板 webhook tab 内增加"文件监听"分区（或独立 tab `eye` 图标）
2. **配置**：
   - 开关 toggle
   - 监听模式 (glob patterns) 文本输入，comma 分隔
   - 忽略模式输入
   - 防抖间隔数字输入
   - Prompt 模板多行文本框（可引用 `{changes}` 变量）
3. **状态指示**：ChatView 头部显示 `👁 监听中`，hover 显示监听模式

**涉及文件**：

- 新建 `src/file-watcher.ts`
- 修改 `src/db.ts`（新增列）
- 修改 `src/index.ts`（loadState 初始化 watcher）
- 修改 `src/routes/groups.ts`（PATCH 接受 file_watch_config）
- 修改 `web/src/components/chat/WebhookPanel.tsx`（文件监听区块）

---

### 1-1c: 跨 Agent 事件总线

- [ ] 实现

**背景**：Agent A 完成任务后需要自动通知 Agent B 继续。`send_message` MCP 工具已具雏形（可发到任意 JID），但缺乏结构化的事件传递和条件触发。

**目标**：轻量级事件总线 + 规则引擎，支持"当 X 发生时，触发 Y"。

**Codex 兼容**：事件总线在主进程层面运行，Codex 完成执行后同样触发 `agent.completed` 事件。但 Codex 路径无法通过 MCP tool 主动发射自定义事件（需 fallback 到 IPC 文件写入或 stdout 约定格式）。

**实现思路**：

1. 定义事件类型：
   - `agent.completed` — Agent 完成执行（任意运行时）
   - `file.changed` — 工作区文件变更（依赖 1-1b）
   - `webhook.received` — Webhook 收到请求（依赖 1-1a）
   - `task.failed` — 定时任务失败
   - `task.completed` — 定时任务完成
   - `container.error` — 容器 OOM / 超时
2. 规则表 `event_rules`：
   ```sql
   CREATE TABLE event_rules (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_type TEXT NOT NULL,
     condition JSON,
     action_type TEXT NOT NULL,  -- 'run_agent' | 'send_message' | 'run_script'
     action_config JSON NOT NULL,
     user_id INTEGER NOT NULL,
     enabled INTEGER DEFAULT 1
   );
   ```
3. 新建 `src/event-bus.ts`：Node.js EventEmitter，各模块 emit 事件，规则引擎 subscribe
4. 在 `src/index.ts` 各处（agent 完成、任务失败、webhook 收到等）插入 `eventBus.emit()`

**前端交互**：

1. **入口**：`SettingsPage` 新增 `automations` tab（图标 `Zap`）
2. **规则列表**：每条规则一张卡片："当 [事件] → 如果 [条件] → 则 [动作]" 自然语言描述 + 启用 toggle
3. **规则编辑器 Dialog**（三步）：
   - **Step 1 WHEN**：事件类型下拉
   - **Step 2 IF**（可选）：条件编辑，根据事件动态渲染（工作区选择、关键词过滤等）
   - **Step 3 THEN**：动作类型选择 + 配置（选工作区/填 prompt/选 IM 通道等）
4. **移动端**：三步改为逐步 wizard，每步一屏

**涉及文件**：

- 新建 `src/event-bus.ts`
- 新建 `src/routes/event-rules.ts`
- 修改 `src/db.ts`（新表）
- 修改 `src/web.ts`（挂载路由）
- 修改 `src/index.ts`（各处 emit）
- 新建 `web/src/pages/AutomationsPage.tsx`
- 新建 `web/src/stores/automations.ts`

---

## 1-2: 长驻 Daemon Agent

- [ ] 实现

**背景**：当前 Agent 是"对话完就退出"模式（`IDLE_TIMEOUT` 后关闭）。监控、守护、流水线等场景需要 Agent 持续运行。

**目标**：Daemon 模式 — Agent 持续运行，定期执行巡检任务，发现异常主动报告。

**Codex 兼容**：Codex CLI 不支持 IPC 持续注入（单次 `exec` 模式）。Daemon 模式 **仅限 Claude 运行时**。Codex 工作区开启 daemon 时提示用户需切换到 Claude 运行时。

**实现思路**：

1. `registered_groups` 新增 `daemon_config JSON`：
   ```json
   { "enabled": false, "checkInterval": 60000, "prompt": "检查日志中的异常..." }
   ```
2. Daemon Agent 启动后不设 idle timeout，每隔 `checkInterval` 毫秒通过 IPC 注入巡检 prompt
3. 巡检结果通过 `send_message` MCP 工具回报
4. 与 `GroupQueue` 序列化键共享，确保不冲突
5. 资源限制：daemon 占用一个持久进程/容器槽位，前端需明确提示

**前端交互**：

1. **侧边栏标记**：Daemon 工作区显示 `Activity` 脉冲图标
2. **配置入口**：工作区设置 → "守护模式" toggle，展开后：
   - 巡检间隔：数字 + 单位选择（秒/分/时）
   - 巡检 Prompt：多行文本区
   - 提示："启用后持续占用一个进程槽位"
3. **状态栏**：ChatView 头部 "🟢 守护中 · 下次巡检 12:30:00"
4. **巡检消息**：聊天流中带 "🔄 定期巡检" 标签
5. **停止**：头部菜单 → "停止守护"（ConfirmDialog）
6. **Codex 工作区**：toggle disabled + tooltip "Daemon 仅支持 Claude 运行时"

**涉及文件**：

- 修改 `src/container-runner.ts`（daemon 模式不设 idle timeout）
- 修改 `src/index.ts`（daemon 启动 + 定期 IPC 注入）
- 修改 `src/db.ts`（新增列）
- 修改 `web/src/components/chat/ChatView.tsx`（状态 + 配置）
- 修改 `web/src/components/layout/ChatGroupItem.tsx`（脉冲图标）

---

## 1-3: Agent 记忆进化

当前记忆是平面文件 + 全文扫描（`includes()` 逐行匹配）。需要分两步升级。

### 1-3a: 结构化记忆索引

- [ ] 实现

> **审计备注**：当前 `memory_search`（MCP 工具）和 `/api/memory/search`（Web API）均为文件全量读取 + 子字符串匹配，无 FTS5。

**目标**：SQLite FTS5 全文索引，支持更快检索和按标签/时间/来源过滤。

**Codex 兼容**：Codex 路径无 MCP tools，不调用 `memory_search`。FTS5 索引仅影响 Claude 的 MCP 工具和 Web API `/api/memory/search`。Codex Agent 通过文件系统直接读取 `CLAUDE.md` 和记忆文件，不受影响。

**实现思路**：

1. 新表 `memory_entries` + FTS5 虚拟表（`tokenize='trigram'` 支持 CJK）
2. `memory_append` MCP 工具改为双写（文件 + SQLite）
3. `memory_search` MCP 工具优先 FTS5 `MATCH`，fallback 文件扫描
4. PreCompact hook 中提取关键决策写入 `memory_entries`（`source='compact'`）
5. Web API `/api/memory/search` 增加结构化查询参数

**前端交互**：

1. **搜索增强**：`MemoryPage` 搜索栏下方增加筛选行：
   - 来源过滤：多选 pill（`agent`、`user`、`compact`、`manual`）
   - 时间范围：日期选择器
   - 工作区过滤：下拉
2. **结果卡片**：匹配高亮 + 来源标签 + 时间戳 + 工作区
3. **向下兼容**：无筛选条件时行为与现有一致

**涉及文件**：

- 修改 `src/db.ts`（新表 + FTS5 + migration）
- 修改 `container/agent-runner/src/mcp-tools.ts`（memory_append、memory_search）
- 修改 `src/routes/memory.ts`
- 修改 `web/src/pages/MemoryPage.tsx`

---

### 1-3b: 每日智能摘要

- [ ] 实现

> **审计备注**：`daily-summary.ts` 是机械拼接。`/recall` 命令已通过 `sdkQuery()` 实现 AI 摘要，可复用。

**目标**：Claude API 生成结构化每日摘要（关键决策、完成事项、待跟进、代码变更）。

**Codex 兼容**：摘要生成在主进程调用 `sdkQuery()`（使用 Claude API），不受 Codex 影响。摘要写入的文件对所有运行时的 Agent 可见。

**实现思路**：

1. `daily-summary.ts` 收集完消息后调用 `sdkQuery()`（复用 `/recall` 模式）
2. 摘要模板：关键决策 / 完成事项 / 待跟进 / 代码变更 四个分区
3. 写入 `data/groups/user-global/{userId}/daily-summary/{date}.md`
4. `HEARTBEAT.md` 使用摘要版本
5. 配置项：`enableAIDailySummary`（考虑 API 成本）

**前端交互**：

1. **摘要卡片**：`MemoryPage` 顶部展示最近 3 天 AI 摘要（折叠/展开卡片）
2. **设置**：系统设置 → "每日摘要" toggle + 提示 "凌晨 2-3 点运行，消耗少量 API 额度"

**涉及文件**：

- 修改 `src/daily-summary.ts`
- 修改 `src/runtime-config.ts`
- 修改 `web/src/components/settings/SystemSettingsSection.tsx`
- 修改 `web/src/pages/MemoryPage.tsx`
