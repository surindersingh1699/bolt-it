# Demo — "the internet isn't working"

The employee files a ticket saying nothing loads. The agent reads the machine,
finds the resolver has been pointed somewhere dead, puts it back, and the company
portal — a real page, served from the Mac, reachable only by name — comes up on
the VM's screen.

Runs in about four minutes. Assumes the Windows VM from
[WINDOWS_VM_DEMO.md](../WINDOWS_VM_DEMO.md) is already installed and its agent is
connected.

## What runs where

Two machines, and the split is not incidental — it is what makes the fix mean
something.

| Runs on the **Mac** | Runs on the **Windows VM** |
|---|---|
| The app — `pnpm dev`, port 3000 | The agent — scheduled task **Bolt-it agent** |
| `scripts/demo/company-portal.mjs` — the portal **and** the DNS server | The tray app, showing each job as it runs |
| The browser you file the ticket from, as the employee | The browser showing `portal.acme.internal` — dead, then alive |
| The staff ticket view and `/audit/<ticketId>` | The `netsh` command that breaks the resolver |
| The `dhcpd.conf` edit and `vmnet-cli` restart | The journal, and Event Viewer → source `BoltIt` |

**Nothing about the fix runs on the Mac.** Every command that touches the broken
machine is dispatched to the agent on the VM and runs there. The Mac only files
the ticket, thinks, and displays.

**The portal is on the Mac on purpose.** Served from the VM, or resolved by a
`hosts` entry, it would come back regardless of what the resolver was doing — so
its return would prove nothing. It is reachable from the VM only by name, and
that name is resolvable only by the demo resolver, which is also on the Mac.
Break the VM's DNS and the page is genuinely unreachable.

Rule of thumb for the commands below: **`bash` blocks are the Mac, `powershell`
blocks are the VM.**

## What is real here

Everything on the fix side already shipped: `diag.network_state`,
`fix.flush_dns`, `fix.renew_dhcp_lease`, `fix.set_dns_servers`. One capability is
new — **`diag.http_check`**, a read that asks the machine whether it can resolve
and reach a URL.

It matters because `ping` cannot answer the question the ticket asks. `http_check`
returns the resolution and the connection as separate facts:

| State | `dnsResolved` | `address` | `status` | `error` |
|---|---|---|---|---|
| Resolver dead | `false` | `none` | `none` | `DNS lookup failed: ENOTFOUND` |
| Name resolves, host refuses | `true` | `192.168.217.1` | `none` | `ECONNREFUSED` |
| Working | `true` | `192.168.217.1` | `200` | — |

"Resolver problem" and "server problem" are different tickets with different
owners, and a single *unreachable* merges them. It never returns page contents —
the URL cannot carry a query string and the response body is dropped, because
this read has no distiller and external text does not reach a planner prompt
outside [research.ts](../src/lib/research.ts).

**The one thing that is staged is the breakage.** You break the VM's resolver by
hand before the demo, exactly as you would unplug a cable. Nothing about the
diagnosis, the fix or the proof is staged.

## Why the portal has to live on the Mac

A page served from the VM, or a `hosts` entry, would come back regardless of what
the resolver was doing — so the fix would prove nothing. The portal is reachable
from the VM **only by name**, and that name is resolvable **only** by the demo
resolver. Break DNS and the page is genuinely gone.

`scripts/demo/company-portal.mjs` runs both halves with no dependencies:

- **HTTP** — the portal page.
- **DNS** — answers `portal.acme.internal` and **forwards everything else
  upstream**. That forwarding is load-bearing: the ticket says the internet is
  down, so the fix has to restore the internet, not one hostname.

---

# One-time setup

## 1. Make the Mac the VM network's DNS server

This is the step that makes the fix honest. Right now Fusion hands the guest
`192.168.217.2` (its own DNS proxy) over DHCP. Point it at the Mac instead, and
then *restore the DHCP-assigned resolver* is both the correct fix and a value the
agent can read off the machine.

Edit `/Library/Preferences/VMware Fusion/vmnet8/dhcpd.conf` — in the
`subnet 192.168.217.0` block, change:

```
option domain-name-servers 192.168.217.2;
```

to `192.168.217.1` (the Mac, as the guest sees it). Then:

```bash
sudo "/Applications/VMware Fusion.app/Contents/Library/vmnet-cli" --configure && sudo "/Applications/VMware Fusion.app/Contents/Library/vmnet-cli" --start
```

Verify inside the VM after a `ipconfig /renew`:

```powershell
ipconfig /all | Select-String "DNS Servers"
```

It should read `192.168.217.1`.

> On UTM instead of Fusion, the host is `10.0.2.2` and QEMU's DHCP is not
> configurable this way. Use the fallback in *Variants* below.

## 2. Start the portal on the Mac

```bash
sudo node scripts/demo/company-portal.mjs --address=192.168.217.1
```

`sudo` is only for UDP port 53. It prints every address on the Mac if it guesses
the wrong one; override with `--address=`. Leave it running — the log line for
every DNS query and every page load is itself good demo material.

## 3. Confirm the working state from the VM

Browser → `http://portal.acme.internal:8080/` → the Acme Corp page, green dot,
showing the VM's own IP. This is the state you are going to break and restore.

---

# Running it

## Break it (before the room is watching)

Find the adapter name, then point the resolver at a black hole:

```powershell
Get-NetAdapter | Select-Object Name,Status
```

```powershell
netsh interface ipv4 set dnsservers name="Ethernet0" source=static address=10.255.255.1 primary
ipconfig /flushdns
```

Now nothing resolves on the VM — not the portal, not google.com. Show that:
leave a browser tab on the failed portal page. **Do not restore it by hand.**

## The run

1. **File the ticket** from the Mac, as the employee:

   > "Internet has stopped working on my laptop. I can't get to the Acme portal
   > or anything else. It was fine yesterday."

   No app is named, no diagnosis offered, no hint about DNS. If you name DNS you
   have done the interesting part yourself.

2. **Observation runs before anyone plans.** `diag.network_state` fires on the
   START edge, so the strategist opens with the readings already in hand — an
   adapter that is Up, with an address and a gateway, and a statically-configured
   resolver of `10.255.255.1`.

3. **The agent contradicts the employee's framing.** The link is fine; name
   resolution is not. Expect it to run `diag.http_check` against the portal and
   read back `dnsResolved=false · DNS lookup failed: ENOTFOUND` — proof that the
   name, not the network, is the problem.

4. **The ladder climbs, cheapest first.** Ordering comes from
   [ladder.ts](../src/lib/ladder.ts) and the registry, not from a model. Reads
   are free and go first. Among the changes, `fix.flush_dns` and
   `fix.renew_dhcp_lease` cost 3; `fix.set_dns_servers` costs 7 because it is
   `recorded`-reversible rather than self-reversible, so it is tried **last**.

   Whatever it tries first will not fix a resolver pointed at a black hole. When
   it asks *did that help?*, answer **still broken** — the run was paused on an
   `interrupt()`, not finished, so it climbs to the next rung for **zero model
   calls**. Put the token counter from `/api/state` on screen for this.

   > Exactly which rungs get tried is not scripted — it depends on what the
   > strategist authorises against the readings. Two rungs is typical, four is
   > possible. That variability is the honest version; do not promise a sequence.

5. **The fix.** `fix.set_dns_servers` with `servers: "empty"` restores the
   DHCP-assigned resolver — `netsh interface ipv4 set dnsservers "Ethernet0" dhcp`.
   The before/after probe diff reads:

   ```
   resolvers  10.255.255.1 → (empty)
   mode       static → dhcp
   ```

6. **The moment.** Alt-tab to the VM's browser and reload the portal tab. The
   Acme Corp page comes up. Load google.com in the next tab — the whole internet
   is back, because the resolver the fix restored forwards everything upstream.

## The encore, for the person who does not believe you

1. Open **`/audit/<ticketId>`** full-width.
2. Point at the probe and the exact command under it —
   `netsh interface ipv4 show dnsservers "Ethernet0"`.
3. **Hand them the keyboard.** They paste it into a terminal on the VM. Same
   values.
4. Open the journal on the machine:
   `C:\ProgramData\BoltIt\journal\<today>.jsonl` — same job id, same probes,
   written before anything was uploaded. Then Event Viewer → Application →
   source **BoltIt**.
5. Run the **undo command** printed on the audit page. The resolver goes back to
   `10.255.255.1` and the portal dies again. Re-run the fix to bring it back.

Two things a checker will hit, both printed on the page: output is redacted
twice and the product-key pattern is blunt, so a harmless hyphenated serial can
come back as `[REDACTED:product-key]`; and the on-device journal is written
**un-redacted**, so it holds more than the page does.

## The one that lands hardest

**Re-run the fix on an already-working machine.** Set the resolvers to the values
already configured. The commands exit 0, both probes read identically, the diff
is empty — and the ticket says **not fixed**, because
[evidence.ts](../src/lib/evidence.ts) derives the verdict from the diff and not
from the exit code. A system built to look good would have reported success.

---

# Variants

**A — internal site only.** Break it with `source=static address=8.8.8.8`
instead. Public internet works perfectly; `portal.acme.internal` does not
resolve. Harder diagnosis, more realistic, and the agent has to notice that
*some* names resolve. Best variant for a technical audience.

**B — the host is down, not DNS.** Leave DNS alone and stop
`company-portal.mjs`. `http_check` returns `dnsResolved=true · address=192.168.217.1
· ECONNREFUSED` — and the agent escalates to a person with the readings attached
instead of flailing at the network, because nothing on the employee's machine is
broken. **This is the beat worth rehearsing:** an agent that knows it is beaten
and says so is worth more to an IT director than three demos where it wins.

**C — no Fusion DHCP change.** If you cannot edit `dhcpd.conf` (UTM, or a locked
Mac), set the VM's resolver to the Mac statically as the baseline, and have the
employee mention the value in the ticket: *"our setup note says the DNS server is
192.168.217.1"*. The fix becomes `servers: ["192.168.217.1"]`. Weaker — the value
comes from the ticket text rather than from the machine — so prefer the DHCP
route when you can.

---

# Troubleshooting

| Symptom | Cause |
|---|---|
| `[dns] EACCES` on start | Port 53 needs `sudo`. `--dns-port=15353` is for testing only; Windows cannot be pointed at it. |
| VM resolves nothing even after the fix | The Mac's firewall is dropping UDP 53. System Settings → Network → Firewall: allow `node`, or turn it off for the demo. |
| Portal page times out but DNS resolves | HTTP is on 8080 and the URL needs the port: `http://portal.acme.internal:8080/`. |
| `ipconfig /all` still shows `192.168.217.2` | The Fusion networking service was not restarted, or the guest has not renewed. `ipconfig /release; ipconfig /renew`. |
| Agent badge says **Stale agent** | The VM is running an older build; the jobs route refuses it by `x-agent-build`. Let the supervisor pull, or restart the scheduled task. |
| `http_check` fails with "the agent on this machine has no http_check handler" | Same thing — that VM has not pulled the build carrying this capability. |
