# 03 — 执行层增强

> 运行时：以 Claude Code 为主设计，Codex 降级策略逐条注明。

---

## 3-1: 智能模型自动路由

- [ ] 实现

> **审计备注**：per-group 手动模型选择已完整实现（`default_model` + Web 选择器 + IM `/model` 命令 + container-runner 传递）。本条目聚焦"系统自动判断复杂度、自动选模型"。

**背景**：虽然用户可以手动为每个工作区选模型，但简单对话和复杂重构混在同一工作区，手动切不现实。

**目标**：用户未明确指定模型时，系统根据消息内容自动选择最合适的模型，降低整体成本。

**Codex 兼容**：
- **Claude 路径**：路由器在 `src/index.ts` 构建 `ContainerInput` 前运行，设置 `agentModel`，agent-runner 通过 `ANTHROPIC_MODEL` 环境变量接收 — 完全支持。
- **Codex 路径**：`runCodexHostAgent()` 中 `writeSessionCodexConfig(sessionDir, input.agentModel)` 已支持 per-call 模型覆盖。路由器对 Codex 同样生效，但可选模型范围不同（OpenAI 模型 vs Anthropic 模型）。路由器需根据 `default_runtime` 选择对应的模型映射表。

**实现思路**：

1. 定义路由策略（`registered_groups` 新增 `model_routing TEXT`）：
   - `manual`（默认）— 沿用现有行为
   - `auto` — 系统自动选择
   - `cost_optimized` — 激进省钱
2. 新建 `src/model-router.ts`：
   - **启发式分类器**：消息长度、是否包含代码块、是否引用多个文件、关键词（"重构"/"设计"/"架构"）
   - **分级**：`simple` → `medium` → `complex`
   - **可选 LLM 分类**：用便宜模型先做 10-token 分类（可配置开关）
3. 模型映射表（per-runtime）：
   - Claude：`simple → haiku`、`medium → sonnet`、`complex → opus`
   - Codex：`simple → gpt-4.1-mini`、`medium → gpt-4.1`、`complex → o3`
   - 管理员可自定义
4. 路由结果在 `src/index.ts` 中覆盖 `containerInput.agentModel`
5. 路由决策日志：记录每条消息的路由结果，供用量统计

**前端交互**：

1. **模型选择器增强**：`MessageInput` Popover 顶部三个 pill：`手动` | `自动` | `省钱`
   - `自动`/`省钱` 时选择器 disabled，显示"系统自动选择"
2. **消息模型标签**：auto 模式下 Agent 回复右下角小字 `via haiku`，hover tooltip 说明路由原因
3. **系统设置**：admin → "模型路由映射" 区块，两列（Claude / Codex），各三行（简单/中等/复杂）
4. **用量统计**：`UsagePage` 增加"模型分布"饼图

**涉及文件**：

- 新建 `src/model-router.ts`
- 修改 `src/db.ts`（新增列 + 系统设置）
- 修改 `src/index.ts`（调用路由器）
- 修改 `src/runtime-config.ts`（映射表配置）
- 修改 `web/src/components/chat/MessageInput.tsx`
- 修改 `web/src/components/chat/MessageBubble.tsx`
- 修改 `web/src/components/settings/SystemSettingsSection.tsx`

---

## 3-2: 工具审批流（Human-in-the-Loop）

- [ ] 实现

**背景**：`canUseTool` 仅用于 sandbox 路径拦截。SDK 支持 `PreToolUse` hook 和 `permissionDecision: 'allow' | 'deny' | 'ask'`，可在工具调用前插入用户审批。

**目标**：高风险操作通过 WebSocket 推送审批请求到前端，用户确认后才继续。支持预算门控（token 超阈值暂停）和 PostToolUse 审计增强。

**Codex 兼容**：
- **Claude 路径**：PreToolUse hook 完全支持（SDK 原生能力）。
- **Codex 路径**：Codex CLI 无 hook 机制。降级策略：Codex 工作区的审批依赖 CLI 的 `--sandbox` 参数（已实现 `readonly` / `workspace-write`），无法做 per-tool 的实时审批。前端 Codex 工作区的审批配置 UI 显示提示 "Codex 运行时仅支持 sandbox 级别控制，不支持逐工具审批"。

**实现思路**：

1. 在 `agent-runner` 注册 `PreToolUse` hook：
   - 匹配高风险模式时通过 IPC 发送 `approval_request`（新增 IPC 类型）
   - 主进程通过 WebSocket 推送到前端
   - 前端用户操作后 WebSocket → 主进程 → IPC 回传
   - hook 根据结果返回 `permissionDecision`
2. 高风险模式（可配置）：
   - Bash：`rm -rf`、`git push -f`、`docker rm`
   - Write/Edit：`.env`、`*.key`、`*.pem`
3. 预算门控：跟踪 `usage` stream event 的累计 token，超阈值时注入审批
4. PostToolUse hook：记录所有工具调用到审计日志

**前端交互**：

1. **审批卡片**（非 Dialog，嵌入聊天流）：
   - 覆盖 `MessageInput` 区域弹出
   - `amber-50` 背景 + `amber-500` 左边框
   - 内容：工具名、参数（高亮危险部分为红色）、风险说明
   - 按钮：`允许执行`、`拒绝`、`始终允许此类操作`（本会话白名单）
   - 30 秒倒计时，超时自动拒绝
2. **流式集成**：审批等待时 `ToolActivityCard` 显示 "⏳ 等待确认…" + 黄色脉冲
3. **预算门控 UI**：累计 token 超阈值时，审批卡片显示 "本次对话已消耗 xxx tokens，是否继续？"
4. **配置入口**：右侧面板 env/设置 区增加"工具审批"开关 + 规则编辑
5. **IM 渠道**：飞书 → 交互式卡片按钮；Telegram → inline keyboard；其他 → `/approve` `/deny` 命令 fallback

**涉及文件**：

- 修改 `container/agent-runner/src/index.ts`（PreToolUse + PostToolUse hooks）
- 修改 `container/agent-runner/src/types.ts`（IPC 类型）
- 修改 `src/index.ts`（IPC 审批处理 + WebSocket）
- 修改 `shared/stream-event.ts` + `make sync-types`
- 修改 `web/src/stores/chat.ts`
- 新建 `web/src/components/chat/ApprovalCard.tsx`
- 修改 `web/src/components/chat/StreamingDisplay.tsx`
- 修改 `web/src/components/chat/MessageInput.tsx`（审批期间遮盖输入区）

---

## 3-3: 多 Agent 编排（Orchestration）

- [ ] 实现

**背景**：Sub-Agent 是 SDK 内置的简单委托模式。复杂场景需要流水线（A→B→C→D）、竞争（best-of-N）、专家会诊（多专家各自分析后汇总）等编排模式。

**目标**：Pipeline 编排引擎 + 竞争/会诊模式，复用 `GroupQueue` 并发控制。

**Codex 兼容**：
- **Claude 路径**：Pipeline 每步调用 `runHostAgent()` 或 `runContainerAgent()`，完全支持。
- **Codex 路径**：Pipeline 每步也可调用 `runCodexHostAgent()`（仅 host 模式）。混合 Pipeline（Step 1 用 Claude，Step 2 用 Codex）通过 per-step `runtime` 字段支持。
- **竞争模式**：多个 Agent 并行执行，通过 `GroupQueue` 的独立虚拟 JID 隔离，双运行时均可。

**实现思路**：

1. Pipeline 格式（JSON/YAML）：
   ```yaml
   name: "Code Change Pipeline"
   steps:
     - name: "planner"
       runtime: "claude"  # 或 "codex"
       model: "opus"
       prompt: "分析需求，输出实现计划"
       tools: ["Read", "Grep", "Glob"]
     - name: "coder"
       runtime: "claude"
       prompt: "按照上一步计划实现代码"
     - name: "reviewer"
       runtime: "claude"
       model: "sonnet"
       prompt: "审查变更，提出改进"
   mode: "sequential"  # sequential | parallel | best_of_n
   ```
2. Pipeline 执行引擎 `src/pipeline-runner.ts`：
   - `sequential`：按序执行，前步 `result` 注入后步 `prompt` 的 `{previous_output}`
   - `parallel`/`best_of_n`：并行执行多步（各分配独立虚拟 JID），完成后由汇总步合并结果
   - 每步结果存 `pipeline_runs` 表
3. API：`POST /api/pipelines/:id/run`，`GET /api/pipelines`
4. 与 `GroupQueue` 集成：每步作为独立 task 入队，复用并发控制和重试

**前端交互**：

1. **Pipeline 页面**：导航栏新增"流水线"（`Workflow` 图标）
   - 列表：卡片（名称、步骤数、运行状态、最近运行时间）
   - 创建按钮
2. **编辑器**：
   - 左侧：竖向步骤列表，每步可展开卡片（名称、运行时选择 Claude/Codex、模型下拉、Prompt 文本区、工具集选择）
   - 卡片间连线 + 拖拽排序
   - 右侧：Mermaid 自动预览流程图
   - 顶部：Pipeline 名称 + 模式选择（顺序/并行/竞争） + 保存/试运行
3. **运行视图**：
   - 步骤进度条：圆点横排，当前步骤脉冲，完成 ✓
   - 下方：当前步骤流式输出（复用 `StreamingDisplay`）
   - 竞争模式：并排显示多个 Agent 的输出，完成后高亮最优结果
4. **运行历史**：tab 切换查看历史运行，各步骤耗时/token/状态
5. **移动端**：编辑器简化为纯列表（无拖拽/预览），运行视图不变

**涉及文件**：

- 新建 `src/pipeline-runner.ts`
- 新建 `src/routes/pipelines.ts`
- 修改 `src/db.ts`（`pipelines` + `pipeline_runs` 表）
- 修改 `src/web.ts`（挂载路由）
- 新建 `web/src/pages/PipelinesPage.tsx`
- 新建 `web/src/stores/pipelines.ts`
- 修改 `web/src/components/layout/nav-items.ts`
