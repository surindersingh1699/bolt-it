# Bolt-it agent -- the tray app the person at the machine actually sees.
#
# The agent already writes everything it does to three places: its own journal,
# a change record with the undo command, and the OS event log. All three are
# files, and a file nobody opens is not visible work. The web console it serves
# on loopback is closer, but a browser tab is something you go and look for --
# during a demo, and on a real employee's machine, the question "is this thing
# doing anything to my computer right now?" has to be answerable without going
# to look for the answer.
#
# So: a tray icon that changes colour the moment a job starts, a balloon naming
# what is running, and a window listing what has actually been done to this
# machine, read from the journal the agent writes anyway. Same shape as a VPN
# client, for the same reason.
#
# It reads. It never runs a device command, and the only thing it can send is
# the pause/resume the local console already exposes -- to loopback, which the
# agent already refuses to answer from anywhere else.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File agent-tray.ps1
#
# install-agent.ps1 registers this at logon; run it by hand to check it works.

[CmdletBinding()]
param(
  [int]$Port = 7337,
  [string]$Root = "C:\ProgramData\BoltIt",
  [string]$TaskName = "Bolt-it agent"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Console  = "http://127.0.0.1:$Port"
$script:LastJob  = $null
$script:State    = $null
$script:Activity = @()

# ---- reading what the agent did --------------------------------------------

function Get-AgentState {
  # The agent's own console. Unreachable means the agent process is not running:
  # that is a different thing from "the app is unreachable", which the state
  # itself reports, and the icon has to tell them apart.
  try {
    Invoke-RestMethod -Uri "$script:Console/api/state" -TimeoutSec 2 -ErrorAction Stop
  } catch {
    $null
  }
}

function Get-Activity {
  # Every job lands in the journal -- reads included -- so this is the complete
  # footprint, not just the changes. Today's file only: the window is "what has
  # this thing done to my machine", not an archive.
  $file = Join-Path $Root ("journal\" + (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd") + ".jsonl")
  if (-not (Test-Path $file)) { return @() }
  $rows = @()
  # ReadAllLines rather than Get-Content -Tail: the agent appends while we read,
  # and a half-written final line must be skipped rather than crash the parse.
  foreach ($line in (Get-Content -Path $file -ErrorAction SilentlyContinue | Select-Object -Last 60)) {
    try { $rows += ($line | ConvertFrom-Json) } catch { }
  }
  [array]::Reverse($rows)
  return $rows
}

function Format-Row($r) {
  $when = ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$r.startedAt)).LocalDateTime.ToString("HH:mm:ss")
  $verdict = if (-not $r.ok) { "FAILED " } elseif ($r.expectsChange -and $r.effect.changed) { "CHANGED" }
             elseif ($r.expectsChange) { "NO EFFECT" } else { "read   " }
  $what = $r.command
  $detail = if ($r.error) { $r.error } else { $r.effect.summary }
  if ($detail.Length -gt 90) { $detail = $detail.Substring(0, 90) + "..." }
  "$when  $verdict  $what`r`n            $detail"
}

# ---- the icon ---------------------------------------------------------------

function New-DotIcon([System.Drawing.Color]$color) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), 2, 2, 12, 12)
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icons = @{
  running = New-DotIcon ([System.Drawing.Color]::FromArgb(37, 99, 235))    # blue
  idle    = New-DotIcon ([System.Drawing.Color]::FromArgb(22, 163, 74))    # green
  warn    = New-DotIcon ([System.Drawing.Color]::FromArgb(217, 119, 6))    # amber
  off     = New-DotIcon ([System.Drawing.Color]::FromArgb(120, 120, 120))  # grey
}

# ---- the window -------------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text = "Bolt-it agent"
$form.Size = New-Object System.Drawing.Size(720, 520)
$form.StartPosition = "CenterScreen"
$form.BackColor = [System.Drawing.Color]::FromArgb(14, 17, 22)
$form.ForeColor = [System.Drawing.Color]::FromArgb(230, 233, 239)
$form.ShowInTaskbar = $true

$header = New-Object System.Windows.Forms.Label
$header.Location = New-Object System.Drawing.Point(16, 14)
$header.Size = New-Object System.Drawing.Size(680, 44)
$header.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($header)

$now = New-Object System.Windows.Forms.Label
$now.Location = New-Object System.Drawing.Point(16, 60)
$now.Size = New-Object System.Drawing.Size(680, 24)
$now.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$form.Controls.Add($now)

$list = New-Object System.Windows.Forms.TextBox
$list.Location = New-Object System.Drawing.Point(16, 92)
$list.Size = New-Object System.Drawing.Size(672, 336)
$list.Multiline = $true
$list.ReadOnly = $true
$list.ScrollBars = "Vertical"
$list.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 31)
$list.ForeColor = [System.Drawing.Color]::FromArgb(214, 220, 229)
$list.Font = New-Object System.Drawing.Font("Consolas", 9.5)
$form.Controls.Add($list)

function New-Button($text, $x) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, 440)
  $b.Size = New-Object System.Drawing.Size(150, 30)
  $b.FlatStyle = "Flat"
  $b.BackColor = [System.Drawing.Color]::FromArgb(31, 38, 48)
  $form.Controls.Add($b)
  return $b
}

$btnPause   = New-Button "Pause"          16
$btnJournal = New-Button "Open journal"   174
$btnRestart = New-Button "Restart agent"  332
$btnEvents  = New-Button "Event log"      490

$btnPause.Add_Click({
  $to = if ($script:State -and $script:State.paused) { "resume" } else { "pause" }
  try { Invoke-RestMethod -Uri "$script:Console/api/$to" -Method Post -TimeoutSec 2 | Out-Null }
  catch { [System.Windows.Forms.MessageBox]::Show("The agent is not answering on $script:Console.") }
})
$btnJournal.Add_Click({ Start-Process explorer.exe (Join-Path $Root "journal") })
$btnRestart.Add_Click({
  # The same two commands install-agent.ps1 prints. Restarting is how a machine
  # picks up a new agent build, and it is the fix for every "the agent is not
  # answering" state this window can show.
  Start-Process schtasks.exe -ArgumentList @("/end", "/tn", $TaskName) -Wait -WindowStyle Hidden
  Start-Process schtasks.exe -ArgumentList @("/run", "/tn", $TaskName) -WindowStyle Hidden
})
$btnEvents.Add_Click({ Start-Process eventvwr.exe })

# Closing the window leaves the agent alone -- it hides to the tray, like a VPN
# client. Quitting is an explicit choice in the tray menu.
$form.Add_FormClosing({
  param($sender, $e)
  if ($e.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) {
    $e.Cancel = $true
    $form.Hide()
  }
})

# ---- the tray icon ----------------------------------------------------------

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons.off
$tray.Text = "Bolt-it agent"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add("Show activity", $null, { $form.Show(); $form.WindowState = "Normal"; $form.Activate() })
[void]$menu.Items.Add("Open journal folder", $null, { Start-Process explorer.exe (Join-Path $Root "journal") })
[void]$menu.Items.Add("-")
[void]$menu.Items.Add("Quit this window", $null, {
  # Only the window. The agent is a scheduled task and keeps running -- saying
  # "Quit" and silently stopping the thing that fixes their machine would be a
  # lie the tray icon cannot take back.
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu
$tray.Add_DoubleClick({ $form.Show(); $form.WindowState = "Normal"; $form.Activate() })

# ---- the tick ---------------------------------------------------------------

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $script:State = Get-AgentState
  $script:Activity = Get-Activity

  if (-not $script:State) {
    $tray.Icon = $icons.off
    $tray.Text = "Bolt-it agent - not running"
    $header.Text = "Agent not running on this machine"
    $now.Text = "Nothing can run here until it starts. Use Restart agent."
    $btnPause.Text = "Pause"
  } else {
    $d = $script:State.device
    $s = $script:State.server
    $job = $script:State.currentJob
    $header.Text = "$($d.hostname) - agent $($d.version) - build $($d.build)"

    if ($job) {
      $secs = [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$job.startedAt) / 1000)
      $tray.Icon = $icons.running
      $tray.Text = "Running: $($job.command)"
      $now.Text = "Running now: $($job.command)  ($secs s)"
      # One balloon per job, when it starts. A balloon per tick would be an alarm.
      if ($script:LastJob -ne $job.id) {
        $script:LastJob = $job.id
        $tray.BalloonTipTitle = "Bolt-it is working on this machine"
        $tray.BalloonTipText = $job.command
        $tray.ShowBalloonTip(4000)
      }
    } elseif ($script:State.paused) {
      $tray.Icon = $icons.warn
      $tray.Text = "Paused by you - no work will run"
      $now.Text = "Paused. The service desk can queue work, but nothing runs here until you resume."
    } elseif (-not $s.reachable) {
      $tray.Icon = $icons.warn
      $tray.Text = "Cannot reach $($s.url)"
      $now.Text = "Cannot reach $($s.url) - the agent is running but has nothing to talk to."
    } else {
      $tray.Icon = $icons.idle
      $tray.Text = "Connected to $($s.url) - idle"
      $now.Text = "Connected to $($s.url). Idle, waiting for work."
      $script:LastJob = $null
    }
    $btnPause.Text = if ($script:State.paused) { "Resume" } else { "Pause" }
  }

  if ($script:Activity.Count -eq 0) {
    $list.Text = "Nothing has run on this machine today."
  } else {
    $list.Text = (($script:Activity | ForEach-Object { Format-Row $_ }) -join "`r`n`r`n")
  }
})
$timer.Start()

$tray.BalloonTipTitle = "Bolt-it agent"
$tray.BalloonTipText = "Watching this machine. Double-click to see what has run."
$tray.ShowBalloonTip(3000)

[System.Windows.Forms.Application]::Run()
$tray.Visible = $false
