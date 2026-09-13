<#
.SYNOPSIS
  Install (or update / uninstall) the trading terminal as an always-on Windows
  service using NSSM, so it runs on boot with no window and restarts on crash.

.DESCRIPTION
  Registers "node dist/index.js" as a Windows service whose working directory is
  terminal\server, so it uses the SAME data\terminal.json as `npm start` (your
  accounts, hooks and managed positions). Downloads NSSM automatically if it
  isn't already on PATH or next to this script. Re-run any time to refresh.

.PARAMETER ServiceName
  Service name (default: TradeHook).

.PARAMETER Port
  Port the terminal listens on (default: 8720).

.PARAMETER Update
  Rebuild the app and restart the existing service (use after `git pull`).

.PARAMETER Uninstall
  Stop and remove the service.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-service.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Update
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'TradeHook',
  [int]$Port = 8720,
  [switch]$Update,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Re-launch elevated (services require admin), preserving parameters.
if (-not (Test-Admin)) {
  Write-Host 'Requesting administrator rights...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [switch]) { if ($kv.Value.IsPresent) { $argList += "-$($kv.Key)" } }
    else { $argList += "-$($kv.Key)"; $argList += "$($kv.Value)" }
  }
  Start-Process powershell -Verb RunAs -ArgumentList $argList
  exit
}

# --- Resolve paths -----------------------------------------------------------
$terminalDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$serverDir = (Resolve-Path (Join-Path $terminalDir 'server')).Path
$dist = Join-Path $serverDir 'dist\index.js'

function Get-NodePath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'Node.js not found. Install it from https://nodejs.org and re-run.'
}

function Invoke-Build {
  $nodeExe = Get-NodePath
  $npm = Join-Path (Split-Path $nodeExe) 'npm.cmd'
  if (-not (Test-Path $npm)) { $npm = 'npm.cmd' }
  Write-Host 'Building (npm install + npm run build)...' -ForegroundColor Cyan
  Push-Location $terminalDir
  try {
    & $npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
  } finally { Pop-Location }
}

# --- Uninstall ---------------------------------------------------------------
if ($Uninstall) {
  Write-Host "Removing service '$ServiceName'..." -ForegroundColor Yellow
  cmd /c "sc.exe stop `"$ServiceName`"" | Out-Null
  Start-Sleep -Seconds 1
  cmd /c "sc.exe delete `"$ServiceName`"" | Out-Null
  Write-Host "Removed (if it existed)." -ForegroundColor Green
  exit
}

# --- Locate or download NSSM -------------------------------------------------
function Get-Nssm {
  $onPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $local = Join-Path $PSScriptRoot 'nssm.exe'
  if (Test-Path $local) { return $local }

  Write-Host 'Downloading NSSM...' -ForegroundColor Cyan
  $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
  $out = Join-Path $env:TEMP ('nssm-' + [guid]::NewGuid())
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $out -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
  Copy-Item (Join-Path $out "nssm-2.24\$arch\nssm.exe") $local -Force
  return $local
}

# --- Update (rebuild + restart) ----------------------------------------------
if ($Update) {
  Invoke-Build
  $nssm = Get-Nssm
  Write-Host "Restarting '$ServiceName'..." -ForegroundColor Cyan
  & $nssm restart $ServiceName
  Write-Host "Updated. UI at http://localhost:$Port" -ForegroundColor Green
  exit
}

# --- Install / reinstall -----------------------------------------------------
if (-not (Test-Path $dist)) { Invoke-Build }
if (-not (Test-Path $dist)) { throw "Build output not found at $dist" }

$nodeExe = Get-NodePath
$nssm = Get-Nssm
New-Item -ItemType Directory -Force -Path (Join-Path $serverDir 'logs') | Out-Null

# Replace any existing definition so paths/port stay correct on re-run.
& $nssm status $ServiceName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Reinstalling existing service '$ServiceName'..." -ForegroundColor Yellow
  & $nssm stop $ServiceName 2>$null | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
}

Write-Host "Installing service '$ServiceName'..." -ForegroundColor Cyan
& $nssm install $ServiceName $nodeExe 'dist\index.js'
& $nssm set $ServiceName AppDirectory $serverDir
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppEnvironmentExtra "PORT=$Port"
& $nssm set $ServiceName AppStdout (Join-Path $serverDir 'logs\out.log')
& $nssm set $ServiceName AppStderr (Join-Path $serverDir 'logs\err.log')
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName Description 'Self-hosted crypto trading terminal'
& $nssm start $ServiceName

Write-Host ''
Write-Host "Done. '$ServiceName' is running and will start on boot." -ForegroundColor Green
Write-Host "Open the terminal at http://localhost:$Port" -ForegroundColor Green
Write-Host "Data file: $serverDir\data\terminal.json" -ForegroundColor DarkGray
Write-Host "Update later: install-service.ps1 -Update   |   Remove: install-service.ps1 -Uninstall" -ForegroundColor DarkGray
