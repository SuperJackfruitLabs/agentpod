#!/usr/bin/env node
/**
 * Screenshots of the built console (static SPA in build/) against a stubbed hub, for comparing
 * by eye with the approved mockups. No real hub, no sign-in: every request to the hub is answered
 * here with the canonical sample fleet, and everything else off this machine is refused.
 *
 *   PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build
 *   node e2e/shots.mjs [--path=/] [--vibes=daylight,paper,studio,quiet] [--themes=light,dark]
 *                      [--sizes=desktop,phone] [--menu] [--more] [--state=populated|loading|error|empty]
 *                      [--signedout] [--out=e2e/shots]
 *                      [--tab=chat|health|logs|files|terminal|changes|cleanup|activity|config] [--about]
 *                      [--chat=live|none|ended] [--health=running|stopped|error]
 *                      [--open=IDENTITY.md] [--changes=dirty|clean|error] [--scan] [--activity=rows|empty|error]
 *
 * Admin: --admin=legacy|plane|denied|offline|500 (default legacy) answers the admin reads as a hub
 * without the account plane (users, signup, grants listed), under the plane (410
 * managed_by_org_plane for users and grants), or the guard's check as a 403, a network failure or
 * a 500. Dialogs: --keys=Control+k presses keys after load (the palette), --click="a|b" clicks
 * each selector in turn (opening a dialog), --name=x adds "-x" to the file name.
 *
 * The station tabs: --open opens a file in Files (the tree click), --changes picks the workspace
 * the Changes tab reads (dirty also opens README.md's patch), --scan presses Cleanup's Scan,
 * --activity what the station's audit read returns. Terminal replays a short fake PTY stream.
 *
 * --menu opens the account menu with Appearance expanded (desktop); --more opens the phone's More
 * sheet. --state answers the fleet's reads as populated (default), never (loading), 500 (error)
 * or with nothing enrolled (empty). --signedout answers get-session with no session, so the
 * console shows its sign-in page (the hub without an account plane). --path=/nope shows the 404. Uses playwright-core with an already installed Chromium (its own revision in the
 * Playwright cache, or PLAYWRIGHT_CHROMIUM); it never downloads a browser. Output is git-ignored.
 */
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const BUILD = resolve(here, "../build");
const HUB = "https://hub.agentpod.dev";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, "").split("=");
    return [k, rest.length ? rest.join("=") : true];
  }),
);
const list = (v, d) => (typeof v === "string" ? v.split(",") : d);
const VIBES = list(args.vibes, ["daylight", "paper", "studio", "quiet"]);
const THEMES = list(args.themes, ["light", "dark"]);
const SIZES = list(args.sizes, ["desktop", "phone"]);
const PATH = typeof args.path === "string" ? args.path : "/";
const STATE = typeof args.state === "string" ? args.state : "populated";
const SIGNED_OUT = !!args.signedout;
// The station page (--path=/nodes/n_ashram/stations/st_annapurna): --tab picks the tab, --about opens
// the phone's About sheet, --chat the session the transcript shows (a live one waiting on a permission,
// none at all, or an ended one), --health what the station reports. --sizes may include tablet (1024).
const TAB = typeof args.tab === "string" ? args.tab : null;
const CHAT = typeof args.chat === "string" ? args.chat : "live";
const HEALTH = typeof args.health === "string" ? args.health : "running";
const OPEN = typeof args.open === "string" ? args.open : null;
const CHANGES = typeof args.changes === "string" ? args.changes : "dirty";
const ACTIVITY_STATE = typeof args.activity === "string" ? args.activity : "rows";
const ADMIN = typeof args.admin === "string" ? args.admin : "legacy";
const KEYS = typeof args.keys === "string" ? args.keys.split(",") : [];
const CLICKS = typeof args.click === "string" ? args.click.split("|") : [];
const NAME = typeof args.name === "string" ? args.name : null;
/** The fleet's own reads: what --state=loading|error|empty changes (sign-in and plane reads stay). */
const FLEET_READ = /^\/api\/(fleet|nodes|runtimes|activity|admin\/principals)/;
const OUT = resolve(typeof args.out === "string" ? args.out : join(here, "shots"));
const VIEWPORT = { desktop: { width: 1440, height: 900 }, tablet: { width: 1024, height: 800 }, phone: { width: 390, height: 844 } };
// --height=N makes the desktop viewport taller (the stage scrolls inside the shell, so a full-page
// shot would not show more): for comparing a long page with its mockup.
if (typeof args.height === "string") VIEWPORT.desktop.height = Number(args.height);

// ---- the sample fleet (contract shapes: NodeSummary, FleetAgent, FleetStats, StationRow) ----
// The page's clock is fixed at today's noon (Daylight's noon sky); the sample times count back from it.
const NOON = new Date();
NOON.setHours(12, 0, 0, 0);
const ago = (min) => new Date(NOON.getTime() - min * 60_000).toISOString();
const node = (id, name, os, arch, status, agentVersion, latestVersion, lastSeen) => ({
  id, name, hostname: name, os, arch, cpuCount: 8, status, lastSeenAt: lastSeen, createdAt: ago(60 * 24 * 30),
  agentVersion, latestVersion, updateAvailable: latestVersion !== null && agentVersion !== latestVersion,
  capabilities: status === "online" ? ["posture"] : null, purpose: null, provisioned: null,
});
const NODES = [
  node("n_ashram", "ashram", "linux", "amd64", "online", "v0.1.96", "v0.1.97", ago(0)),
  node("n_guild", "guild", "linux", "amd64", "online", "v0.1.97", "v0.1.97", ago(0)),
  node("n_mbp", "MacBook Pro", "darwin", "arm64", "offline", "v0.1.95", null, ago(60 * 48)),
];
const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
const agent = (stationId, agentName, harness, nodeId, status) => {
  const n = byId[nodeId];
  const live = status === "running";
  return {
    stationId, nodeId, nodeName: n.name, agentName, harness, kind: "harness", nodeStatus: n.status,
    agentVersion: n.agentVersion, latestVersion: n.latestVersion, updateAvailable: n.updateAvailable,
    capabilities: ["health", "logs", "fs", "terminal", "lifecycle", "acp"], workspacePath: `/home/agents/${agentName}`,
    status, cpuPct: live ? 2.5 : null, memBytes: live ? 210_000_000 : null, uptimeSec: live ? 86_400 : null, note: null,
  };
};
const AGENTS = [
  agent("st_annapurna", "annapurna", "openclaw", "n_ashram", "running"),
  agent("st_chotu", "chotu", "hermes", "n_guild", "running"),
  agent("st_quill", "quill", "claude-code", "n_guild", "running"),
  agent("st_echo", "echo", "opencode", "n_mbp", "unknown"),
  agent("st_kai", "kai", "pi", "n_guild", "error"),
];
const STATS = { nodes: { total: 3, online: 2 }, agents: { total: 5 }, updatesAvailable: 1, running: 3 };
// annapurna advertises every station tab (Files with write, Changes, Cleanup, the skill inventory).
const TAB_CAPS = ["fs.write", "changeset", "cleanup", "skills.inventory"];
const station = (a) => ({
  id: a.stationId, userId: "u_rakesh", nodeId: a.nodeId, harness: a.harness, stationKey: `${a.harness}:${a.agentName}`,
  kind: "harness", parentStationId: null, displayName: a.agentName, workspacePath: a.workspacePath,
  capabilities: a.agentName === "annapurna" ? [...a.capabilities, ...TAB_CAPS] : a.capabilities, matrixId: null, bridgeMatrixId: `@agent_${a.agentName}:id.agentpod.dev`, matrixIdentityMode: "bridge",
  purpose: a.agentName === "annapurna" ? "personal" : null,
  principalId: `p_${a.agentName}`, adoptedAt: ago(60 * 24 * 10), createdAt: ago(60 * 24 * 10),
});
const ACTIVITY = [
  { id: "a1", verb: "station.restart", stationKey: "claude-code:quill", nodeId: "n_guild", result: "ok", createdAt: ago(0) },
  { id: "a2", verb: "station.restart", stationKey: "pi:kai", nodeId: "n_guild", result: "error", createdAt: ago(5) },
  { id: "a3", verb: "station.restart", stationKey: "pi:kai", nodeId: "n_guild", result: "error", createdAt: ago(6) },
  { id: "a4", verb: "node.update", nodeId: "n_guild", result: "ok", createdAt: ago(180) },
  { id: "a5", verb: "fs.write", stationKey: "openclaw:annapurna", nodeId: "n_ashram", result: "ok", createdAt: ago(60 * 48) },
];
const RUNTIMES = [
  { id: "rt_sandbox", ownerId: "u_rakesh", provider: "docker", externalId: "c1", status: "online", nodeId: "n_guild", name: "sandbox-pi", resourceTier: "small", harness: "pi", runtime: "runsc", statusReason: null, createdAt: ago(60 * 48), updatedAt: ago(60) },
  { id: "rt_edge", ownerId: "u_rakesh", provider: "cloudflare", externalId: "c2", status: "asleep", nodeId: null, name: "edge-opencode", resourceTier: "medium", harness: "opencode", runtime: null, statusReason: null, createdAt: ago(60 * 24 * 5), updatedAt: ago(60) },
  { id: "rt_scratch", ownerId: "u_rakesh", provider: "docker", externalId: "c3", status: "error", nodeId: null, name: "scratch-1", resourceTier: "small", harness: "none", runtime: "runc", statusReason: "no node enrolled within 2m of the start request", createdAt: ago(1), updatedAt: ago(1) },
];
const detected = (nodeId) =>
  AGENTS.filter((a) => a.nodeId === nodeId)
    .map((a) => ({ key: `${a.harness}:${a.agentName}`, harness: a.harness, kind: "leaf", displayName: a.agentName, parentKey: null, workspacePath: a.workspacePath, capabilities: a.capabilities, adopted: true }))
    .concat(nodeId === "n_ashram" ? [{ key: "codex:scratch", harness: "codex", kind: "leaf", displayName: "scratch", parentKey: null, workspacePath: "/home/rakesh/code/scratch", capabilities: [], adopted: false }] : []);
// ---- the station page: annapurna (openclaw on ashram), its session and its log ----
const SESSION = {
  id: "as_1", stationId: "st_annapurna", userId: "u_rakesh", mode: "ask", status: CHAT === "ended" ? "ended" : "waiting",
  endedReason: CHAT === "ended" ? "ended by you" : null, createdAt: ago(3), lastEventAt: ago(0),
  title: "Your IDENTITY.md still says you live on superchotu", lastSeq: 6,
};
const ev = (seq, type, payload) => ({ sessionId: SESSION.id, seq, type, payload, createdAt: ago(3 - seq * 0.3) });
const EVENTS = [
  ev(1, "user-prompt", { text: "Your IDENTITY.md still says you live on superchotu. The node is called ashram now. Can you fix that?" }),
  ev(2, "agent-update", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The file is in the workspace root; read it, then edit the host line." } }),
  ev(3, "agent-update", { sessionUpdate: "tool_call", toolCallId: "tc_read", title: "Read IDENTITY.md", kind: "read", status: "completed" }),
  ev(4, "agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It says `host: superchotu`. I'll change it to **ashram**." } }),
  ev(5, "permission-request", {
    toolCall: { toolCallId: "tc_edit", title: "Edit IDENTITY.md", kind: "edit" },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  }),
  ev(6, "state", { status: CHAT === "ended" ? "ended" : "waiting", ...(CHAT === "ended" ? { reason: "ended by you" } : {}) }),
];
const HEALTHS = {
  running: { running: true, pid: 4242, cpuPct: 2.5, memBytes: 210_000_000, diskBytes: 1_400_000_000, uptimeSec: 86_400, lastActivity: ago(1), note: null },
  stopped: { running: false, pid: null, cpuPct: null, memBytes: null, diskBytes: 1_400_000_000, uptimeSec: null, lastActivity: ago(90), note: null },
};
const OFF = { enabled: false, url: null, model: null, maxSeconds: null, source: "none" };
const TRANSCRIPTION = { mode: "inherit", hasApiKey: false, effective: OFF };
const SPEECH = {
  mode: "inherit", hasApiKey: false, assignedVoice: "af_heart", inheritedVoice: "af_heart", inheritedVoiceSource: "assigned",
  effective: { enabled: false, url: null, voice: "af_heart", voiceSource: "assigned", speakMode: "off", maxChars: 600, source: "none" },
};
const LOG_LINES = [
  "INFO openclaw gateway listening on 127.0.0.1:18789",
  "INFO gateway session attached (ask)",
  "WARN gateway slow upstream response: 4120 ms",
  "INFO tool read IDENTITY.md via gateway",
  "INFO matrix synced @agent_annapurna:id.agentpod.dev",
];
// ---- the station tabs (contract shapes: FsEntry, ChangesetStatusResult, CleanupItem, StationAuditRow) ----
const fsEntry = (path, type, size, min) => ({ name: path.split("/").pop(), path, type, size: type === "dir" ? null : size, modified: min == null ? null : ago(min) });
const FILES = {
  "": [fsEntry("memory", "dir"), fsEntry("skills", "dir"), fsEntry("AGENTS.md", "file", 980, 60 * 24 * 3), fsEntry("IDENTITY.md", "file", 142, 60 * 24 * 3), fsEntry("SOUL.md", "file", 2100, 60 * 24 * 9), fsEntry("avatar.png", "file", 48_000, 60 * 24 * 20), fsEntry("openclaw.json", "file", 640, 60 * 5), fsEntry("sessions.db", "file", 2_400_000, 1)],
  memory: [fsEntry("memory/2026-10-18.md", "file", 512, 60 * 20)],
  skills: [],
};
const FILE_TEXT = {
  "IDENTITY.md": "# IDENTITY\n\nname: annapurna\nhome: superchotu\npurpose: personal\n\nI keep Rakesh's notes, reminders and day plans.\n",
  "AGENTS.md": "# AGENTS\n\nRead SOUL.md first.\n",
  "openclaw.json": '{\n  "gateway": { "port": 18789 },\n  "mode": "ask"\n}\n',
};
const CHANGESETS = {
  dirty: {
    repo: { branch: "main", head: "abc1234", detached: false },
    base: { ref: "origin/main", sha: "def5678", reason: "upstream" },
    uncommitted: { files: [
      { path: "README.md", oldPath: null, status: "modified", insertions: 6, deletions: 3, binary: false },
      { path: "notes/plan.md", oldPath: null, status: "untracked", insertions: null, deletions: null, binary: false },
    ], insertions: 6, deletions: 3 },
    committed: { files: [{ path: "docs/setup.md", oldPath: "SETUP.md", status: "renamed", insertions: 2, deletions: 1, binary: false }],
      insertions: 2, deletions: 1, commits: [
        { sha: "a41c9e2", shortSha: "a41c9e2", subject: "Add setup notes", author: "annapurna", committedAt: ago(60) },
        { sha: "7be0d13", shortSha: "7be0d13", subject: "Fix typo in README", author: "annapurna", committedAt: ago(90) },
      ] },
    truncatedFiles: false,
  },
};
CHANGESETS.clean = { ...CHANGESETS.dirty, uncommitted: { files: [], insertions: 0, deletions: 0 }, committed: { files: [], insertions: 0, deletions: 0, commits: [] } };
const PATCH = "@@ -1,5 +1,8 @@\n # annapurna\n-Notes for the guild.\n+Notes for the guild, kept by annapurna.\n+\n+See docs/setup.md to get started.\n";
const CLEANUP = { items: [
  { path: "/home/agents/annapurna/node_modules/.cache", size: 640_000_000, kind: "cache" },
  { path: "/home/agents/annapurna/.claude/todos", size: 12_000_000, kind: "session" },
  { path: "/home/agents/annapurna/dist", size: 48_000_000, kind: "build" },
], totalBytes: 700_000_000 };
const STATION_ACTIVITY = [
  { id: "sa1", userId: "u_rakesh", stationId: "st_annapurna", verb: "fs.write", paramsSummary: { path: "README.md" }, result: "ok", error: null, createdAt: ago(0.2) },
  { id: "sa2", userId: "u_rakesh", stationId: "st_annapurna", verb: "terminal.open", paramsSummary: { cols: 120, rows: 32 }, result: "ok", error: null, createdAt: ago(3) },
  { id: "sa3", userId: "u_rakesh", stationId: "st_annapurna", verb: "lifecycle", paramsSummary: { action: "restart" }, result: "error", error: "the gateway did not come back within 30s", createdAt: ago(120) },
];
const SKILLS = { stationKey: "openclaw:annapurna", harness: "openclaw", observedAt: ago(1), skills: [], plugins: [],
  coverage: { complete: true, roots: [{ path: "/home/agents/annapurna/skills", scope: "workspace", status: "scanned" }], limitations: [] }, issues: [] };
const MCP = { stationId: "st_annapurna", stationKey: "openclaw:annapurna", displayName: "annapurna", harness: "openclaw", eligible: true, declared: true, serving: true, state: "on" };
// A short fake PTY stream: a prompt, a command, its output, a fresh prompt (ANSI colours from the vibe).
const PTY = "\x1b[32mannapurna@ashram\x1b[0m:\x1b[34m~/workspace\x1b[0m$ git status --short\r\n M README.md\r\n?? notes/plan.md\r\n\x1b[32mannapurna@ashram\x1b[0m:\x1b[34m~/workspace\x1b[0m$ ";

const USER = { id: "u_rakesh", email: "rakesh@example.com", name: "Rakesh Gangwar", image: null, role: "admin", emailVerified: true, createdAt: ago(1e5), updatedAt: ago(1e5) };

function answer(path, query = new URLSearchParams()) {
  if (path === "/health") return { status: "ok" };
  if (path === "/public/org-plane") return null; // 404: no plane, so the session comes from get-session
  if (path === "/api/auth/get-session" && SIGNED_OUT) return null;
  if (path === "/api/auth/signup-status") return { enabled: false, message: null };
  if (STATE === "empty" && FLEET_READ.test(path)) {
    if (path === "/api/fleet/agents") return { stats: { nodes: { total: 0, online: 0 }, agents: { total: 0 }, updatesAvailable: 0, running: 0 }, agents: [] };
    if (path === "/api/fleet/stats") return { nodes: { total: 0, online: 0 }, agents: { total: 0 }, updatesAvailable: 0, running: 0 };
    if (path === "/api/admin/principals") return { principals: [] };
    return [];
  }
  if (path === "/api/auth/get-session") return { user: USER, session: { id: "s1", userId: USER.id, expiresAt: ago(-60 * 24) } };
  if (path === "/api/me") return { id: USER.id, email: USER.email, isAdmin: true };
  if (path === "/api/fleet/agents") return { stats: STATS, agents: AGENTS };
  if (path === "/api/fleet/stats") return STATS;
  if (path === "/api/nodes") return NODES;
  if (path === "/api/runtimes") return RUNTIMES;
  if (path === "/api/runtimes/providers") return [];
  if (path === "/api/activity") return ACTIVITY;
  if (path === "/api/admin/principals")
    return { principals: AGENTS.map((a) => ({ id: `p_${a.agentName}`, kind: "agent", handle: a.agentName, displayName: a.agentName, userId: null, suspendedAt: null })) };
  if (path === "/api/admin/stats") return { stats: { totalUsers: 2, adminUsers: 1, bannedUsers: 0, totalSandboxes: 0, runningSandboxes: 0, usersThisWeek: 1 } };
  if (path === "/api/admin/users") return { users: ADMIN_USERS, total: ADMIN_USERS.length };
  const au = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (au) return ADMIN_USERS.find((u) => u.id === au[1]) ? { user: ADMIN_USERS.find((u) => u.id === au[1]) } : null;
  if (path === "/api/admin/settings/signup") return { enabled: false };
  if (path === "/api/admin/bridge/agents") return { agents: BRIDGE };
  if (path === "/api/admin/settings/speech")
    return { enabled: true, url: "http://speech:8841", defaultVoice: "", mode: "on-voice", maxChars: 1200, hasApiKey: true, source: "env" };
  if (path === "/api/admin/settings/transcription")
    return { enabled: true, url: "http://transcriber:8840", model: "large-v3-turbo", maxSeconds: 120, hasApiKey: false, source: "settings" };
  if (/^\/api\/stations\/[^/]+\/files$/.test(path)) return FILES[query.get("path") ?? ""] ?? [];
  if (/^\/api\/stations\/[^/]+\/changeset\/status$/.test(path)) return CHANGESETS[CHANGES] ?? CHANGESETS.dirty;
  if (/^\/api\/stations\/[^/]+\/changeset\/diff$/.test(path)) return { content: PATCH, truncated: false, binary: false };
  if (/^\/api\/stations\/[^/]+\/cleanup\/plan$/.test(path)) return CLEANUP;
  if (/^\/api\/stations\/[^/]+\/activity$/.test(path)) return ACTIVITY_STATE === "empty" ? [] : STATION_ACTIVITY;
  if (/^\/api\/stations\/[^/]+\/skills\/inventory$/.test(path)) return SKILLS;
  if (/^\/api\/stations\/[^/]+\/mcp-proxy$/.test(path)) return MCP;
  if (/^\/api\/stations\/[^/]+\/acp\/sessions$/.test(path)) return CHAT === "none" ? [] : [SESSION];
  if (/^\/api\/stations\/[^/]+\/health$/.test(path)) return HEALTHS[HEALTH] ?? HEALTHS.running;
  if (/^\/api\/stations\/[^/]+\/transcription$/.test(path)) return TRANSCRIPTION;
  if (/^\/api\/stations\/[^/]+\/speech$/.test(path)) return SPEECH;
  if (path === "/api/speech/voices") return { voices: [], default: null, aliases: {} };
  if (/^\/api\/admin\/stations\/[^/]+\/setup$/.test(path))
    return { principalId: "p_annapurna", matrix: { status: "provisioned", address: "@agent_annapurna:id.agentpod.dev", roomId: "!room:id.agentpod.dev", mode: "bridge" } };
  if (path === "/api/admin/grants")
    return { enforced: true, grants: [{ principalId: "p_rakesh", mayDispatch: ["p_annapurna"], mayGrantReach: [] }] };
  const det = path.match(/^\/api\/nodes\/([^/]+)\/detected$/);
  if (det) return detected(det[1]);
  const st = path.match(/^\/api\/nodes\/([^/]+)\/stations$/);
  if (st) return AGENTS.filter((a) => a.nodeId === st[1]).map(station);
  const one = path.match(/^\/api\/nodes\/([^/]+)$/);
  if (one) return byId[one[1]] ?? null;
  return undefined;
}

// ---- the admin area (a hub without the account plane) ----
const ADMIN_USERS = [
  { id: "u_rakesh", email: "rakesh@example.com", name: "Rakesh", role: "admin", banned: false, bannedReason: null, bannedAt: null, emailVerified: true, image: null, createdAt: "2026-06-29T00:00:00Z", updatedAt: "2026-06-29T00:00:00Z", sandboxCount: 0, runningSandboxCount: 0 },
  { id: "u_one", email: "u1@x.test", name: "User One", role: "user", banned: false, bannedReason: null, bannedAt: null, emailVerified: true, image: null, createdAt: "2026-10-14T00:00:00Z", updatedAt: "2026-10-14T00:00:00Z", sandboxCount: 0, runningSandboxCount: 0 },
];
const BRIDGE = [
  { key: "coder-kai", boardId: "brd_6a899b0f0d054046", stationId: "st_kai", stationName: "kai", hubUserId: "u_rakesh", mode: "accept-edits", permissionWaitMs: null, maxConcurrency: null, profileKey: null, enabled: true, hasToken: true, hasMcpToken: true, createdAt: "2026-10-01T00:00:00Z" },
  { key: "writer-quill", boardId: "brd_6a899b0f0d054046", stationId: "st_quill", stationName: "quill", hubUserId: "u_rakesh", mode: "full-auto", permissionWaitMs: null, maxConcurrency: null, profileKey: null, enabled: false, hasToken: true, hasMcpToken: false, createdAt: "2026-10-02T00:00:00Z" },
];
const PLANE_OWNED = /^\/api\/admin\/(users|grants|settings\/signup)/;

// ---- a tiny static server with the SPA fallback ----
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
async function serve() {
  if (!existsSync(join(BUILD, "index.html"))) throw new Error(`No build at ${BUILD}: run PUBLIC_HUB_URL=${HUB} pnpm build first.`);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let file = join(BUILD, decodeURIComponent(url.pathname));
    if (!file.startsWith(BUILD)) return res.writeHead(403).end();
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(BUILD, "index.html");
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** playwright-core finds its own revision in the Playwright cache; PLAYWRIGHT_CHROMIUM overrides. */
const chromiumPath = () => process.env.PLAYWRIGHT_CHROMIUM || undefined;

const { server, origin } = await serve();
const browser = await chromium.launch({ executablePath: chromiumPath() });
await mkdir(OUT, { recursive: true });
const unknown = new Set();
try {
  for (const vibe of VIBES)
    for (const theme of THEMES)
      for (const size of SIZES) {
        const context = await browser.newContext({ viewport: VIEWPORT[size], deviceScaleFactor: 1, colorScheme: theme });
        const strength = vibe === "quiet" ? "off" : "strong";
        await context.addCookies([{ name: "vk_appearance", value: `${vibe}.${theme}.${strength}.0`, url: origin }]);
        const page = await context.newPage();
        // Noon, so Daylight's sky is the mockups' noon sky.
        await page.clock.setFixedTime(NOON);
        await page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          if (url.origin !== HUB) return route.abort();
          if (STATE === "loading" && FLEET_READ.test(url.pathname)) return; // never answered
          if (/^\/api\/stations\/[^/]+\/logs$/.test(url.pathname))
            return route.fulfill({
              status: 200,
              headers: { "content-type": "text/event-stream" },
              body: LOG_LINES.map((l) => `data: ${l}\n\n`).join(""),
            });
          if (/^\/api\/stations\/[^/]+\/file$/.test(url.pathname)) {
            const text = FILE_TEXT[url.searchParams.get("path") ?? ""];
            return text === undefined ? route.fulfill({ status: 404, json: { error: "not found" } })
              : route.fulfill({ status: 200, headers: { "content-type": "text/plain" }, body: text });
          }
          if (CHANGES === "error" && /\/changeset\/status$/.test(url.pathname))
            return route.fulfill({ status: 500, json: { error: "The hub hit an internal error. Try again in a moment." } });
          if (ACTIVITY_STATE === "error" && /^\/api\/stations\/[^/]+\/activity$/.test(url.pathname))
            return route.fulfill({ status: 500, json: { error: "Couldn't load activity." } });
          if (HEALTH === "error" && /^\/api\/stations\/[^/]+\/health$/.test(url.pathname))
            return route.fulfill({ status: 502, json: { error: "The node did not answer." } });
          if (ADMIN === "plane" && PLANE_OWNED.test(url.pathname))
            return route.fulfill({ status: 410, json: { error: "managed_by_org_plane", url: "https://accounts.superjackfruit.com/members" } });
          if (url.pathname === "/api/admin/stats") {
            if (ADMIN === "denied") return route.fulfill({ status: 403, json: { error: "Forbidden" } });
            if (ADMIN === "500") return route.fulfill({ status: 500, json: {} });
            if (ADMIN === "offline") return route.abort("internetdisconnected");
          }
          if (STATE === "error" && FLEET_READ.test(url.pathname))
            return route.fulfill({ status: 500, json: { error: "The hub could not read the fleet." } });
          const body = answer(url.pathname, url.searchParams);
          if (body === undefined) {
            unknown.add(url.pathname);
            return route.fulfill({ status: 404, json: { error: "not stubbed" } });
          }
          if (body === null) return route.fulfill({ status: 404, json: { error: "not found" } });
          return route.fulfill({ status: 200, json: body });
        });
        // The session's socket: on subscribe, replay the transcript, then stay open.
        await page.routeWebSocket(/\/api\/acp\/sessions\/[^/]+\/ws/, (ws) => {
          ws.onMessage(() => {
            ws.send(JSON.stringify({ t: "session", session: SESSION }));
            for (const event of EVENTS) ws.send(JSON.stringify({ t: "event", event }));
            ws.send(JSON.stringify({ t: "replay-done", lastSeq: 6 }));
          });
        });
        // The terminal's socket: replay a short PTY stream, then stay open.
        await page.routeWebSocket(/\/api\/stations\/[^/]+\/terminal/, (ws) => {
          ws.send(JSON.stringify({ t: "data", data: Buffer.from(PTY, "utf8").toString("base64") }));
          ws.onMessage(() => {});
        });
        await page.goto(origin + PATH + (TAB ? `?tab=${TAB}` : ""));
        if (SIGNED_OUT) await page.waitForSelector(".ap-auth__card", { timeout: 15_000 });
        else {
          await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
          if (STATE === "populated") await page.waitForSelector('[data-testid="roster-row"]', { timeout: 15_000 }).catch(() => {});
        }
        let suffix = "";
        if (args.menu && size === "desktop") {
          await page.click('[data-testid="account-chip"]');
          await page.click('[data-testid="account-menu"] button[aria-expanded]');
          suffix = "-menu";
        }
        if (args.more && size === "phone") {
          await page.click('[data-testid="phone-bar"] button');
          await page.waitForSelector('[data-testid="more-sheet"]');
          suffix = "-more";
        }
        if (args.about && size === "phone") {
          await page.click(".ap-st-about");
          await page.waitForSelector('[data-testid="station-about"]');
          suffix += "-about";
        }
        if (TAB === "files" && OPEN) {
          await page.click(`[role="treeitem"][data-tree-path="${OPEN}"] .ap-ftree-row`);
          await page.waitForSelector(".ap-pbar");
          suffix += `-${OPEN.replace(/\W+/g, "_")}`;
        }
        if (TAB === "changes" && CHANGES === "dirty") {
          await page.click('[data-testid="changeset-file-README.md"]').catch(() => {});
          await page.waitForSelector("[data-diff]").catch(() => {});
        }
        if (TAB === "changes" && CHANGES !== "dirty") suffix += `-${CHANGES}`;
        if (TAB === "cleanup" && args.scan) {
          await page.click('.ap-panel button:has-text("Scan")');
          await page.waitForSelector('.ap-list');
          await page.click('.ap-list input[type="checkbox"]');
          suffix += "-scan";
        }
        if (TAB === "activity" && ACTIVITY_STATE !== "rows") suffix += `-${ACTIVITY_STATE}`;
        if (TAB) suffix += `-${TAB}`;
        if (CHAT !== "live") suffix += `-chat${CHAT}`;
        if (HEALTH !== "running") suffix += `-health${HEALTH}`;
        await page.waitForTimeout(400);
        for (const key of KEYS) await page.keyboard.press(key);
        for (const sel of CLICKS) {
          await page.click(sel);
          await page.waitForTimeout(250);
        }
        if (KEYS.length || CLICKS.length) await page.waitForTimeout(300);
        if (ADMIN !== "legacy") suffix += `-admin${ADMIN}`;
        if (NAME) suffix += `-${NAME}`;
        if (STATE !== "populated") suffix += `-${STATE}`;
        if (SIGNED_OUT) suffix += "-signedout";
        const name = `${PATH === "/" ? "fleet" : PATH.replace(/\W+/g, "_").replace(/^_|_$/g, "")}-${vibe}-${theme}-${size}${suffix}.png`;
        await page.screenshot({ path: join(OUT, name) });
        console.log(join(OUT, name));
        await context.close();
      }
} finally {
  await browser.close();
  server.close();
}
if (unknown.size) console.log(`Not stubbed (answered 404): ${[...unknown].join(", ")}`);
