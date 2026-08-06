# Bolt-it device agent — one-time install on a Windows VM.
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
#   Fusion — see WINDOWS_VM_DEMO.md section 3.
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
  throw "Run this in an elevated PowerShell — the agent needs admin to cycle a network adapter."
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
$runner = @'
$ErrorActionPreference = "Stop"
$root = "C:\ProgramData\BoltIt"
$cfg = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$agent = "$root\local-agent.mjs"

$env:LOCAL_AGENT_TOKEN = $cfg.Token
$env:IT_SUPPORT_APP_URL = $cfg.AppUrl

while ($true) {
  # Pull the current agent. If the app is unreachable, fall back to the copy
  # from last time rather than sitting idle — a stale agent still beats none.
  try {
    Invoke-WebRequest -Uri "$($cfg.AppUrl)/api/agent/script" `
      -Headers @{ Authorization = "Bearer $($cfg.Token)" } `
      -OutFile "$agent.new" -UseBasicParsing -TimeoutSec 20
    Move-Item -Force "$agent.new" $agent
    Write-Host "[bolt-it] pulled current agent from $($cfg.AppUrl)"
  } catch {
    Write-Host "[bolt-it] could not pull agent ($($_.Exception.Message))"
    if (-not (Test-Path $agent)) {
      Write-Host "[bolt-it] and no local copy yet — retrying in 15s"
      Start-Sleep -Seconds 15
      continue
    }
    Write-Host "[bolt-it] running the copy from last time"
  }

  node $agent
  Write-Host "[bolt-it] agent exited ($LASTEXITCODE) — restarting in 5s"
  Start-Sleep -Seconds 5
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
