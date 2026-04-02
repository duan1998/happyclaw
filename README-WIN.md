# HappyClaw Windows 使用手册

## 启动

```powershell
cd C:\Users\User\happyclaw
node dist/index.js
```

启动后访问 http://localhost:3000

## 后台运行（关掉终端不停）

```powershell
Start-Process -NoNewWindow -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory "C:\Users\User\happyclaw"
```

## 停止

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select -Expand OwningProcess | ForEach { Stop-Process -Id $_ -Force }
```

## 重启

先停止再启动：

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select -Expand OwningProcess | ForEach { Stop-Process -Id $_ -Force }
Start-Sleep -Seconds 3
cd C:\Users\User\happyclaw; node dist/index.js
```

## 更新代码

```powershell
cd C:\Users\User\happyclaw

# 停止服务
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select -Expand OwningProcess | ForEach { Stop-Process -Id $_ -Force }

# 拉取最新代码
git pull

# 同步共享类型
Copy-Item shared\stream-event.ts src\stream-event.types.ts -Force
Copy-Item shared\stream-event.ts web\src\stream-event.types.ts -Force
Copy-Item shared\stream-event.ts container\agent-runner\src\stream-event.types.ts -Force
Copy-Item shared\image-detector.ts src\image-detector.ts -Force
Copy-Item shared\image-detector.ts container\agent-runner\src\image-detector.ts -Force
Copy-Item shared\channel-prefixes.ts src\channel-prefixes.ts -Force
Copy-Item shared\channel-prefixes.ts container\agent-runner\src\channel-prefixes.ts -Force

# 重装依赖（如 package.json 有变化）
npm install
cd container\agent-runner; npm install; npm run build; cd ..\..
cd web; npm install; npm run build; cd ..

# 编译后端
npm run build

# 重启
node dist/index.js
```

## 当前配置

| 项目 | 值 |
|------|-----|
| 安装目录 | `C:\Users\User\happyclaw` |
| 端口 | 3000 |
| Web 地址 | http://localhost:3000 |
| 执行模式 | 宿主机模式（admin 直接在本机跑 Agent） |
| 飞书 Bot | 已配置，WebSocket 长连接自动重连 |
| 数据目录 | `C:\Users\User\happyclaw\data` |

## 备份数据

```powershell
$date = Get-Date -Format "yyyyMMdd-HHmmss"
Compress-Archive -Path C:\Users\User\happyclaw\data -DestinationPath "C:\Users\User\happyclaw-backup-$date.zip"
```

## Windows 兼容性补丁说明

原版 HappyClaw 有几个 Windows 不兼容的问题，已在本地修复：

1. **`src/routes/groups.ts`** — `process.env.HOME` 在 Windows 上为 undefined，改为 `os.homedir()`
2. **`src/routes/groups.ts`** — Docker 不可用时 `init_source_path` 自动转为 `custom_cwd`
3. **`container/agent-runner/src/index.ts`** — `new URL(import.meta.url).pathname` 在 Windows 产生 `/C:/` 前缀导致路径错误，改为 `fileURLToPath()`

> 如果 `git pull` 更新后这些修复被覆盖，需要重新应用。
