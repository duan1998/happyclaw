# HappyClaw 打包指南

## 快速打包（三步）

在项目根目录下依次执行：

```powershell
# 第 1 步：编译全部（后端 + 前端 + agent-runner）
npm run build:all

# 第 2 步：生成 portable 中间产物（下载 Node.js、拷贝运行时文件）
powershell -ExecutionPolicy Bypass -File scripts\pack-portable.ps1 -NoZip

# 第 3 步：用 Electron 打包桌面应用
cd desktop
npx electron-builder --win
cd ..
```

也可以用一键脚本执行第 2 + 3 步（第 1 步仍需先手动跑）：

```powershell
npm run build:all
powershell -ExecutionPolicy Bypass -File scripts\pack-portable.ps1 -NoZip
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
```

### 产物

打包完成后，产物在 `desktop/release/win-unpacked/` 目录：

```
desktop/release/win-unpacked/
  HappyClaw.exe    ← 双击即可运行
  ...（其他依赖文件）
```

## 分发给同事

1. 把 `desktop/release/win-unpacked/` 文件夹**手动压缩成 zip**
2. 发给同事
3. 同事解压后，在 `HappyClaw.exe` 同目录创建 `.env` 文件，写入：
   ```
   ANTHROPIC_API_KEY=sk-ant-xxxxx
   ```
4. 双击 `HappyClaw.exe` 即可运行

## 各步骤说明

### 第 1 步：`npm run build:all`

同时编译三个子项目：
- 后端 TypeScript → `dist/`
- 前端 React → `web/dist/`
- Agent Runner → `container/agent-runner/dist/`

如果只改了前端代码，也可以单独跑 `npm run build:web`，但打包前建议跑完整的 `build:all` 确保一致。

### 第 2 步：`pack-portable.ps1`

- 自动检测系统 Node.js 版本，下载对应的 Windows portable 版本（缓存在 `.pack-cache/`）
- 把编译产物、`node_modules`、配置文件等拷贝到 `happyclaw-portable/`
- 这个目录是第 3 步的**前置依赖**，不能跳过

### 第 3 步：`electron-builder --win`

- 基于 `happyclaw-portable/` 的内容，打包成 Electron 桌面应用
- 输出到 `desktop/release/win-unpacked/`
- 必须在 `desktop/` 目录下执行（或通过 `build-desktop.ps1` 脚本）

## 常见问题

### Q: 第 3 步报 `happyclaw-portable/ not found`

跳过了第 2 步。先跑 `pack-portable.ps1`。

### Q: `build-desktop.ps1` 脚本报错但 `win-unpacked/` 已经生成了

Node.js v24+ 的 `[DEP0190] DeprecationWarning` 输出到 stderr，PowerShell 误判为错误。脚本已修复（临时切换 `$ErrorActionPreference`）。如果仍有问题，直接在 `desktop/` 目录手动跑 `npx electron-builder --win`。

### Q: 改了代码想重新打包

三步都要重新跑。编译 → portable → electron，缺一不可。

### Q: portable 单文件 exe 和 win-unpacked 的区别

之前用的 `portable` 模式会生成一个约 177MB 的单文件 exe，每次双击都要先解压到临时目录才能运行，启动非常慢。现在改为 `dir` 模式，直接生成解压好的文件夹，双击秒开。
