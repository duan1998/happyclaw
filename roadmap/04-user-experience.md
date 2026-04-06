# 04 — 用户体验层

> 运行时：以 Claude Code 为主设计，Codex 降级策略逐条注明。

---

## 4-1: 结构化输出与交互式 Artifact

- [ ] 实现

**背景**：Agent 输出只有纯 Markdown 流式文本。可以增加结构化卡片、可执行代码块、可编辑 Mermaid 图表。

**目标**：Agent 输出特殊标记的 "Artifact"（HTML/表格/图表），前端渲染为可交互的沙盒组件。代码块支持"运行"按钮。

**Codex 兼容**：Artifact 是前端渲染层功能，与运行时无关 — Claude 和 Codex 的 Agent 输出文本中都可以包含 Artifact 标记。代码块执行功能需要 WebSocket 终端（仅 Docker 容器模式），host 模式下通过 `script-runner.ts` 的 `exec()` 执行。

**实现思路**：

1. Artifact 协议：Agent 输出中的 XML 标记 `<artifact type="html" title="...">...</artifact>`
2. 前端 `MarkdownRenderer` 识别 artifact 块，提取后渲染为专用组件
3. 支持类型：
   - `html`：sandboxed `<iframe srcdoc="...">`（HTML+CSS+JS）
   - `mermaid`：现有 `MermaidDiagram` 升级为可编辑版
   - `csv`/`table`：可排序 Table 组件
4. 可执行代码块：
   - 代码块右上角增加"▶ 运行"按钮
   - 点击后通过 WebSocket `terminal_*` 协议在容器中执行
   - 执行结果内联显示在代码块下方
   - host 模式：走 `script-runner.ts` 的 `exec()` 路径
5. Artifact 可固定在右侧面板，不随对话滚动

**前端交互**：

1. **内联 Artifact 卡片**：
   - 头部：标题 + 类型标签 + 操作（"在面板中打开"、"复制代码"、"下载"）
   - 主体：iframe 渲染（固定 300px，可拖拽调整）
   - 流式：随 `text_delta` 动态更新（debounce 200ms）
2. **右侧 Artifact 面板**：
   - 点击"在面板中打开"→ 全高 Artifact 视图
   - 顶部 tab bar：可同时打开多个 Artifact
   - 底部工具栏：刷新、全屏、下载
3. **可执行代码块**：
   - 运行按钮 hover 显示"在工作区容器中执行"
   - 执行中：替换为 Loader + "取消"按钮
   - 结果：灰色背景折叠区域，显示 stdout/stderr
   - host 模式 + Codex 工作区：同样支持（走 exec 路径）
4. **安全**：iframe `sandbox="allow-scripts"`，禁止访问父页面

**涉及文件**：

- 修改 `web/src/components/chat/MarkdownRenderer.tsx`（artifact 识别）
- 新建 `web/src/components/chat/ArtifactCard.tsx`（内联卡片）
- 新建 `web/src/components/chat/ArtifactPanel.tsx`（右侧面板）
- 新建 `web/src/components/chat/ExecutableCodeBlock.tsx`（运行按钮 + 结果）
- 修改 `web/src/components/chat/ChatView.tsx`（面板管理）
- 修改 `web/src/stores/chat.ts`（Artifact 状态）

---

## 4-2: 对话分支与回溯

- [ ] 实现

**背景**：Agent 操作不满意时只能 `/clear` 或手动还原。Change History 已有 shadow git + diff + revert，但缺少"从某条消息重新开始"和 "What-if 试运行"。

**目标**：从任意消息"分叉"新对话分支，在隔离环境中尝试不同方向。支持 What-if 模式预览。

**Codex 兼容**：对话分支在主进程层面操作（复制文件快照 + 消息记录 + 创建新工作区），与运行时无关。分支后的新工作区继承父工作区的 `default_runtime`，Claude 和 Codex 均可。

**实现思路**：

1. `POST /api/groups/:jid/branch`：
   - 创建新 group folder（`branch-{parentFolder}-{timestamp}`）
   - 恢复 Change History 中该消息对应的 pre-snapshot 到新工作区（`git checkout <commit> -- .`）
   - 复制该消息之前的聊天记录到新 chat
   - 继承父工作区的 runtime/model/skills/MCP 配置
   - 返回新 JID
2. What-if 模式：
   - 分支创建时标记 `is_whatif = true`
   - What-if 工作区自动使用 `sandbox_config: { mode: 'workspace_only' }`
   - 完成后可选"合并到主工作区"（覆盖文件 + 追加消息）或"丢弃"
3. DB：`registered_groups` 新增 `parent_folder TEXT`、`branch_source_message_id TEXT`

**前端交互**：

1. **分支入口**：
   - `MessageContextMenu`（右键/长按）→ "从此处分支"（`GitBranch` 图标）
   - `ChangeHistoryPanel` 每条记录 → "从此处分支"按钮
2. **分支确认 Dialog**：
   - 说明："创建新工作区，包含此消息之前的对话和文件状态"
   - 输入：分支名称（默认 `{工作区名}-分支-{序号}`）
   - 选项：☐ What-if 模式（沙盒隔离，可合并回主工作区）
   - 信息：显示恢复到哪个时间点
3. **侧边栏分支树**：
   ```
   📁 我的项目
     └─ 📁 我的项目-分支-1
     └─ 📁 我的项目-分支-2 (what-if)
   ```
   分支带 `GitBranch` 小图标，what-if 带 `FlaskConical` 图标
4. **What-if 合并**：ChatView 头部横幅 "🧪 What-if 模式" + "合并到主工作区" / "丢弃" 按钮
5. **移动端**：长按菜单 → 底部 Sheet 确认

**涉及文件**：

- 修改 `src/routes/groups.ts`（分支 + 合并 API）
- 修改 `src/change-history.ts`（快照恢复到新目录）
- 修改 `src/db.ts`（新增列）
- 修改 `web/src/components/chat/MessageContextMenu.tsx`
- 修改 `web/src/components/layout/UnifiedSidebar.tsx`
- 修改 `web/src/components/chat/ChangeHistoryPanel.tsx`
- 修改 `web/src/components/chat/ChatView.tsx`（What-if 横幅）
- 修改 `web/src/stores/groups.ts`

---

## 4-3: 语音交互

- [ ] 实现

**背景**：移动端 PWA 场景下打字不便。Web Speech API 可在浏览器端完成语音识别，无需后端支持。

**目标**：Web 前端支持语音输入（识别 → 转文字发送）和 TTS 播放。

**Codex 兼容**：语音交互是纯前端功能，与运行时完全无关。

**实现思路**：

1. 语音输入：
   - `MessageInput` 增加麦克风按钮
   - 使用 `SpeechRecognition` API（Chrome/Edge/Safari 支持）
   - 识别结果实时填入输入框，用户确认后发送
   - 不支持时（Firefox）：按钮 hidden
2. TTS 播放：
   - Agent 回复的 `MessageBubble` 增加"🔊"播放按钮
   - 使用 `SpeechSynthesis` API
   - 长文本分段播放，播放中高亮当前段落
3. 可选：支持 OpenAI Whisper API 作为高精度备选（需后端代理）

**前端交互**：

1. **麦克风按钮**：`MessageInput` 左侧工具栏，`Mic` 图标
   - 点击开始录音：按钮变红 + 脉冲动画 + 输入框显示实时识别文字
   - 再次点击或回车停止识别并填入
   - 长按模式（可选）：按住说话，松手自动发送
2. **TTS 按钮**：`MessageBubble`（Agent 回复）右下角 `Volume2` 图标
   - 点击播放：图标变为 `VolumeX`（停止），高亮正在朗读的段落
   - 自动跳过代码块和 Artifact
3. **设置**：`SettingsPage` → 外观 tab 增加"语音交互"区块：
   - 语音输入开关 + 语言选择
   - TTS 开关 + 语速 + 声音选择
4. **移动端**：麦克风按钮自动放大为 FAB 风格；TTS 用系统语音引擎

**涉及文件**：

- 新建 `web/src/hooks/useSpeechRecognition.ts`
- 新建 `web/src/hooks/useSpeechSynthesis.ts`
- 修改 `web/src/components/chat/MessageInput.tsx`（麦克风按钮）
- 修改 `web/src/components/chat/MessageBubble.tsx`（TTS 按钮）
- 修改 `web/src/pages/SettingsPage.tsx`（语音设置）
