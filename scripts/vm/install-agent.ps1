# Bolt-it device agent -- one-time install on a Windows VM.
#
# After this runs once, the machine pulls the current scripts/local-agent.mjs
# from the app on every start and relaunches itself if it ever exits. You never
# copy the file in again, and you never start it by hand again.
#
# Run once, in an ELEVATED PowerShell inside the VM (elevation is what
# fix.toggle_wifi needs later):
#
#   .\install-agent.ps1 -Token "<LOCAL_AGENT_TOKEN from .env.local>" -AppUrl "http://10.0.2.2:3000"
#
#   AppUrl is http://10.0.2.2:3000 on UTM, http://192.168.217.1:3000 on VMware
#   Fusion -- see WINDOWS_VM_DEMO.md section 3.
#
# Remove everything again:
#   schtasks /delete /tn "Bolt-it agent" /f ; Remove-Item -Recurse C:\ProgramData\BoltIt

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$AppUrl,
  [string]$TaskName = "Bolt-it agent"
)

$ErrorActionPreference = "Stop"

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this in an elevated PowerShell -- the agent needs admin to cycle a network adapter."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node is not on PATH. Install it first: winget install OpenJS.NodeJS.LTS"
}

$root = "C:\ProgramData\BoltIt"
New-Item -ItemType Directory -Force -Path $root | Out-Null

# The token is a shared secret, so the directory is Administrators-only.
$acl = Get-Acl $root
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  "BUILTIN\Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  "NT AUTHORITY\SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
Set-Acl -Path $root -AclObject $acl

@{ Token = $Token; AppUrl = $AppUrl.TrimEnd("/") } |
  ConvertTo-Json | Set-Content -Path "$root\config.json" -Encoding UTF8

# ---- the runner: pull the current agent, run it, restart it if it dies -------
# The agent self-exits when the server serves a newer build (see the poll loop
# in local-agent.mjs), so this loop's re-pull-on-exit IS the update mechanism.
# Two guards make auto-update safe on a machine that runs the pulled code as
# admin: a syntax check before a new build is adopted, and crashloop backoff so
# a bad deploy is ignored rather than hammered.
$runner = @'
$ErrorActionPreference = "Stop"
$root = "C:\ProgramData\BoltIt"
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$agent = "$root\local-agent.mjs"

$env:LOCAL_AGENT_TOKEN = $cfg.Token
$env:IT_SUPPORT_APP_URL = $cfg.AppUrl

$fastExits = 0

while ($true) {
  # Pull the current agent. If the app is unreachable, fall back to the copy
  # from last time rather than sitting idle -- a stale agent still beats none.
  try {
    $resp = Invoke-WebRequest -Uri "$($cfg.AppUrl)/api/agent/script" `
      -Headers @{ Authorization = "Bearer $($cfg.Token)" } `
      -OutFile "$agent.new" -UseBasicParsing -TimeoutSec 20 -PassThru
    $build = $resp.Headers["X-Agent-Build"]

    # Do NOT adopt a bundle node cannot even parse. Without this, one broken
    # deploy would crashloop every machine in the fleet -- the fallback below
    # only covers a failed *pull*, not a pulled file that crashes on start.
    & node --check "$agent.new" 2>$null
    if ($LASTEXITCODE -eq 0) {
      Move-Item -Force "$agent.new" $agent
      Write-Host "[bolt-it] pulled agent build $build"
    } else {
      Remove-Item -Force "$agent.new" -ErrorAction SilentlyContinue
      Write-Host "[bolt-it] pulled build $build FAILED node --check -- keeping the last good copy"
      if (-not (Test-Path $agent)) { Start-Sleep -Seconds 15; continue }
    }
  } catch {
    Write-Host "[bolt-it] could not pull agent ($($_.Exception.Message))"
    if (-not (Test-Path $agent)) {
      Write-Host "[bolt-it] and no local copy yet -- retrying in 15s"
      Start-Sleep -Seconds 15
      continue
    }
    Write-Host "[bolt-it] running the copy from last time"
  }

  $started = Get-Date
  node $agent
  $ran = (Get-Date) - $started
  Write-Host "[bolt-it] agent exited ($LASTEXITCODE) after $([int]$ran.TotalSeconds)s"

  # A clean self-exit for an update runs for a while and comes back on the new
  # build. A build that dies in seconds, repeatedly, is a bad deploy: back off
  # so we are not pulling and crashing several times a second.
  if ($ran.TotalSeconds -lt 10) { $fastExits++ } else { $fastExits = 0 }
  if ($fastExits -ge 3) {
    Write-Host "[bolt-it] agent has crashed on startup $fastExits times -- backing off 60s"
    Start-Sleep -Seconds 60
  } else {
    Start-Sleep -Seconds 5
  }
}
'@
Set-Content -Path "$root\run-agent.ps1" -Value $runner -Encoding UTF8

# ---- start it at logon, elevated, and keep it alive -------------------------
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\run-agent.ps1`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Installed. The agent is running now and will start again at every logon."
Write-Host "  restart after editing the agent on the Mac:  schtasks /end /tn `"$TaskName`"; schtasks /run /tn `"$TaskName`""
Write-Host "  watch what it is doing:                      Get-Content $root\journal\*.jsonl -Wait -Tail 5"
