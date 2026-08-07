# 7 demo scenarios — real employee problems, solved live

Each scenario lists: the exact message to send (the `#it-support` channel, signed in as a non-IT-staff account), the pre-state to arrange, and what actually happens. Every scenario here runs against a real backend — there is no "simulated but labeled" tier any more, because the adapters that had no backend were deleted. Seeded users bob/frank/eve already start in broken states, so scenarios 4–6 need zero setup.

**Operational note:** run ONE local agent at a time (the VM *or* the Mac). Jobs are claimed by whichever agent polls first, and the fleet's live-device indicator tracks a single heartbeat.

**Reset between runs:** "clear" button in the queue wipes tickets (runbooks/precedent kept). Restart the dev server to re-seed bob/frank/eve's broken account states.

---

## Tier 1 — real execution on the Windows VM (visible on screen)

### 1. Frozen app restart ⭐ the no-sleight-of-hand moment
- **Send as:** Dan — *"Notepad is frozen on my machine, can you restart it?"*
- **Pre-state:** open Notepad in the VM, VM agent running, VM screen visible to audience.
- **What happens:** LLM drafts plan → `fix.restart_app` routes to `testpc` → Notepad visibly closes and reopens on the VM.
- **Real?** 100% real. (Use Notepad, not Excel/Outlook — fresh VM has no Office.)

### 2. Website broken because of corrupt browser cache
- **Send as:** anyone — *"The intranet page loads all broken in Edge, IT said something about cache last time."*
- **Pre-state:** open Edge in the VM once so a cache exists.
- **What happens:** `fix.clear_app_cache --app "Edge"` → agent resolves Edge's real profile cache path, reports actual MB cleared, wipes it.
- **Real?** 100% real (agent v0.3+ knows Edge/Chrome profile paths).

### 3. "My computer is so slow"
- **Send as:** anyone — *"My computer has been crawling all week, can someone check it?"*
- **What happens:** `diag.system_info` runs on the VM → the ticket + Slack reply contain the machine's **actual** hostname, RAM, CPU, uptime.
- **Real?** 100% real — audience can verify the specs match the VM.

## Tier 2 — real identity-state changes (fleet badges flip live)

### 4. Locked out after failed logins
- **Send as:** Bob — *"I'm locked out of my account, I mistyped my password a few times this morning."*
- **Pre-state:** none — Bob is seeded locked (5 failed logins). Show his amber "attention" badge in Users & Devices first.
- **What happens:** auth-log read → `ad.unlock_account` (high-risk → approval click) → account genuinely unlocks: badge flips to green, **Bob's login actually starts working**.
- **Real?** Real state change end to end; the auth-log excerpt is labeled sample data.

### 5. Password expired
- **Send as:** Frank — *"My password expired and I can't get in."*
- **What happens:** `ad.reset_password` (judge-classified high-risk → approval) → expiry pushed 90 days, status active, badge flips.
- **Real?** Real state change.

### 6. Mapped drives keep prompting for password (Kerberos)
- **Send as:** Eve — *"Every mapped drive keeps asking for my password today."*
- **What happens:** Kerberos log read → `ad.refresh_kerberos` → stale_kerberos → active, badge flips.
- **Real?** Real state change; log excerpt labeled sample.

## Tier 3 — governance arc

### 7. Flaky Wi-Fi ⭐ the trust-earning scenario
- **Send as:** anyone — *"Wi-Fi keeps dropping every few minutes."*
- **Pre-state:** run the agent on the **Mac** (not the VM — VMs expose no Wi-Fi adapter).
- **What happens:** `fix.toggle_wifi` is high risk (it drops the machine's network link), so the graph pauses on a real `interrupt()` and waits for a click.
- **Wow:** run it 3 times, approving each time → the 4th run **auto-executes with a "trusted · auto" badge**. `PROMOTION_THRESHOLD` in `governance.ts` is 3; precedent is scoped per workspace *and* per capability, so nothing else got promoted along with it.
- **Real?** 100% real on a physical machine — the radio genuinely cycles.

---

## Intake

There is no real Slack integration — no workspace to install into, no token, nothing leaves the machine. Instead the employee surface *is* a Slack: sign in as a non-IT-staff account and the whole app is a `#it-support` channel talking to the **Bolt IT** app. Messages create tickets, every agent update posts back into the channel, and "Yes, it's working" / "No, still broken" (or just replying `yes` / `no`) closes or escalates. Staff accounts still get the inbox.
