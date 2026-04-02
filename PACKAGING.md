# HappyClaw 打包指南

## 一键打包

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
```

自动执行全部步骤：编译 → 打包 portable → 生成安装包。

### 产物

```
desktop/release/HappyClaw-Setup-1.0.0.exe   ← 安装包（约 220MB）
```

安装时会自动创建：
- 桌面快捷方式
- 开始菜单快捷方式
- 卸载入口（控制面板 → 程序和功能）

## 分发给同事

1. 把 `HappyClaw-Setup-1.0.0.exe` 发给同事
2. 同事双击安装（可自定义安装路径）
3. 首次启动后在 Settings 页面配置 API Key

## 升级

用户数据存储在 `%APPDATA%\HappyClaw\data\`（数据库、配置、工作区文件等），与安装目录分离。

升级步骤：
1. 关闭 HappyClaw
2. 运行新版安装包，覆盖安装到同一路径
3. 重新启动，数据自动保留

从旧版（数据在 exe 旁边）升级到新版时，首次启动会自动迁移数据到 AppData。

## 各步骤说明

一键脚本内部执行了 4 步：

### Step 1: `npm run build:all`

同时编译三个子项目：
- 后端 TypeScript → `dist/`
- 前端 React → `web/dist/`
- Agent Runner → `container/agent-runner/dist/`

### Step 2: `pack-portable.ps1 -NoZip`

- 自动检测系统 Node.js 版本，下载对应的 Windows portable 版本（缓存在 `.pack-cache/`）
- 把编译产物、`node_modules`、配置文件等拷贝到 `happyclaw-portable/`

### Step 3: `npm install`（desktop/）

安装 Electron 及 electron-builder 依赖。

### Step 4: `electron-builder --win`

基于 `happyclaw-portable/` 生成 NSIS 安装包。

## 常见问题

### Q: 打包报 `happyclaw-portable/ not found`

编译步骤未完成或 pack-portable 失败，检查 `npm run build:all` 是否通过。

### Q: electron-builder 报 stderr 错误但安装包已生成

Node.js v24+ 的 `[DEP0190] DeprecationWarning` 输出到 stderr，PowerShell 误判为错误。脚本已做兼容处理。

### Q: 安装速度较慢

NSIS 安装包约 220MB，解压写入磁盘需要一定时间，属于正常现象。安装完成后启动速度很快。

### Q: 改了代码想重新打包

直接重新运行一键脚本即可，它会从头编译。
