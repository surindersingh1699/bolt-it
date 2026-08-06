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
| Watch what it ran | `Get-Content C:\ProgramData\BoltIt\journal\*.jsonl -Wait -Tail 5` |
| Remove it | `schtasks /delete /tn "Bolt-it agent" /f; Remove-Item -Recurse C:\ProgramData\BoltIt` |

Run **one** agent at a time — the app keeps a single global heartbeat, so a second one just fights the first for jobs.

## 7. Rehearsed demo script

1. Inside the Windows VM, open **Notepad** (or **Calculator**) and leave it running — this is the "broken" app.
2. On the Mac, in the Chat tab, file a ticket: *"Notepad keeps freezing on my machine, can you restart it?"*
3. Watch the plan draft: `fix.restart_app` classifies as `medium` risk / auto in [policy.ts](src/lib/policy.ts) — it runs without a click. `fix.toggle_wifi` and the `ad.*` writes are `high` and stop at the approval gate.
4. Watch the Windows VM screen over the share: Notepad actually closes and reopens, driven by the agent job the VM polled and executed.
5. Check the step log in the console: `[Proof] before: … / after: … / EFFECT: pid X → Y`, and the journal path on the VM.

This is the "no sleight of hand" moment: the fix is visibly happening on a real, separate machine on screen, not a canned log line.

## Known limitations (accepted for a short build window)

- Screen-sharing a VM window inside a video call adds a layer of lag/quality loss — test this specific combination once before presenting, not for the first time live.
- `toggle_wifi` needs the agent running elevated (Administrator) to disable/enable an adapter.
- The agent's job poll only fetches jobs across all workspaces (no `workspaceId` filter passed from `local-agent.mjs`) — fine for a single-demo-machine setup, not multi-tenant safe. Pre-existing behavior, not introduced by this change.
