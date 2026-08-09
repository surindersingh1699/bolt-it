#!/usr/bin/env node
/**
 * The demo lab: a company intranet that is genuinely unreachable when DNS is
 * broken, and genuinely reachable when it is fixed.
 *
 * The "internet is down" demo only proves something if the thing that comes back
 * is real. A page served from the VM itself, or a hosts-file entry, would come
 * back whatever the resolver was doing — so the fix would prove nothing. This
 * runs on the Mac and is reachable from the VM ONLY by name, and that name is
 * ONLY resolvable by the DNS server below. Break the VM's resolver and the page
 * is genuinely gone; restore it and the page genuinely returns.
 *
 * Two servers, no dependencies:
 *
 *   HTTP  — the portal page itself.
 *   DNS   — answers A queries for the portal's name and FORWARDS everything else
 *           upstream, so pointing the VM here restores the whole internet and
 *           not just this one name. That matters: the ticket says "internet is
 *           down", so the fix has to fix the internet.
 *
 * Zero dependencies is deliberate — this has to run on a demo machine without a
 * pnpm install, and CLAUDE.md rule 7 means a demo fixture is the last place to
 * spend a new dep.
 *
 *   sudo node scripts/demo/company-portal.mjs
 *
 * sudo is for UDP port 53. Use --dns-port to run unprivileged while testing;
 * a resolver a Windows machine can be pointed at has to be on 53.
 */
import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const HOSTNAME = arg("host", "portal.acme.internal").toLowerCase();
const HTTP_PORT = Number(arg("http-port", "8080"));
const DNS_PORT = Number(arg("dns-port", "53"));
const UPSTREAM = arg("upstream", "1.1.1.1");

/** The address the portal's name resolves to: this Mac, on the VM's network. */
function hostAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const candidates = hostAddresses();
// A VM NAT network puts the host on the .1 of its own subnet, which is what the
// guest must be told to talk to. Prefer an explicit --address over guessing.
const ADDRESS =
  arg("address", "") ||
  candidates.find((c) => /^bridge|^vmnet/.test(c.name))?.address ||
  candidates[0]?.address ||
  "127.0.0.1";

// ---- the portal ------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acme Corp — Intranet</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 -apple-system,Segoe UI,system-ui,sans-serif;
         background:#0b1020; color:#e8ecf8; }
  .card { width:min(560px,92vw); padding:40px; border-radius:18px;
          background:#131a30; border:1px solid #263154; text-align:center; }
  .dot { width:12px; height:12px; border-radius:50%; background:#3ddc84;
         display:inline-block; margin-right:8px; }
  h1 { margin:0 0 4px; font-size:30px; letter-spacing:-.02em; }
  .sub { color:#93a0c4; margin:0 0 28px; }
  .ok { font-size:19px; font-weight:600; margin-bottom:24px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:8px 18px; margin:0;
       text-align:left; font-size:14px; }
  dt { color:#93a0c4; } dd { margin:0; font-family:ui-monospace,Menlo,monospace; }
  footer { margin-top:28px; font-size:12px; color:#6b779c; }
</style></head><body>
<div class="card">
  <h1>Acme Corp</h1>
  <p class="sub">Internal staff portal</p>
  <p class="ok"><span class="dot"></span>Connection healthy</p>
  <dl>
    <dt>You are</dt><dd>__CLIENT__</dd>
    <dt>Served by</dt><dd>__SERVER__</dd>
    <dt>Server time</dt><dd>__TIME__</dd>
  </dl>
  <footer>Bolt-it demo fixture — not a real company system</footer>
</div></body></html>`;

const portal = http.createServer((req, res) => {
  const client = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const body = PAGE.replace("__CLIENT__", client)
    .replace("__SERVER__", `${os.hostname()} (${ADDRESS})`)
    .replace("__TIME__", new Date().toISOString());
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
  console.log(`[http] ${client} → ${req.method} ${req.url}`);
});

/**
 * Which interface the page is actually served on — separate from `--address`,
 * which only decides what the resolver ANSWERS.
 *
 * Default `0.0.0.0` keeps the DNS demo working: there the page is meant to be
 * reachable once the name resolves, and the break is the resolver.
 *
 * For the VPN demo the break is the ROUTE, not the name. Pass the tunnel address
 * (`--bind=10.9.0.1 --address=10.9.0.1`) and the page becomes genuinely
 * unreachable with the tunnel down, while the name still resolves and the rest
 * of the internet still works — which is what "VPN is connected but I can't
 * reach the intranet" actually looks like. Bound to 0.0.0.0 the VM can reach it
 * by IP with no tunnel at all, and the demo proves nothing.
 */
const BIND = arg("bind", "0.0.0.0");

portal.listen(HTTP_PORT, BIND, () => {
  console.log(`[http] portal on http://${ADDRESS}:${HTTP_PORT}/  (serving ${HOSTNAME}, bound to ${BIND})`);
});
portal.on("error", (err) => {
  // Loudly. A portal that failed to bind but left the DNS server answering is a
  // demo that fails halfway through with no explanation on screen.
  console.error(`[http] could not bind ${BIND}:${HTTP_PORT} — ${err.message}`);
  process.exit(1);
});

// ---- the resolver ----------------------------------------------------------
// Hand-rolled rather than pulled from npm. A DNS answer for a single A record is
// a header, the question echoed back, and sixteen bytes.

/** Pull the QNAME/QTYPE out of a query. Returns where the question ends. */
function readQuestion(msg) {
  const labels = [];
  let off = 12; // fixed-size header
  while (off < msg.length) {
    const len = msg[off];
    if (len === 0) {
      off += 1;
      break;
    }
    // A compression pointer cannot appear in a question section; treat one as
    // malformed rather than trying to follow it.
    if ((len & 0xc0) === 0xc0) return null;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("ascii"));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  return { name: labels.join(".").toLowerCase(), qtype: msg.readUInt16BE(off), end: off + 4 };
}

function answerA(msg, question, ip) {
  const header = Buffer.from(msg.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2); // response, recursion desired + available
  header.writeUInt16BE(1, 6); // one answer
  header.writeUInt16BE(0, 8); // no authority records
  header.writeUInt16BE(0, 10); // no additional records

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // name: pointer back to the question
  answer.writeUInt16BE(1, 2); // type A
  answer.writeUInt16BE(1, 4); // class IN
  answer.writeUInt32BE(30, 6); // TTL 30s — short, so the demo can be re-run
  answer.writeUInt16BE(4, 10); // rdlength
  ip.split(".").forEach((oct, i) => answer.writeUInt8(Number(oct), 12 + i));

  return Buffer.concat([header, msg.subarray(12, question.end), answer]);
}

/**
 * Everything that is not the portal goes upstream unchanged.
 *
 * Without this, pointing the VM at this resolver would fix one name and break
 * every other — so "the internet is back" would be false, and the demo would be
 * claiming a fix it had not made.
 */
function forward(msg, rinfo, server) {
  const client = dgram.createSocket("udp4");
  const done = setTimeout(() => client.close(), 4000);
  client.on("message", (reply) => {
    clearTimeout(done);
    server.send(reply, rinfo.port, rinfo.address);
    client.close();
  });
  client.on("error", () => {
    clearTimeout(done);
    try {
      client.close();
    } catch {
      /* already closed */
    }
  });
  client.send(msg, 53, UPSTREAM);
}

const resolver = dgram.createSocket("udp4");

resolver.on("message", (msg, rinfo) => {
  if (msg.length < 12) return;
  const question = readQuestion(msg);
  if (!question) return forward(msg, rinfo, resolver);

  const isOurs = question.name === HOSTNAME && question.qtype === 1;
  if (!isOurs) {
    console.log(`[dns] ${rinfo.address} asked ${question.name} → upstream ${UPSTREAM}`);
    return forward(msg, rinfo, resolver);
  }

  console.log(`[dns] ${rinfo.address} asked ${question.name} → ${ADDRESS}`);
  resolver.send(answerA(msg, question, ADDRESS), rinfo.port, rinfo.address);
});

resolver.on("error", (err) => {
  console.error(`[dns] ${err.message}`);
  if (err.code === "EACCES") console.error("[dns] port 53 needs sudo — or pass --dns-port=15353 to test");
  process.exit(1);
});

resolver.bind(DNS_PORT, "0.0.0.0", () => {
  console.log(`[dns] resolver on ${ADDRESS}:${DNS_PORT}, forwarding to ${UPSTREAM}`);
  console.log("");
  console.log(`  Point the VM's DNS at:  ${ADDRESS}`);
  console.log(`  Then browse to:         http://${HOSTNAME}:${HTTP_PORT}/`);
  console.log("");
  if (candidates.length > 1) {
    console.log("  Other addresses on this Mac, if that one is not the VM's network:");
    for (const c of candidates) console.log(`    ${c.address.padEnd(16)} ${c.name}`);
    console.log("  Override with --address=<ip>.");
    console.log("");
  }
});
