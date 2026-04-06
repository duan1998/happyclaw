<#
.SYNOPSIS
  Pack HappyClaw into a portable distribution folder.
  Output: happyclaw-portable/ (and optionally .zip)

.DESCRIPTION
  1. Downloads portable Node.js for Windows (if not cached)
  1b. Downloads MinGit for Windows (busybox variant, if not cached)
  2. Copies runtime files (dist, node_modules, config, container, web/dist, etc.)
  3. Includes HappyClaw.bat launcher
  4. Creates .env.example for colleagues to fill in API keys
  5. Optionally compresses to .zip

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts\pack-portable.ps1
  powershell -ExecutionPolicy Bypass -File scripts\pack-portable.ps1 -NoZip
#>
param(
    [switch]$NoZip,
    [string]$NodeVersion = "",
    [string]$MinGitVersion = "2.53.0.2",
    [string]$OutputDir = "happyclaw-portable"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# Auto-detect Node version from system if not specified
if (!$NodeVersion) {
    $NodeVersion = (node --version 2>$null) -replace '^v', ''
    if (!$NodeVersion) {
        Write-Host "[ERROR] Node.js not found. Specify -NodeVersion manually." -ForegroundColor Red
        exit 1
    }
}

Write-Host "=== HappyClaw Portable Packager ===" -ForegroundColor Cyan
Write-Host "Root: $root"
Write-Host "Node: v$NodeVersion"
Write-Host "MinGit: v$MinGitVersion"
Write-Host ""

# --- 1. Download portable Node.js ---
$nodeZip = "node-v${NodeVersion}-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v${NodeVersion}/$nodeZip"
$cacheDir = Join-Path $root ".pack-cache"
$cachedZip = Join-Path $cacheDir $nodeZip

if (!(Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir | Out-Null }

if (!(Test-Path $cachedZip)) {
    Write-Host "[1/6] Downloading Node.js v$NodeVersion..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $nodeUrl -OutFile $cachedZip -UseBasicParsing
    Write-Host "       Downloaded to $cachedZip"
} else {
    Write-Host "[1/6] Node.js v$NodeVersion already cached." -ForegroundColor Green
}

# --- 1b. Download MinGit for Windows (busybox variant) ---
$mgParts = $MinGitVersion -split '\.'
if ($mgParts.Count -le 3) {
    $mgTag = "v$MinGitVersion.windows.1"
} else {
    $mgTag = "v$($mgParts[0]).$($mgParts[1]).$($mgParts[2]).windows.$($mgParts[3])"
}
$mgZip = "MinGit-${MinGitVersion}-busybox-64-bit.zip"
$mgUrl = "https://github.com/git-for-windows/git/releases/download/$mgTag/$mgZip"
$mgCachedZip = Join-Path $cacheDir $mgZip

if (!(Test-Path $mgCachedZip)) {
    Write-Host "[1b/6] Downloading MinGit v$MinGitVersion..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $mgUrl -OutFile $mgCachedZip -UseBasicParsing
    Write-Host "        Downloaded to $mgCachedZip"
} else {
    Write-Host "[1b/6] MinGit v$MinGitVersion already cached." -ForegroundColor Green
}

# --- 2. Prepare output directory ---
$out = Join-Path $root $OutputDir
if (Test-Path $out) {
    Write-Host "[2/6] Cleaning previous output..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $out
}
New-Item -ItemType Directory -Path $out | Out-Null
Write-Host "[2/6] Output: $out" -ForegroundColor Green

# --- 3. Extract Node.js (just node.exe) ---
Write-Host "[3/6] Extracting Node.js..." -ForegroundColor Yellow
$nodeDir = Join-Path $out "node"
New-Item -ItemType Directory -Path $nodeDir | Out-Null

$tempExtract = Join-Path $cacheDir "node-extract"
if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
Expand-Archive -Path $cachedZip -DestinationPath $tempExtract -Force

$extractedFolder = Get-ChildItem $tempExtract -Directory | Select-Object -First 1
Copy-Item (Join-Path $extractedFolder.FullName "node.exe") (Join-Path $nodeDir "node.exe")

# Also copy npm/npx for potential future use (config changes, plugin install, etc.)
$npmDir = Join-Path $extractedFolder.FullName "node_modules"
if (Test-Path $npmDir) {
    Copy-Item $npmDir (Join-Path $nodeDir "node_modules") -Recurse
}
$npmCmd = Join-Path $extractedFolder.FullName "npm.cmd"
if (Test-Path $npmCmd) { Copy-Item $npmCmd (Join-Path $nodeDir "npm.cmd") }
$npxCmd = Join-Path $extractedFolder.FullName "npx.cmd"
if (Test-Path $npxCmd) { Copy-Item $npxCmd (Join-Path $nodeDir "npx.cmd") }

Remove-Item -Recurse -Force $tempExtract
Write-Host "       node.exe ready" -ForegroundColor Green

# --- 3b. Extract MinGit ---
Write-Host "[3b/6] Extracting MinGit..." -ForegroundColor Yellow
$mingitDir = Join-Path $out "mingit"
New-Item -ItemType Directory -Path $mingitDir | Out-Null
Expand-Archive -Path $mgCachedZip -DestinationPath $mingitDir -Force
$mgGitExe = Join-Path $mingitDir "cmd" "git.exe"
if (Test-Path $mgGitExe) {
    Write-Host "        mingit/cmd/git.exe ready" -ForegroundColor Green
} else {
    Write-Host "        [WARN] git.exe not found at expected path: $mgGitExe" -ForegroundColor Red
}

# --- 4. Copy runtime files ---
Write-Host "[4/6] Copying runtime files..." -ForegroundColor Yellow

$filesToCopy = @(
    "dist",
    "node_modules",
    "config",
    "container\agent-runner\dist",
    "container\agent-runner\node_modules",
    "container\agent-runner\prompts",
    "container\agent-runner\package.json",
    "container\skills",
    "web\dist",
    "shared",
    "package.json",
    "HappyClaw.bat",
    "WINDOWS-SETUP.md"
)

foreach ($item in $filesToCopy) {
    $src = Join-Path $root $item
    $dst = Join-Path $out $item

    if (!(Test-Path $src)) {
        Write-Host "       SKIP (not found): $item" -ForegroundColor DarkGray
        continue
    }

    $dstParent = Split-Path -Parent $dst
    if (!(Test-Path $dstParent)) {
        New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
    }

    if ((Get-Item $src).PSIsContainer) {
        Copy-Item $src $dst -Recurse -Force
    } else {
        Copy-Item $src $dst -Force
    }
    Write-Host "       + $item" -ForegroundColor DarkGreen
}

# Create empty data directories
$dataDirs = @("data\config", "data\db", "data\groups", "data\ipc", "data\memory", "data\sessions", "data\skills", "data\streaming-buffer")
foreach ($d in $dataDirs) {
    $dp = Join-Path $out $d
    if (!(Test-Path $dp)) { New-Item -ItemType Directory -Path $dp -Force | Out-Null }
}
Write-Host "       + data/ (empty structure)" -ForegroundColor DarkGreen

# Create .env.example
$envExample = @"
# === HappyClaw Configuration ===
# Copy this file to .env and fill in your values.

# Anthropic API Key (required)
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Server port (default: 3000)
# PORT=3000

# --- Feishu Bot (optional) ---
# FEISHU_APP_ID=
# FEISHU_APP_SECRET=

# --- Other IM channels (optional) ---
# TELEGRAM_BOT_TOKEN=
# QQ_APPID=
# QQ_SECRET=
"@
$envExample | Out-File -FilePath (Join-Path $out ".env.example") -Encoding utf8
Write-Host "       + .env.example" -ForegroundColor DarkGreen

# --- 5. Optionally create zip ---
if (!$NoZip) {
    Write-Host "[5/6] Creating zip..." -ForegroundColor Yellow
    $zipPath = Join-Path $root "$OutputDir.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path $out -DestinationPath $zipPath -CompressionLevel Optimal
    $sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host "       Created: $zipPath ($sizeMB MB)" -ForegroundColor Green
} else {
    Write-Host "[5/6] Skipping zip (use without -NoZip to create)." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Cyan
Write-Host "Distribution: $out"
Write-Host ""
Write-Host "To distribute:" -ForegroundColor White
Write-Host "  1. Copy the '$OutputDir' folder (or zip) to colleague's machine"
Write-Host "  2. Colleague creates .env from .env.example with their API key"
Write-Host "  3. Double-click HappyClaw.bat"
Write-Host ""
