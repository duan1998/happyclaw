# HappyClaw Windows 安装指南

> 给 AI Agent 的避坑手册。原版 HappyClaw 是为 Linux/macOS 设计的，Windows 上有几个必须修的兼容性问题。

## 前置条件

- **Node.js >= 20**（推荐 24）：https://nodejs.org
- **Claude API Key**：Anthropic 官方或兼容中转服务
- **不需要 Docker**：admin 用户走宿主机模式，不依赖 Docker
- **不需要 make**：Windows 没有 make，手动执行等效命令

## 安装步骤

```powershell
# 1. Clone
git clone https://github.com/riba2534/happyclaw.git C:\Users\User\happyclaw
cd C:\Users\User\happyclaw

# 2. 同步共享类型（等效于 make sync-types）
Copy-Item shared\stream-event.ts src\stream-event.types.ts -Force
Copy-Item shared\stream-event.ts web\src\stream-event.types.ts -Force
Copy-Item shared\stream-event.ts container\agent-runner\src\stream-event.types.ts -Force
Copy-Item shared\image-detector.ts src\image-detector.ts -Force
Copy-Item shared\image-detector.ts container\agent-runner\src\image-detector.ts -Force
Copy-Item shared\channel-prefixes.ts src\channel-prefixes.ts -Force
Copy-Item shared\channel-prefixes.ts container\agent-runner\src\channel-prefixes.ts -Force

# 3. 安装依赖（三个子项目各自独立）
npm install
cd container\agent-runner; npm install; cd ..\..
cd web; npm install; cd ..

# 4. 构建
cd container\agent-runner; npm run build; cd ..\..
npm run build          # 后端
cd web; npm run build; cd ..  # 前端

# 5. 启动
node dist/index.js
# 访问 http://localhost:3000 完成设置向导
```

## 必须修的 Windows 兼容性问题（3 个）

### Bug 1：`process.env.HOME` 在 Windows 上为 undefined

**文件**：`src/routes/groups.ts`

**现象**：创建工作区时 403，白名单路径匹配全部失败

**原因**：代码用 `process.env.HOME || '/Users/user'` 展开 `~` 路径，Windows 没有 `HOME` 环境变量，fallback 到 Linux 路径 `/Users/user`

**修复**：

```typescript
// 先加 import
import os from 'node:os';

// 找到这行（在 POST /api/groups 路由的白名单校验处）
process.env.HOME || '/Users/user',
// 改为
os.homedir(),
```

### Bug 2：Docker 不可用时创建工作区死锁

**文件**：`src/routes/groups.ts`

**现象**：前端默认选 Docker 模式发 `init_source_path`，但后端因 Docker 不可用 fallback 到 host 模式，host 模式拒绝 `init_source_path`，返回 400

**原因**：前端 `executionMode` 默认 `'container'`，用户填了本地路径后发送 `{ init_source_path: "..." }`（无 `execution_mode` 字段）。后端检测 Docker 不可用，自动切 host 模式，但 host 模式不允许 `init_source_path`

**修复**：在 `POST /api/groups` 路由中，`init_source_path / init_git_url 仅 container 模式可用` 这个检查之前，加转换逻辑：

```typescript
// 原代码
if (executionMode === 'host' && (initSourcePath || initGitUrl)) {
    return c.json({ error: '...' }, 400);
}

// 改为
if (executionMode === 'host' && (initSourcePath || initGitUrl)) {
    if (initSourcePath && !validation.data.execution_mode && !customCwd) {
        // Docker 不可用导致自动 fallback，将 init_source_path 转为 custom_cwd
        customCwd = initSourcePath;
        initSourcePath = undefined;
    } else {
        return c.json({ error: '...' }, 400);
    }
}
```

注意：`customCwd` 和 `initSourcePath` 的声明需要从 `const` 改为 `let`。

### Bug 3：`import.meta.url` 路径在 Windows 上多出 `/C:/`

**文件**：`container/agent-runner/src/index.ts`

**现象**：Agent 启动崩溃，报错 `ENOENT path: 'C:\C:\Users\...\security-rules.md'`

**原因**：`new URL(import.meta.url).pathname` 在 Windows 返回 `/C:/Users/...`（带前导 `/`），`path.join` 把它拼成 `\C:\...`，最终解析为 `C:\C:\...`

**修复**：

```typescript
// 加 import
import { fileURLToPath } from 'url';

// 找到这行
path.dirname(new URL(import.meta.url).pathname),
// 改为
path.dirname(fileURLToPath(import.meta.url)),
```

## 白名单配置

**文件**：`config/mount-allowlist.json`

Windows 下可直接用 `*:\\` 允许所有已存在的本地/映射盘符，无需逐个手动追加：

```json
{
  "allowedRoots": [
    { "path": "~", "allowReadWrite": true, "description": "Home directory" },
    { "path": "*:\\", "allowReadWrite": true }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

修改后需重启服务生效（白名单在进程启动时缓存到内存）。

## 设置向导注意事项

### Claude API 配置

选「第三方渠道」，填：
- **ANTHROPIC_BASE_URL**：你的 API 中转地址
- **ANTHROPIC_MODEL**：如 `claude-sonnet-4-6`
- **ANTHROPIC_AUTH_TOKEN**：API Key

### 飞书集成

在飞书开放平台创建企业自建应用：
1. 事件订阅选「使用长连接接收事件」
2. 添加事件 `im.message.receive_v1`
3. 需要的权限：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:resource`、`im:chat:read`、`cardkit:card:write`
4. 在 HappyClaw 设置页填入 App ID 和 App Secret

## 日常操作

```powershell
# 启动
cd C:\Users\User\happyclaw; node dist/index.js

# 后台启动
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory "C:\Users\User\happyclaw"

# 停止
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select -Expand OwningProcess | ForEach { Stop-Process -Id $_ -Force }

# 备份数据
$date = Get-Date -Format "yyyyMMdd-HHmmss"
Compress-Archive -Path C:\Users\User\happyclaw\data -DestinationPath "C:\Users\User\happyclaw-backup-$date.zip"
```

## Cursor / Claude Code 工作区自动发现（本地增强）

原版 HappyClaw 的 Agent 不会读取项目的 `.cursor/` 或 `.claude/` 配置。本地已修改源码，创建工作区后 Agent 会自动发现：

| 资源 | 扫描路径 | 去重规则 |
|------|---------|---------|
| **Skills** | `.cursor/skills/` → `.claude/skills/` | 同名 skill `.claude/` 覆盖 `.cursor/` |
| **Rules** | `.cursor/rules/*.mdc` → `.claude/rules/*.mdc` | 同文件名 `.claude/` 优先，只加载 `alwaysApply: true` |
| **MCP Servers** | `.mcp.json` → `.claude/settings.json` | 同名 server `.claude/` 覆盖 `.mcp.json` |
| **CLAUDE.md** | 项目根目录 | SDK 原生支持，无需额外处理 |

改动涉及两个文件：
- `src/container-runner.ts` — skills 符号链接逻辑
- `container/agent-runner/src/index.ts` — rules 注入 system prompt + MCP 加载

## 踩过的其他坑

1. **OpenClaw 残留进程**：如果之前装过 OpenClaw 并配了同一个飞书 Bot，卸载后要检查是否有 `openclaw.mjs gateway run` 的 node 进程还在跑，会抢飞书消息
2. **端口占用**：重启时如果报 `EADDRINUSE`，用停止命令杀进程，等 3 秒再启动
3. **`git pull` 会覆盖修复**：上面 3 个 bug 修复和工作区自动发现功能都是本地改的，`git pull` 后需要重新应用
