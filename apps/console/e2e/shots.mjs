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
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const list = (v, d) => (typeof v === "string" ? v.split(",") : d);
const VIBES = list(args.vibes, ["daylight", "paper", "studio", "quiet"]);
const THEMES = list(args.themes, ["light", "dark"]);
const SIZES = list(args.sizes, ["desktop", "phone"]);
const PATH = typeof args.path === "string" ? args.path : "/";
const STATE = typeof args.state === "string" ? args.state : "populated";
const SIGNED_OUT = !!args.signedout;
/** The fleet's own reads: what --state=loading|error|empty changes (sign-in and plane reads stay). */
const FLEET_READ = /^\/api\/(fleet|nodes|runtimes|activity|admin\/principals)/;
const OUT = resolve(typeof args.out === "string" ? args.out : join(here, "shots"));
const VIEWPORT = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
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
const station = (a) => ({
  id: a.stationId, userId: "u_rakesh", nodeId: a.nodeId, harness: a.harness, stationKey: `${a.harness}:${a.agentName}`,
  kind: "harness", parentStationId: null, displayName: a.agentName, workspacePath: a.workspacePath,
  capabilities: a.capabilities, matrixId: null, bridgeMatrixId: null, matrixIdentityMode: "bridge", purpose: null,
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
const USER = { id: "u_rakesh", email: "rakesh@example.com", name: "Rakesh Gangwar", image: null, role: "admin", emailVerified: true, createdAt: ago(1e5), updatedAt: ago(1e5) };

function answer(path) {
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
  if (path === "/api/admin/stats") return { users: 1, nodes: 3, stations: 5 };
  const det = path.match(/^\/api\/nodes\/([^/]+)\/detected$/);
  if (det) return detected(det[1]);
  const st = path.match(/^\/api\/nodes\/([^/]+)\/stations$/);
  if (st) return AGENTS.filter((a) => a.nodeId === st[1]).map(station);
  const one = path.match(/^\/api\/nodes\/([^/]+)$/);
  if (one) return byId[one[1]] ?? null;
  return undefined;
}

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
          if (STATE === "error" && FLEET_READ.test(url.pathname))
            return route.fulfill({ status: 500, json: { error: "The hub could not read the fleet." } });
          const body = answer(url.pathname);
          if (body === undefined) {
            unknown.add(url.pathname);
            return route.fulfill({ status: 404, json: { error: "not stubbed" } });
          }
          if (body === null) return route.fulfill({ status: 404, json: { error: "not found" } });
          return route.fulfill({ status: 200, json: body });
        });
        await page.goto(origin + PATH);
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
        await page.waitForTimeout(400);
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
