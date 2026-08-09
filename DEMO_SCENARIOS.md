# Demo scenarios

Six tickets to film, in running order. Each one is a real break on a real machine fixed by a real
job — there is no scripted path and no branch on ticket text.

Setup for all of them is [WINDOWS_VM_DEMO.md](WINDOWS_VM_DEMO.md). Everything below assumes the VM
is up, the agent is running as the scheduled task, and the app is on the Mac.

## Before you film

Run each break state once, off camera, and watch the ticket complete. Three of these depend on
Windows behaviour that varies by build and by how the agent is installed:

- **`winget` under the scheduled task.** winget is a per-user MSIX. Running it from a task with
  highest privileges is the case most likely to fail. If it does, run the agent interactively in the
  user's session for that demo and say so.
- **The shell restart landing in the user's session.** If the agent runs as SYSTEM, a `Start-Process
  explorer.exe` it issues can land in session 0 and the taskbar never comes back. Windows normally
  relaunches the shell itself; the handler fails the step honestly if it does not.
- **`Get-PnpDevice` finding a camera at all.** A VM only has one if you passed the Mac's webcam
  through. If it does not, point demo 4 at any device you disable in Device Manager and change the
  ticket wording — the capability does not care which device it is.

## The evidence, on every ticket

This is the part worth filming slowly. It is the same on all six.

1. **The tray icon** turns blue the moment the job starts, with a balloon naming it. Double-click it
   for everything that ran on the machine today, reads included, each with its verdict.
2. **`/audit/<ticketId>`** — full width, nothing else on screen. Every probe with the exact command
   that produced it, the field-level before → after diff, every argv with its exit code and full
   stdout, the rollback outcome, and the journal / change-record / undo paths.
3. **Paste a probe command into a terminal on the VM.** Read it off the audit page, hand someone the
   keyboard, compare. Better with a sceptic driving.
4. **Event Viewer → Windows Logs → Application, source `BoltIt`.** Same job, same verdict, in a log
   this system does not own.
5. **The undo.** Where the fix was `reversible: "recorded"`, the exact restore command is on the
   page. Run it, re-probe, watch the state go back.

Say the two redaction caveats before anyone finds them: output is redacted twice and the
product-key pattern is blunt, and the on-machine journal is written un-redacted so it holds more
than the page does.

---

## 1. No sound

**Needs nothing new** — `fix.restart_service` has shipped for months.

| | |
|---|---|
| **Break** | `Stop-Service -Name Audiosrv -Force` |
| **Ticket** | "I've got no sound at all. Speakers work on my phone." |
| **Fix** | `fix.restart_service --service Audiosrv` |
| **Diff** | `state Stopped → Running` |

Play a video before and after. **The audio carries over the screen share** — the only demo here the
room hears rather than sees. Thirty seconds, zero risk, good opener.

## 2. The taskbar is gone

**New:** `fix.restart_shell`, `fix.set_taskbar_autohide`.

Two different causes, two different fixes, and this is worth saying on camera: restarting the shell
does nothing for auto-hide, and flipping auto-hide does nothing for a dead shell.

| | |
|---|---|
| **Break A** (deterministic) | Turn on taskbar auto-hide: Settings → Personalization → Taskbar → Taskbar behaviors |
| **Break B** (dramatic, test first) | `taskkill /f /im explorer.exe` |
| **Ticket** | "My taskbar has disappeared. I can't get to the Start menu." |
| **Fix A** | `fix.set_taskbar_autohide --autohide false` → diff `autoHide on → off` |
| **Fix B** | `fix.restart_shell` → diff `pid 4180 → 9022` |

Prefer Break A on camera: it is deterministic, it diffs cleanly, and it has a genuine recorded undo
you can run afterwards. Break B is more dramatic but Win11 sometimes relaunches the shell before the
agent gets there, and a break state that heals itself is a bad ninety seconds.

The auto-hide fix restarts the shell to apply the setting, so **the taskbar visibly comes back on
the Windows screen** either way.

## 3. "My laptop is slow"

**New:** `fix.kill_process`, `fix.set_startup_item`.

The best pure-diagnosis demo. The employee said "slow". The agent names the culprit.

| | |
|---|---|
| **Break** | Start something that pegs a core, and add three or four junk entries under `HKCU\...\CurrentVersion\Run` |
| **Ticket** | "Machine has been crawling all week. I've restarted it twice." |
| **Reads** | `diag.process_list`, `tasklist`, `quser` — all already allowlisted |
| **Fix** | `fix.kill_process --app "<culprit>"` → diff `running true → false` |
| **Then** | `fix.set_startup_item --item "<junk>" --enabled false` → diff `enabled 7 → 6` |

Two things to say out loud:

- `fix.kill_process` is **risk 2, not risk 1, and it has no undo** — a restart gives the app a chance
  to save and this does not. The employee's unwritten work is the cost of being wrong.
- The startup fix flips the same approval byte Task Manager's Startup tab writes. **The Run entry is
  never deleted**, which is why it has a recorded undo and the kill does not.

System processes are refused by name in the handler, before anything runs. Worth demonstrating: file
a ticket that would end `lsass` and show the refusal in the envelope with no `Stop-Process` in it.

## 4. "My camera doesn't work and I have a call in five minutes"

**New:** `fix.enable_device`.

| | |
|---|---|
| **Break** | Device Manager → disable the camera |
| **Ticket** | "Camera is dead in Teams. I have a call at 2." |
| **Fix** | `fix.enable_device --device "Integrated Camera"` |
| **Diff** | `status Error → OK`, `problem 22 → 0` |

Open the Camera app before and after. Recorded undo: it disables again using the instance id the
before-probe captured.

## 5. VPN — connected, but nothing works

**New:** `diag.vpn_state`. Uses the existing `fix.flush_dns`, `fix.set_dns_servers`,
`diag.http_check`. `fix.reconnect_vpn` covers the variant where the tunnel is genuinely down.

The deep one. Pick this if you only film one.

Needs the WireGuard tunnel and the fake intranet from WINDOWS_VM_DEMO.md: an HTTP server on the Mac
bound **only** to the WireGuard address, and a resolver on that address serving `intranet.corp`.
Without the tunnel the name does not resolve and the address is not routable — you can prove that by
dropping the tunnel on camera.

| | |
|---|---|
| **Break** | Connect the tunnel, then point the tunnel adapter's DNS at the local resolver instead of the one inside the tunnel |
| **Ticket** | "VPN says connected but I can't get to the intranet. Tried restarting twice." |

The run:

1. `diag.network_state` fires on the START edge — the strategist opens with readings in hand.
2. `diag.vpn_state` → `connected=true · tunnel_ip=10.9.0.2 · tunnel_dns=192.168.217.1`. **That last
   fact is the entire diagnosis, and it is a read.**
3. **The agent contradicts the employee**: the VPN is fine, name lookups are going to your home
   router instead of through the tunnel.
4. The ladder tries the cheap thing first — `fix.flush_dns`. It lands, the run parks on the rung
   check, the employee answers **still broken**.
5. It climbs for **zero model calls**, because the run was paused rather than finished. Put the
   `/api/state` token counter on screen for this beat.
6. `fix.set_dns_servers` → diff `resolvers 192.168.217.1 → 10.9.0.1`. Load `intranet.corp` in the
   VM's browser. That is the moment.
7. Run the undo off the audit page. The intranet dies again.

**The encore worth more than the fix:** kill the WireGuard server on the Mac and refile. The agent
reads that the handshake never completes and no tunnel address was assigned, and **escalates to a
human with those readings attached** instead of reconnecting four times and declaring victory. A
demo where the agent knows it is beaten is the answer to "what happens when it can't fix it", which
is the first question anyone asks.

## 6. "I installed it and it just doesn't open"

**New:** `fix.install_package`. Ends the session on the approval gate.

| | |
|---|---|
| **Break** | Install something built against a VC++ runtime the VM does not have. Launching it exits instantly with no window and no error |
| **Ticket** | "I installed it this morning and nothing happens when I double-click. No error, nothing." |
| **Reads** | `diag.app_status` → not running. `diag.app_logs` → the real Application event log, `Application Error`, faulting module `VCRUNTIME140.dll` |
| **Fix** | `fix.install_package --package "Microsoft.VCRedist.2015+.x64"` |
| **Diff** | `installed false → true`, `version none → 14.40.33810` |

The point to land: **the answer was in a log the employee will never open.** The failure was silent —
no dialog, no message — so there was nothing for a human to escalate with.

Then the ending you want: this is **risk 3**, so at `AUTONOMY=gated` it stops dead at the approval
gate and a named technician clicks once before anything installs. Six minutes of the machine fixing
itself, finishing on "and it still asked permission."

A cheaper variant needing no new capability: corrupt the app's config under `%LOCALAPPDATA%\<app>`
and let `fix.clear_app_cache` fix it. Same story, less setup, no gate.

---

## Running order

Visible → visible → clever → urgent → deep → trustworthy.

1. No sound (30s, audible)
2. Taskbar (visual shock)
3. Slow laptop (the turn — diagnosis, not remote control)
4. Camera (urgency everyone recognises)
5. VPN (the deep one)
6. App won't open (the gate)

## The one to show off

File a fix you know will do nothing — set the DNS resolvers to the values already configured. The
commands exit 0, both probes read identically, the diff is empty, and the ticket says **not fixed**.
A system that wanted to look good would have reported success on those exit codes.
