<#
.SYNOPSIS
  Build HappyClaw Desktop exe.
  Prerequisites: happyclaw-portable/ must exist (run pack-portable.ps1 first).

.USAGE
  powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
#>
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Write-Host "=== HappyClaw Desktop Builder ===" -ForegroundColor Cyan

# Check prerequisite
$portableDir = Join-Path $root "happyclaw-portable"
if (!(Test-Path (Join-Path $portableDir "dist\index.js"))) {
    Write-Host "[ERROR] happyclaw-portable/ not found. Run pack-portable.ps1 first." -ForegroundColor Red
    exit 1
}
Write-Host "[OK] happyclaw-portable/ found" -ForegroundColor Green

# Install Electron dependencies
Write-Host ""
Write-Host "[1/2] Installing Electron dependencies..." -ForegroundColor Yellow
Set-Location (Join-Path $root "desktop")
npm install 2>&1 | Write-Host

# Build exe
Write-Host ""
Write-Host "[2/2] Building exe..." -ForegroundColor Yellow
npx electron-builder --win 2>&1 | Write-Host

# Report result
$exePath = Get-ChildItem -Path (Join-Path $root "desktop\release") -Filter "HappyClaw.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exePath) {
    $sizeMB = [math]::Round($exePath.Length / 1MB, 1)
    Write-Host ""
    Write-Host "=== Done! ===" -ForegroundColor Cyan
    Write-Host "Exe: $($exePath.FullName) ($sizeMB MB)" -ForegroundColor Green
    Write-Host ""
    Write-Host "To distribute:" -ForegroundColor White
    Write-Host "  1. Copy HappyClaw.exe to colleague"
    Write-Host "  2. Colleague creates .env with ANTHROPIC_API_KEY next to the exe"
    Write-Host "  3. Double-click HappyClaw.exe"
} else {
    Write-Host "[ERROR] Build failed — exe not found in desktop\release\" -ForegroundColor Red
    exit 1
}
