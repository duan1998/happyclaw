<#
.SYNOPSIS
  One-click build: compile → pack portable → build Electron desktop app.

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Write-Host "=== HappyClaw Desktop Builder (Full) ===" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Build all (backend + frontend + agent-runner) ──
Write-Host "[1/4] Compiling TypeScript + Vite build..." -ForegroundColor Yellow
npm run build:all 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] build:all failed" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Build complete" -ForegroundColor Green
Write-Host ""

# ── Step 2: Pack portable (backend + node.exe → happyclaw-portable/) ──
Write-Host "[2/4] Packing portable distribution..." -ForegroundColor Yellow
$packScript = Join-Path $root "scripts\pack-portable.ps1"
& powershell -ExecutionPolicy Bypass -File $packScript -NoZip
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] pack-portable failed" -ForegroundColor Red
    exit 1
}

$portableDir = Join-Path $root "happyclaw-portable"
if (!(Test-Path (Join-Path $portableDir "dist\index.js"))) {
    Write-Host "[ERROR] happyclaw-portable/dist/index.js not found" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Portable packed" -ForegroundColor Green
Write-Host ""

# ── Step 3: Install Electron dependencies ──
Write-Host "[3/4] Installing Electron dependencies..." -ForegroundColor Yellow
Set-Location (Join-Path $root "desktop")
npm install 2>&1 | Write-Host
Set-Location $root
Write-Host "[OK] Dependencies ready" -ForegroundColor Green
Write-Host ""

# ── Step 4: Build Electron app ──
Write-Host "[4/4] Building Electron app..." -ForegroundColor Yellow
Set-Location (Join-Path $root "desktop")
$savedPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
npx electron-builder --win 2>&1 | Write-Host
$ErrorActionPreference = $savedPref
Set-Location $root

$releaseDir = Join-Path $root "desktop\release"
$installer = Get-ChildItem $releaseDir -Filter "HappyClaw-Setup-*.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$installer) {
    Write-Host "[ERROR] Build failed - installer exe not found in $releaseDir" -ForegroundColor Red
    exit 1
}
Write-Host "[OK] Electron app built" -ForegroundColor Green

# ── Done ──
Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Build complete!" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Output: $($installer.FullName)" -ForegroundColor Green
Write-Host "Size:   $([math]::Round($installer.Length / 1MB, 1)) MB" -ForegroundColor Green
Write-Host ""
Write-Host "To distribute:" -ForegroundColor White
Write-Host "  1. Send the installer exe to colleague"
Write-Host "  2. Colleague runs installer (auto creates desktop shortcut)"
Write-Host "  3. First launch: configure API key in Settings"
Write-Host ""
