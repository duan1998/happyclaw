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

# Build unpacked app
Write-Host ""
Write-Host "[2/3] Building app..." -ForegroundColor Yellow
$savedPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
npx electron-builder --win 2>&1 | Write-Host
$ErrorActionPreference = $savedPref

$unpackedDir = Join-Path $root "desktop\release\win-unpacked"
if (!(Test-Path (Join-Path $unpackedDir "HappyClaw.exe"))) {
    Write-Host "[ERROR] Build failed — win-unpacked\HappyClaw.exe not found" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "=== Done! ===" -ForegroundColor Cyan
Write-Host "Output: $unpackedDir" -ForegroundColor Green
Write-Host ""
Write-Host "To distribute:" -ForegroundColor White
Write-Host "  1. Zip win-unpacked/ folder and send to colleague"
Write-Host "  2. Colleague unzips, creates .env with ANTHROPIC_API_KEY next to HappyClaw.exe"
Write-Host "  3. Double-click HappyClaw.exe"
