<#
.SYNOPSIS
  Expose the local terminal over your Tailscale network so you can reach it from
  your phone (or any device on the tailnet) privately, over HTTPS.

.DESCRIPTION
  Uses `tailscale serve` to publish https://<this-machine>.<tailnet>.ts.net and
  proxy it to the terminal on localhost. Tailnet-only — NOT exposed to the public
  internet, and no firewall changes needed for this path.

  Prerequisites (one time):
    1. Install Tailscale on this PC AND your phone, signed in to the same account
       (https://tailscale.com/download).
    2. Enable MagicDNS + HTTPS Certificates for your tailnet in the admin console
       (https://login.tailscale.com/admin/dns).

.PARAMETER Port
  Local terminal port (default 8720).

.PARAMETER DirectPort
  Also open the Windows firewall so http://<tailscale-ip>:<port> works directly
  (rule is scoped to the Tailscale network interface). Optional; Serve alone is
  usually enough.

.PARAMETER Off
  Undo: stop serving and remove the firewall rule.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tailscale-access.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tailscale-access.ps1 -Off
#>
[CmdletBinding()]
param(
  [int]$Port = 8720,
  [switch]$DirectPort,
  [switch]$Off
)

$ErrorActionPreference = 'Stop'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# `tailscale serve` and firewall changes need admin on Windows; self-elevate.
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

function Get-Tailscale {
  $c = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
  if (Test-Path $p) { return $p }
  throw 'Tailscale not found. Install from https://tailscale.com/download/windows, sign in, then re-run.'
}

$ts = Get-Tailscale
$ruleName = "TradeHook $Port (Tailscale)"

# --- Undo --------------------------------------------------------------------
if ($Off) {
  & $ts serve reset 2>$null
  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Write-Host 'Tailscale sharing disabled.' -ForegroundColor Green
  exit
}

# --- Check Tailscale is connected and learn this node's identity -------------
$status = (& $ts status --json 2>$null) | ConvertFrom-Json
if (-not $status) { throw "Couldn't query Tailscale. Is it installed and running?" }
if ($status.BackendState -ne 'Running') {
  throw "Tailscale isn't connected (state: $($status.BackendState)). Run 'tailscale up', sign in, then re-run."
}
$dns = ([string]$status.Self.DNSName).TrimEnd('.')
$ip = @($status.Self.TailscaleIPs) | Select-Object -First 1

# --- Enable Serve (HTTPS, tailnet-only) --------------------------------------
Write-Host "Publishing the terminal on your tailnet (port $Port)..." -ForegroundColor Cyan
& $ts serve --bg $Port
$served = ($LASTEXITCODE -eq 0)
if (-not $served) {
  Write-Warning @'
`tailscale serve` failed. Most often this means HTTPS isn't enabled for the
tailnet: open https://login.tailscale.com/admin/dns and turn on MagicDNS +
HTTPS Certificates, then re-run. (You can still use the direct IP with -DirectPort.)
'@
}

# --- Optional: direct IP:port via a scoped firewall rule ---------------------
if ($DirectPort) {
  if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    $tsIf = Get-NetAdapter -ErrorAction SilentlyContinue |
      Where-Object { $_.InterfaceDescription -match 'Tailscale' -or $_.Name -match 'Tailscale' } |
      Select-Object -First 1
    $params = @{ DisplayName = $ruleName; Direction = 'Inbound'; Action = 'Allow'; Protocol = 'TCP'; LocalPort = $Port }
    if ($tsIf) { $params.InterfaceAlias = $tsIf.Name } else { $params.Profile = 'Private' }
    New-NetFirewallRule @params | Out-Null
    Write-Host "Firewall rule added: $ruleName" -ForegroundColor Green
  }
}

# --- Report ------------------------------------------------------------------
Write-Host ''
Write-Host 'Reachable from any device signed in to your tailnet:' -ForegroundColor Green
if ($served -and $dns) { Write-Host "  https://$dns" -ForegroundColor Green }
if ($DirectPort -and $ip) { Write-Host "  http://${ip}:$Port   (direct IP)" -ForegroundColor Green }
if (-not $served -and -not $DirectPort -and $ip) {
  Write-Host "  http://${ip}:$Port   (re-run with -DirectPort to allow this)" -ForegroundColor DarkYellow
}
Write-Host ''
Write-Host 'On your phone: install the Tailscale app, sign in to the SAME account,' -ForegroundColor DarkGray
Write-Host 'keep it connected, then open the https URL above.' -ForegroundColor DarkGray
Write-Host 'Undo with:  tailscale-access.ps1 -Off' -ForegroundColor DarkGray
Write-Host ''
& $ts serve status 2>$null
