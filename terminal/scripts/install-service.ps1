<#
.SYNOPSIS
  Install (or update / uninstall) the trading terminal as an always-on Windows
  service using NSSM, so it runs on boot with no window and restarts on crash.

.DESCRIPTION
  Registers "node dist/index.js" as a Windows service whose working directory is
  terminal\server, so it uses the SAME data\terminal.json as `npm start` (your
  accounts, hooks and managed positions). Downloads NSSM automatically if it
  isn't already on PATH or next to this script. Re-run any time to refresh.

  The build (npm install + npm run build) runs in YOUR window so any error is
  visible and stops the update. Only the service step is elevated. After it
  runs, the script verifies what the service is actually serving (folder,
  commit, and the served bundle) and warns loudly if that doesn't match the
  folder you just built — the usual cause of "my update didn't take".

.PARAMETER ServiceName
  Service name (default: TradeHook).

.PARAMETER Port
  Port the terminal listens on (default: 8720).

.PARAMETER Update
  Rebuild the app and restart the existing service (use after `git pull`).

.PARAMETER Uninstall
  Stop and remove the service.

.PARAMETER Elevated
  Internal use only — set on the auto-elevated re-launch. Do not pass manually.

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
  [switch]$Uninstall,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

# Run an external program WITHOUT letting its stderr become a terminating error.
# In Windows PowerShell 5.1, a native command that writes to stderr raises a
# NativeCommandError under $ErrorActionPreference='Stop' (even with 2>$null) —
# e.g. `nssm status` on a missing service. Returns the process exit code.
function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ArgList
  )
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $FilePath @ArgList 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
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
    if ((Invoke-Native $npm 'install') -ne 0) { throw 'npm install failed.' }
    if ((Invoke-Native $npm 'run' 'build') -ne 0) { throw 'npm run build failed.' }
  } finally { Pop-Location }
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

# Kill whatever is still holding the port so a fresh node can bind with the NEW
# code. This is what makes an update actually take: an `nssm restart` alone does
# not always cycle the node child, and a stray manual `npm start` squatting on
# the port would keep the old build alive. Needs admin (service-owned process).
function Stop-PortListeners {
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host "  freeing port $Port (stopping PID $($proc.Id) $($proc.ProcessName))" -ForegroundColor DarkGray
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

# --- Service operations (run elevated) ---------------------------------------
function Invoke-ServiceOps {
  $nssm = Get-Nssm

  if ($Uninstall) {
    Write-Host "Removing service '$ServiceName'..." -ForegroundColor Yellow
    Invoke-Native 'sc.exe' 'stop' $ServiceName | Out-Null
    Start-Sleep -Seconds 1
    Invoke-Native 'sc.exe' 'delete' $ServiceName | Out-Null
    Write-Host 'Removed (if it existed).' -ForegroundColor Green
    return
  }

  if (-not (Test-Path $dist)) { throw "Build output not found at $dist (did the build step run?)" }

  # Update path: stop, free the port, start — a hard cycle so the new code loads.
  if ($Update -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Write-Host "Restarting '$ServiceName' with the new build..." -ForegroundColor Cyan
    Invoke-Native $nssm 'stop' $ServiceName | Out-Null
    Start-Sleep -Seconds 1
    Stop-PortListeners
    Invoke-Native $nssm 'start' $ServiceName | Out-Null
    return
  }

  # Install / reinstall.
  $nodeExe = Get-NodePath
  New-Item -ItemType Directory -Force -Path (Join-Path $serverDir 'logs') | Out-Null
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "Reinstalling existing service '$ServiceName'..." -ForegroundColor Yellow
    Invoke-Native $nssm 'stop' $ServiceName | Out-Null
    Invoke-Native $nssm 'remove' $ServiceName 'confirm' | Out-Null
    Start-Sleep -Seconds 1
  }
  Stop-PortListeners
  Write-Host "Installing service '$ServiceName'..." -ForegroundColor Cyan
  if ((Invoke-Native $nssm 'install' $ServiceName $nodeExe 'dist\index.js') -ne 0) { throw 'nssm install failed.' }
  Invoke-Native $nssm 'set' $ServiceName 'AppDirectory' $serverDir | Out-Null
  Invoke-Native $nssm 'set' $ServiceName 'Start' 'SERVICE_AUTO_START' | Out-Null
  Invoke-Native $nssm 'set' $ServiceName 'AppEnvironmentExtra' "PORT=$Port" | Out-Null
  Invoke-Native $nssm 'set' $ServiceName 'AppStdout' (Join-Path $serverDir 'logs\out.log') | Out-Null
  Invoke-Native $nssm 'set' $ServiceName 'AppStderr' (Join-Path $serverDir 'logs\err.log') | Out-Null
  Invoke-Native $nssm 'set' $ServiceName 'AppRotateFiles' '1' | Out-Null
  Invoke-Native $nssm 'set' $ServiceName 'Description' 'Self-hosted crypto trading terminal' | Out-Null
  Invoke-Native $nssm 'start' $ServiceName | Out-Null
}

# --- Verify what the service is actually serving (runs in the visible window) -
# Catches the classic "I updated the wrong folder" trap: prints the folder +
# commit you built, the folder the service runs from, and whether the bundle
# the server hands out matches the one you just built.
function Show-ServedInfo {
  Start-Sleep -Seconds 3
  Write-Host ''
  Write-Host '--- Verifying what the service is serving ---' -ForegroundColor Cyan

  $commit = '(unknown)'
  try { $c = & git -C $terminalDir rev-parse --short HEAD 2>$null; if ($c) { $commit = "$c".Trim() } } catch {}

  $localBundle = ''
  $localIndex = Join-Path $terminalDir 'web\dist\index.html'
  if (Test-Path $localIndex) {
    $m = [regex]::Match((Get-Content $localIndex -Raw), 'assets/(index-[\w.-]+\.js)')
    if ($m.Success) { $localBundle = $m.Groups[1].Value }
  }

  $servedBundle = ''
  $cc = ''
  try {
    $r = Invoke-WebRequest "http://localhost:$Port/" -UseBasicParsing -TimeoutSec 6
    $cc = "$($r.Headers['Cache-Control'])"
    $m2 = [regex]::Match([string]$r.Content, 'assets/(index-[\w.-]+\.js)')
    if ($m2.Success) { $servedBundle = $m2.Groups[1].Value }
  } catch {
    Write-Warning "Could not reach http://localhost:$Port/ — is the service running? ($($_.Exception.Message))"
  }

  $appDir = ''
  try { $nssm = Get-Nssm; $appDir = (& $nssm get $ServiceName AppDirectory 2>$null | Out-String).Trim() } catch {}

  Write-Host ("Built from folder : {0}" -f $terminalDir)
  Write-Host ("Git commit        : {0}" -f $commit)
  if ($appDir) { Write-Host ("Service runs from : {0}" -f $appDir) }
  Write-Host ("Cache-Control     : {0}" -f $cc)
  Write-Host ("Built bundle      : {0}" -f $localBundle)
  Write-Host ("Served bundle     : {0}" -f $servedBundle)

  if ($localBundle -and $servedBundle -and $localBundle -eq $servedBundle) {
    Write-Host "OK - the service is serving the build you just made (commit $commit)." -ForegroundColor Green
  } else {
    Write-Warning 'The service is NOT serving the build you just made.'
    $sameFolder = $false
    if ($appDir) {
      try { $sameFolder = ((Resolve-Path $appDir).Path.TrimEnd('\') -ieq $serverDir.TrimEnd('\')) } catch {}
    }
    if ($appDir -and -not $sameFolder) {
      Write-Warning ("Folder mismatch: the service runs from '{0}', but you built '{1}'." -f $appDir, $serverDir)
      Write-Host   'Update THAT folder instead, or re-run this installer from it to repoint the service:' -ForegroundColor Yellow
      Write-Host   ("    cd '{0}'" -f (Split-Path $appDir)) -ForegroundColor Yellow
      Write-Host   '    git pull ; .\scripts\install-service.ps1 -Update' -ForegroundColor Yellow
    } else {
      Write-Warning 'Same folder, but the old build is still being served — the process may not have restarted. Re-run -Update, or reboot.'
    }
  }
  Write-Host ("Open the terminal at http://localhost:{0}" -f $Port) -ForegroundColor Green
}

# --- Elevated re-launch: only run the service step, then exit -----------------
if ($Elevated) {
  if (-not (Test-Admin)) { throw 'Elevation failed (not running as administrator).' }
  Invoke-ServiceOps
  exit 0
}

# --- Main (runs in YOUR window) ----------------------------------------------
# 1) Build here so any error is visible and stops the update (skip for uninstall).
if (-not $Uninstall) { Invoke-Build }

# 2) Service ops need admin. Do them here if already elevated, else re-launch
#    elevated and WAIT so we can verify afterwards in this window.
if (Test-Admin) {
  Invoke-ServiceOps
} else {
  Write-Host 'Requesting administrator rights for the service step...' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
    '-Elevated', '-ServiceName', $ServiceName, '-Port', "$Port")
  if ($Update) { $argList += '-Update' }
  if ($Uninstall) { $argList += '-Uninstall' }
  $proc = Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    Write-Warning "The elevated service step exited with code $($proc.ExitCode)."
  }
}

# 3) Report (visible), unless we just removed the service.
if ($Uninstall) {
  Write-Host "Service '$ServiceName' removed." -ForegroundColor Green
} else {
  Show-ServedInfo
  Write-Host "Data file: $serverDir\data\terminal.json" -ForegroundColor DarkGray
  Write-Host "Update later: install-service.ps1 -Update   |   Remove: install-service.ps1 -Uninstall" -ForegroundColor DarkGray
}
