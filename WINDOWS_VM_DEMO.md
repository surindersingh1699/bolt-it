# Windows VM demo setup

Goal: a Windows VM running on your Mac with real, breakable state (a crashed app, a full cache) that the agent reaches into and fixes live over screen share — no sleight of hand, no pre-recorded output.

This closes the gap noted in [README.md](README.md) ("Cross-platform local agent — `scripts/local-agent.mjs` is macOS-only today"). `scripts/local-agent.mjs` now branches on `os.platform()` and runs PowerShell/`netsh` on Windows instead of `osascript`/`networksetup`.

## What's real vs. mocked in this demo

| Capability | Real on Windows? | Notes |
|---|---|---|
| `fix.restart_app` | **Yes** | `Stop-Process` + `Start-Process` via PowerShell. Proven by a pid change between the before and after probes. |
| `fix.clear_app_cache` | **Yes** | Deletes `%LOCALAPPDATA%\<app>\Cache`. Proven by file count and size dropping to zero. |
| `diag.system_info` | **Yes** | `Get-CimInstance` (OS, RAM, CPU, uptime) via PowerShell |
| `diag.app_status`, `diag.app_logs` | **Yes** | `Get-Process` / `Get-WinEvent` against the real Application log |
| `fix.toggle_wifi` | **Yes** | Cycles the machine's *primary physical adapter* (whatever `Get-NetAdapter -Physical` reports), so it works against a VM's virtual Ethernet — it no longer hardcodes an adapter named `"Wi-Fi"`. Needs an elevated agent. The guest loses its link for a few seconds; the agent journals locally and uploads once the adapter is back. |
| VPN diagnostics, auth-log and Kerberos-log collection | **Deleted** | These returned canned log lines as `ok: true`. The handlers and the capabilities that referenced them are gone — the planner can no longer choose them, so no ticket can claim that work happened. |

## Proof-of-effect: how you know something really happened

Every device job is **probe → act → probe**. The agent reads the machine's state before the action, runs the commands, reads the state again, and diffs the two. That diff is the only thing allowed to count as success:

- **before/after differ** → job `succeeded`, and the ticket shows the change (`pid 8123 → 9471`).
- **before/after identical** → job `no_effect`. The step is marked failed and the agent retries or escalates. A fix that changed nothing can no longer be reported as a fix.

Every envelope — argv, exit codes, stdout/stderr, both probes, the diff — is appended to a journal on the machine itself **before** it is uploaded:

- Windows: `C:\ProgramData\BoltIt\journal\YYYY-MM-DD.jsonl`
- macOS/Linux: `~/.bolt-it/journal/YYYY-MM-DD.jsonl`
- override with `LOCAL_AGENT_JOURNAL_DIR`

One JSON object per line. It survives the network dropping, the server being wiped, and the demo ending — which is what makes it useful for studying runs afterwards.

### The tray app — the footprint people can actually see

A journal is only visible to someone who opens it. `scripts/vm/agent-tray.ps1` puts the same information where a person watching the machine will see it, in the shape they already recognise from a VPN client:

- a tray icon that turns **blue the moment a job starts**, green when idle and connected, amber when paused or when the app is unreachable, grey when the agent is not running at all;
- a balloon naming the job as it starts;
- a window (double-click the icon) listing everything that has run on this machine today — reads included, not just changes — each with its verdict (`read` / `CHANGED` / `NO EFFECT` / `FAILED`) and the effect summary;
- buttons for pause/resume, opening the journal folder, restarting the agent and opening Event Viewer.

It is installed and re-pulled by the same supervisor loop as the agent (`/api/agent/tray`), so it converges on the current build too. It reads the agent's loopback console and the journal; it cannot run a device command.

### The audit page — for the person in the room who does not believe you

`/audit/<ticketId>` is the whole envelope, full width, nothing else on screen. Same block is collapsed under **Technical detail** on the staff ticket if you would rather not leave it.

Per job it shows the verdict, then:

- **each read with the exact command that produced it** — `netsh interface ipv4 show dnsservers "Wi-Fi"` next to `resolvers=192.168.1.1 · mode=dhcp`;
- the field-level diff, `resolvers 192.168.1.1 → 1.1.1.1`;
- every command that ran, its exit code, its duration, and its full stdout;
- the rollback outcome, if one fired;
- the journal path, the change-record path, and the exact undo command, all on the machine.

**The move that lands it:** read a probe command off the page, alt-tab to a terminal on the VM, paste it, and let the room compare the output to the numbers on screen. Nothing is being taken on trust at that point.

Two things a checker will hit, so say them before they do — both are printed on the page:

- Output is redacted twice, and the product-key pattern is blunt: a harmless hyphenated serial can come back as `[REDACTED:product-key]`. That is the filter working, not a command that failed.
- The journal on the machine is written **un-redacted**, so it holds more than the page does. Extra content on the device is expected, not a discrepancy.

## 1. Install a VM app on your Mac

**UTM** (free, https://mac.getutm.app) is the recommended pick — native Apple Silicon/Intel support via QEMU, no license cost. Parallels Desktop is a paid alternative with tighter Windows integration if you already own a license.

```bash
brew install --cask utm
```

## 2. Get a Windows image and install it

You need to download this yourself — licensing and multi-GB size make it something only you should pull:
- Microsoft's official **Windows 11 ARM64** VHDX for Apple Silicon Macs: https://www.microsoft.com/software-download/windows11arm64 (Insider Preview channel has a direct VHDX download UTM can boot straight from — fastest path, no ISO install wizard).
- Or a standard Windows 11 x64 ISO if you're on an Intel Mac or UTM/QEMU x64 emulation.

In UTM: **Create a New Virtual Machine → Virtualize (Apple Silicon) or Emulate (Intel) → Windows**, point it at the VHDX/ISO, give it 4GB+ RAM and 40GB+ disk. Boot and run through Windows setup (a local account is fine — skip Microsoft account sign-in via `start ms-cxh:localonly` at the OOBE network screen if it insists on one).

## 3. Networking — how the VM reaches your Mac's dev server

**If you're on VMware Fusion** (measured directly on this Mac, not a guess): Fusion's NAT network (`vmnet8`, surfaced on macOS as `bridge101` in newer Fusion versions) puts the host at **`192.168.217.1`** — confirmed via `ifconfig | grep -B5 192.168.217` showing `bridge101: inet 192.168.217.1`. This can differ machine-to-machine; re-check with that same command if the connection doesn't work, since Fusion assigns the subnet per-install.

**If you're on UTM instead**: its default Shared Network mode (NAT via QEMU's SLIRP) uses the fixed gateway address `10.0.2.2` instead — a QEMU convention, not a real LAN IP.

1. On the Mac, confirm `pnpm dev` binds to all interfaces (it already does — Next's dev server log shows both `Local: http://localhost:3000` and `Network: http://<lan-ip>:3000`).
2. On the Mac, allow incoming connections: **System Settings → Network → Firewall** — either turn it off for the demo, or explicitly allow `node`.
3. Inside the Windows VM, the agent's `IT_SUPPORT_APP_URL` env var should be `http://192.168.217.1:3000` (Fusion) or `http://10.0.2.2:3000` (UTM).

Verify from inside the VM (PowerShell): `Invoke-WebRequest http://192.168.217.1:3000/api/state` should return JSON.

## 4. Install Node.js in the VM

```powershell
winget install OpenJS.NodeJS.LTS
```

## 5. Install the agent once — it then updates and starts itself

Copy [scripts/vm/install-agent.ps1](scripts/vm/install-agent.ps1) into the VM (UTM/Fusion shared folder, or paste it into Notepad). This is the **only** file you ever move by hand, and only once.

In an **elevated** PowerShell inside the VM:

```powershell
.\install-agent.ps1 -Token "<LOCAL_AGENT_TOKEN from .env.local>" -AppUrl "http://10.0.2.2:3000"
```

Use `http://192.168.217.1:3000` instead on VMware Fusion — see section 3. Elevation matters: `fix.toggle_wifi` cannot cycle an adapter without it.

What it sets up:

- `C:\ProgramData\BoltIt\config.json` — the token and app URL, in a directory ACL'd to Administrators and SYSTEM only.
- `C:\ProgramData\BoltIt\run-agent.ps1` — pulls the current `scripts/local-agent.mjs` from `GET /api/agent/script` (bearer-authenticated, same token as every other `/api/agent/*` route), runs it, and relaunches it 5s after any exit. If the Mac is unreachable it runs the copy it pulled last time rather than sitting idle.
- A scheduled task, **Bolt-it agent**, triggered at logon and running with highest privileges.

This replaces the old copy-the-file-in-by-hand step. It is not the deleted `public/setup.ps1`: that was served unauthenticated with the shared token baked into the response body. Here the token only ever lives in the VM's own config, and the endpoint refuses anyone who cannot already present it.

## 6. Day-to-day: you no longer touch the VM

| You want to | Do this |
|---|---|
| Start the agent | Nothing. It starts at logon. |
| Ship an agent edit | Save `scripts/local-agent.mjs` on the Mac, then in the VM: `schtasks /end /tn "Bolt-it agent"; schtasks /run /tn "Bolt-it agent"` |
| See it connect | The app header shows "Connected to `<hostname>`" |
| Watch what it ran | The tray icon (bottom right) — double-click for the activity window |
| The same, in a terminal | `Get-Content C:\ProgramData\BoltIt\journal\*.jsonl -Wait -Tail 5` |
| See which build it is on | Tray window header, or the app's agent badge (it says "Stale agent" when the build does not match) |
| Remove it | `schtasks /delete /tn "Bolt-it agent" /f; Remove-Item -Recurse C:\ProgramData\BoltIt` |

Run **one** agent at a time. A second one fights the first for jobs, and if it is an older copy it answers `Command is not allowlisted` for handlers it never had — the same read then succeeds and fails minutes apart, which is what stalled T-2384 and T-4935. The server now refuses to hand jobs to any agent whose build is not the one it is serving (and to any agent too old to report a build), so the stale copy starves and exits instead of racing; the app's agent badge shows **Stale agent** while that is happening. Check for strays with:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,CommandLine
```

## 7. Rehearsed demo script

1. Inside the Windows VM, open **Notepad** (or **Calculator**) and leave it running — this is the "broken" app.
2. On the Mac, in the Chat tab, file a ticket: *"Notepad keeps freezing on my machine, can you restart it?"*
3. Watch the plan draft: `fix.restart_app` classifies as `medium` risk / auto in [policy.ts](src/lib/policy.ts) — it runs without a click. `fix.toggle_wifi` and the `ad.*` writes are `high` and stop at the approval gate.
4. Watch the Windows VM screen over the share: Notepad actually closes and reopens, driven by the agent job the VM polled and executed.
5. Check the step log in the console: `[Proof] before: … / after: … / EFFECT: pid X → Y`, and the journal path on the VM.

This is the "no sleight of hand" moment: the fix is visibly happening on a real, separate machine on screen, not a canned log line.

### 7.1 The verification encore

Run this when someone asks whether any of it is real. It takes about ninety seconds and it is better with a sceptic driving.

1. Open **`/audit/<ticketId>`** and put it on the screen.
2. Point at one read — say `before: running=true · pid=8123` — and at the command printed under it, `pgrep -ix Notepad` (or `Get-Process Notepad` on Windows).
3. **Hand them the keyboard.** Terminal on the VM, paste the command, run it. Same pid. They ran it, not you.
4. Scroll to *Written on … itself* and open the journal path in the VM: `C:\ProgramData\BoltIt\journal\<today>.jsonl`. The same job id, the same probes, the same output — written on the machine before anything was uploaded.
5. Event Viewer → Windows Logs → Application, source **BoltIt**. Same job, same verdict, in a log this system does not own.
6. If the ticket made a reversible change, run the **undo command** off the page by hand, then re-run the probe command from step 3. It goes back.

**The one to actually show off:** file a fix you know will do nothing — set the DNS resolvers to the values already configured. The commands exit 0, both probes read identically, the diff is empty, and the ticket says *not fixed*. A system that wanted to look good would have reported success on those exit codes.

## Known limitations (accepted for a short build window)

- Screen-sharing a VM window inside a video call adds a layer of lag/quality loss — test this specific combination once before presenting, not for the first time live.
- `toggle_wifi` needs the agent running elevated (Administrator) to disable/enable an adapter.
- The agent's job poll only fetches jobs across all workspaces (no `workspaceId` filter passed from `local-agent.mjs`) — fine for a single-demo-machine setup, not multi-tenant safe. Pre-existing behavior, not introduced by this change.
