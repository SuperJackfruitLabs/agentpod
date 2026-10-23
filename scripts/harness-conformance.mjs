#!/usr/bin/env node
// Harness conformance: checks one live station against the first-class
// harness contract in
// docs/superpowers/specs/2026-10-23-salaam-first-class-harness-design.md
// and prints a table of item, PASS/FAIL/SKIP, evidence.
//
// Generic over harness. Salaam-only items run when the station's harness is
// "salaam". Read-only unless --allow-writes is given (then it opens one ACP
// session per mode and closes it again).
//
// Runs under node >= 20 or bun with no dependencies.
//
// Usage:
//   HUB_URL=https://staging-hub.agentpod.dev STATION_ID=station_... \
//   HUB_ENV_FILE=/opt/suite-staging/env/hub/hub.env \
//   node scripts/harness-conformance.mjs [--allow-writes] [--json]
//
// Credentials (never printed): HUB_TOKEN_FILE (a file holding a bearer token),
// or HUB_ENV_FILE (an env file with API_TOKEN=...), or HUB_TOKEN.
// Optional: HUB_DIRECT_URL (the hub behind the edge, e.g. http://127.0.0.1:3101,
// used to tell a hub error from an edge error), PRINCIPAL_ID (the agent bound
// to the station, for evidence), HUB_CONTAINER (docker container name, to read
// bridge readiness from the hub log), TIMEOUT_MS (default 15000).
// Exit code: 0 when nothing FAILs, 1 otherwise, 2 on usage errors.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const allowWrites = args.has("--allow-writes");
const asJson = args.has("--json");
const HUB = (process.env.HUB_URL ?? "").replace(/\/$/, "");
const DIRECT = (process.env.HUB_DIRECT_URL ?? "").replace(/\/$/, "");
const STATION = process.env.STATION_ID ?? "";
const PRINCIPAL = process.env.PRINCIPAL_ID ?? "";
const CONTAINER = process.env.HUB_CONTAINER ?? "";
const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 15000);

function token() {
  if (process.env.HUB_TOKEN_FILE)
    return readFileSync(process.env.HUB_TOKEN_FILE, "utf8").trim();
  if (process.env.HUB_ENV_FILE) {
    const line = readFileSync(process.env.HUB_ENV_FILE, "utf8")
      .split("\n")
      .find((l) => l.startsWith("API_TOKEN="));
    if (line) return line.slice("API_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  }
  return process.env.HUB_TOKEN ?? "";
}
const TOKEN = token();
if (!HUB || !STATION || !TOKEN) {
  console.error("need HUB_URL, STATION_ID and a credential (HUB_TOKEN_FILE, HUB_ENV_FILE or HUB_TOKEN)");
  process.exit(2);
}

const results = [];
const record = (item, status, evidence) =>
  results.push({ item, status, evidence: String(evidence).replace(/\s+/g, " ").slice(0, 220) });
const redact = (s) => String(s).split(TOKEN).join("<redacted>");

async function call(path, { method = "GET", body, base = HUB, timeout = TIMEOUT } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(base + path, {
      method,
      signal: ctl.signal,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text: redact(text), json, headers: res.headers };
  } catch (err) {
    return { status: 0, text: redact(err?.name === "AbortError" ? "timeout" : err?.message ?? err), json: undefined, headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }
}
const short = (r) => `HTTP ${r.status} ${r.text.slice(0, 160)}`;

// Reads an SSE stream for up to `ms` and returns the data frames seen.
async function readSse(path, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const frames = [];
  let status = 0;
  try {
    const res = await fetch(HUB + path, { signal: ctl.signal, headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" } });
    status = res.status;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split("\n").slice(0, -1)) if (line.startsWith("data:")) frames.push(line.slice(5).trim());
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
      if (frames.length >= 3) break;
    }
  } catch { /* timeout ends the read */ } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return { status, frames: frames.map(redact) };
}

// ── 1. Detection / inventory ────────────────────────────────────────────────
const nodes = await call("/api/nodes");
let station, node;
for (const n of Array.isArray(nodes.json) ? nodes.json : []) {
  const list = await call(`/api/nodes/${n.id}/stations`);
  const hit = (Array.isArray(list.json) ? list.json : []).find((s) => s.id === STATION);
  if (hit) { station = hit; node = n; break; }
}
if (!station) {
  record("detection", "FAIL", `station ${STATION} not in any node's inventory (${short(nodes)})`);
  finish();
}
const harness = station.harness;
const caps = new Set(station.capabilities ?? []);
const isSalaam = harness === "salaam";
record("detection", "PASS", `harness=${harness} key=${station.stationKey ?? station.key ?? "?"} node=${node.name} (${node.status}, ${node.agentVersion})`);
record("node.online", node.status === "online" ? "PASS" : "FAIL", `node ${node.name} status=${node.status} lastSeen=${node.lastSeenAt}`);

// ── 2. Capabilities ─────────────────────────────────────────────────────────
const required = ["inventory", "health", "logs", "fs.read", "acp", "skills.inventory"];
const missing = required.filter((c) => !caps.has(c));
record("capabilities", missing.length ? "FAIL" : "PASS", `advertised=[${[...caps].join(",")}]${missing.length ? ` missing=[${missing.join(",")}]` : ""}`);

// ── 3. Health fields ────────────────────────────────────────────────────────
const health = await call(`/api/stations/${STATION}/health`);
if (health.status !== 200 || !health.json) record("health", "FAIL", short(health));
else {
  const h = health.json;
  const fields = ["pid", "cpuPct", "memBytes", "diskBytes", "uptimeSec", "lastActivity"];
  const nulls = fields.filter((f) => h[f] === null || h[f] === undefined);
  record("health.running", h.running ? "PASS" : "FAIL", `running=${h.running} pid=${h.pid}`);
  record("health.fields", nulls.length ? "FAIL" : "PASS", nulls.length ? `null: ${nulls.join(",")}; note=${h.note ?? ""}` : fields.map((f) => `${f}=${h[f]}`).join(" "));
}

// ── 4. Logs ─────────────────────────────────────────────────────────────────
const logs = await readSse(`/api/stations/${STATION}/logs`, 8000);
const logErr = logs.frames.find((f) => /error|not exposed|not enabled/i.test(f));
record("logs", logs.status === 200 && logs.frames.length && !logErr ? "PASS" : "FAIL",
  `HTTP ${logs.status}, ${logs.frames.length} frame(s) in 8s${logs.frames[0] ? `: ${logs.frames[0].slice(0, 120)}` : " (console shows Reconnecting…)"}`);

// ── 5. Files (read-only, confined) ──────────────────────────────────────────
const ls = await call(`/api/stations/${STATION}/files?path=.`);
const entries = Array.isArray(ls.json) ? ls.json : Array.isArray(ls.json?.entries) ? ls.json.entries : null;
record("files.list", ls.status === 200 && entries ? "PASS" : "FAIL", ls.status === 200 && entries ? `${entries.length} entries at workspace root` : short(ls));
const file = entries?.find((e) => e.type === "file");
if (file) {
  const rf = await call(`/api/stations/${STATION}/file?path=${encodeURIComponent(file.path ?? file.name)}`);
  record("files.read", rf.status === 200 ? "PASS" : "FAIL", rf.status === 200 ? `read ${file.name}` : short(rf));
} else record("files.read", entries ? "SKIP" : "FAIL", entries ? "no regular file at workspace root" : "listing failed");
const esc = await call(`/api/stations/${STATION}/file?path=${encodeURIComponent("../../../../etc/passwd")}`);
record("files.confined", esc.status >= 400 && esc.status < 500 ? "PASS" : esc.status === 200 ? "FAIL" : "FAIL",
  esc.status === 200 ? "path escape returned 200" : `escape refused as ${esc.status} (want 4xx, a refusal, not a node failure): ${esc.text.slice(0, 100)}`);

// ── 6. Error semantics: a station/node failure must reach the console as a
// JSON body with CORS headers, not as an edge error page.
const failing = [ls, esc].find((r) => r.status >= 500);
if (!failing) record("errors.station-vs-hub", "SKIP", "no 5xx observed to classify");
else {
  const edge = failing.json === undefined || !failing.headers.get("access-control-allow-origin");
  let direct = "";
  if (DIRECT) {
    const d = await call(`/api/stations/${STATION}/files?path=.`, { base: DIRECT });
    direct = `; hub direct: ${short(d)}`;
  }
  record("errors.station-vs-hub", edge ? "FAIL" : "PASS",
    edge ? `edge replaced the hub's ${failing.status} with a non-JSON body without CORS (${failing.text.slice(0, 40)}) → console says "Couldn't reach the hub"${direct}` : `5xx carries JSON + CORS${direct}`);
}

// ── 7. Declared harness config ──────────────────────────────────────────────
const cfg = await call(`/api/stations/${STATION}/config`);
const obs = cfg.json?.observations;
record("config", cfg.status === 200 && Array.isArray(obs) && obs.length ? "PASS" : "FAIL",
  cfg.status === 200 ? `${Array.isArray(obs) ? obs.length : "?"} observation(s)` : short(cfg));

// ── 8. Skills inventory ─────────────────────────────────────────────────────
if (!caps.has("skills.inventory")) record("skills.inventory", "FAIL", "not advertised");
else {
  const sk = await call(`/api/stations/${STATION}/skills/inventory`, { method: "POST", body: {} });
  record("skills.inventory", sk.status === 200 ? "PASS" : "FAIL", sk.status === 200 ? `${JSON.stringify(sk.json).slice(0, 140)}` : short(sk));
}

// ── 9. MCP proxy ────────────────────────────────────────────────────────────
const mcp = await call(`/api/stations/${STATION}/mcp-proxy`);
if (mcp.status !== 200) record("mcp.proxy", "FAIL", short(mcp));
else {
  const m = mcp.json;
  record("mcp.proxy", m.eligible ? (m.serving ? "PASS" : "SKIP") : "FAIL",
    `eligible=${m.eligible} declared=${JSON.stringify(m.declared)} serving=${m.serving} state=${m.state}${m.eligible && !m.serving ? " (eligible, operator has not turned it on)" : ""}`);
}
record("mcp.node-capability", (node.capabilities ?? []).includes("mcp.proxy") ? "PASS" : "FAIL", `node capabilities=[${(node.capabilities ?? []).join(",")}]`);

// ── 10. Interactive ACP sessions ────────────────────────────────────────────
const sessions = await call(`/api/stations/${STATION}/acp/sessions`);
const sessionList = Array.isArray(sessions.json) ? sessions.json : sessions.json?.sessions;
record("acp.list", sessions.status === 200 ? "PASS" : "FAIL", sessions.status === 200 ? `${sessionList?.length ?? 0} session(s)` : short(sessions));
if (!allowWrites) {
  for (const mode of ["ask", "accept-edits", "full-auto"]) record(`acp.open.${mode}`, "SKIP", "needs --allow-writes");
} else {
  // Close every session this run opened, even when a request times out after the hub
  // created it: an open session holds the station's one live Salaam execution.
  const before = new Set((sessionList ?? []).map((x) => x.id));
  try {
  for (const mode of ["ask", "accept-edits", "full-auto"]) {
    const r = await call(`/api/stations/${STATION}/acp/sessions`, { method: "POST", body: { mode }, timeout: 60000 });
    const ok = r.status === 201 && r.json?.id;
    let why = short(r);
    if (!ok && r.json === undefined && DIRECT) {
      const d = await call(`/api/stations/${STATION}/acp/sessions`, { method: "POST", body: { mode }, base: DIRECT, timeout: 60000 });
      why = `edge: HTTP ${r.status} non-JSON; hub direct: ${short(d)}`;
      if (d.status === 201 && d.json?.id) await call(`/api/acp/sessions/${d.json.id}`, { method: "DELETE", base: DIRECT });
    }
    record(`acp.open.${mode}`, ok ? "PASS" : "FAIL", ok ? `session ${r.json.id} status=${r.json.status}` : why);
    if (ok) await call(`/api/acp/sessions/${r.json.id}`, { method: "DELETE" });
  }
  } finally {
    const after = await call(`/api/stations/${STATION}/acp/sessions`);
    const list = Array.isArray(after.json) ? after.json : after.json?.sessions;
    for (const x of list ?? [])
      if (!before.has(x.id) && x.status !== "ended") await call(`/api/acp/sessions/${x.id}`, { method: "DELETE" });
  }
}

// ── 11. Activity / evidence ────────────────────────────────────────────────
const act = await call(`/api/stations/${STATION}/activity`);
record("activity", act.status === 200 ? "PASS" : "FAIL", act.status === 200 ? `${Array.isArray(act.json) ? act.json.length : "?"} item(s)` : short(act));
const last = (sessionList ?? [])[0];
if (last?.id) {
  const tr = await call(`/api/evidence/sessions/${last.id}/transcript`);
  record("evidence.transcript", tr.status === 200 ? "PASS" : "FAIL", `latest session ${last.id}: ${short(tr)}`);
} else record("evidence.transcript", "SKIP", "no ACP session on this station to read a transcript for");
if (PRINCIPAL) {
  const ev = await call(`/api/evidence/principals/${PRINCIPAL}`);
  record("evidence.principal", ev.status === 200 ? "PASS" : ev.status === 401 || ev.status === 403 ? "SKIP" : "FAIL",
    ev.status === 401 || ev.status === 403 ? `credential not accepted by evidence API (${short(ev)})` : short(ev));
} else record("evidence.principal", "SKIP", "PRINCIPAL_ID not given");

// ── 12. Bridge readiness (hub log) ─────────────────────────────────────────
if (!CONTAINER) record("bridge.readiness", "SKIP", "HUB_CONTAINER not given; readiness has no hub API yet");
else {
  let lines = "";
  try {
    lines = execFileSync("docker", ["logs", "--since", "10m", CONTAINER], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
  } catch (e) { lines = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  const all = lines.split("\n").filter((l) => l.includes('"component":"bridge"'));
  const notReadyAt = all.map((l) => l.includes("not ready")).lastIndexOf(true);
  const notReady = notReadyAt >= 0 ? all[notReadyAt] : undefined;
  const cycles = all.filter((l) => l.includes('"cycle"')).length;
  // Readiness is the latest state: two or more clean cycles after the last back-off mean it recovered.
  const cleanSince = all.slice(notReadyAt + 1).filter((l) => l.includes('"cycle"')).length;
  if (notReady && cleanSince >= 2) {
    record("bridge.readiness", "PASS", `last 10m: ${cycles} cycle(s); ${cleanSince} clean cycle(s) since the last back-off`);
  } else if (notReady) {
    let reason = notReady;
    try { reason = JSON.parse(notReady).context?.reason ?? notReady; } catch { /* keep line */ }
    record("bridge.readiness", "FAIL", `last 10m: ${cycles} cycle(s), latest backs off: ${reason}`);
  } else record("bridge.readiness", cycles ? "PASS" : "SKIP", `${cycles} bridge cycle(s) in 10m, no not-ready line`);
}

// ── 13. Salaam-specific ────────────────────────────────────────────────────
if (isSalaam) {
  const note = health.json?.note ?? "";
  const bridge = results.find((r) => r.item === "bridge.readiness");
  const strictBlocked = bridge?.status === "FAIL" && /strict work/i.test(bridge.evidence);
  record("salaam.strict-work", strictBlocked ? "FAIL" : bridge?.status === "PASS" ? "PASS" : "SKIP",
    (strictBlocked ? "" : "no strict-work refusal seen; ") + "hub requires node salaam.work-capability → {version:1,enabled:true}; the node answers that only for a Salaam it launched from a reviewed schema-6 host manifest (salaamManifest + salaamNodeBinary in node config). Nothing produces the station config or manifest today.");
  // Strict work is only available from a node-launched, reviewed schema-6 host, which needs the
  // pins, station config and manifest that `salaam host bind` (estate 306) produces.
  const strict = results.find((r) => r.item === "salaam.strict-work");
  if (strict?.status === "PASS") record("salaam.binding", "PASS", "station bound: strict work is available, so pins, station config and the reviewed manifest are in place");
  else record("salaam.binding", /lease|bound/i.test(note) ? "FAIL" : "SKIP",
    `no reviewed binding observed: strict work is not available (health note: "${note}")`);
  record("salaam.tools-user", "SKIP", "not observable from the hub; salaam #46 (--tools-user) open");
} else {
  record("salaam.*", "SKIP", `harness is ${harness}`);
}

finish();

function finish() {
  if (asJson) console.log(JSON.stringify({ hub: HUB, station: STATION, results }, null, 2));
  else {
    const w = Math.max(...results.map((r) => r.item.length), 4);
    console.log(`Harness conformance: ${HUB} ${STATION}${allowWrites ? " (writes allowed)" : ""}`);
    console.log(`${"item".padEnd(w)}  result  evidence`);
    for (const r of results) console.log(`${r.item.padEnd(w)}  ${r.status.padEnd(6)}  ${r.evidence}`);
    const n = (s) => results.filter((r) => r.status === s).length;
    console.log(`\n${n("PASS")} PASS, ${n("FAIL")} FAIL, ${n("SKIP")} SKIP`);
  }
  process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
}
