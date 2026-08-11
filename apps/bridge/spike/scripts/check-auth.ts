/**
 * Cheapest possible check that the hub credentials work, before running
 * anything that touches a station.
 *
 *   bun run scripts/check-auth.ts
 *
 * Proves three things in order: the credential is accepted, the station exists
 * and is visible to this user, and it advertises the `acp` capability.
 */

// Deliberately does NOT use loadConfig(): that requires BOARD_ID/AGENT_TOKEN,
// which come from a kaambaan seed. Checking hub auth must not depend on
// kaambaan being up.
import { signIn, authHeaders } from "../src/hub";
import type { SpikeConfig } from "../src/config";

const c = {
  hubUrl: process.env.HUB_URL ?? "https://hub.agentpod.dev",
  hubToken: process.env.HUB_TOKEN?.trim() || undefined,
  hubCookie: process.env.HUB_COOKIE?.trim() || undefined,
  hubEmail: process.env.HUB_EMAIL?.trim() || undefined,
  hubPassword: process.env.HUB_PASSWORD?.trim() || undefined,
  stationId: process.env.STATION_ID ?? "",
} as SpikeConfig;

if (!c.stationId) throw new Error("STATION_ID required");
if (!c.hubToken && !c.hubCookie && !(c.hubEmail && c.hubPassword)) {
  throw new Error("set HUB_TOKEN (preferred), HUB_COOKIE, or HUB_EMAIL + HUB_PASSWORD");
}

const cookie = await signIn(c);

// There is no `GET /api/stations/:id`. The ACP session list is the cheapest
// authenticated read that ALSO proves the station supports agent sessions:
// station-acp.ts rejects a non-ACP station with 403 before doing any work.
const url = `${c.hubUrl}/api/stations/${c.stationId}/acp/sessions`;
const res = await fetch(url, {
  headers: { ...authHeaders(c), ...(cookie ? { Cookie: cookie } : {}) },
});

if (res.status === 401) {
  console.error("✗ 401 — the credential was rejected.");
  console.error("  HUB_TOKEN should be either the hub's API_TOKEN, or the VALUE of the");
  console.error("  __Secure-better-auth.session_token cookie (no name, no quotes).");
  console.error("  A session token expires — copy a fresh one if it is old.");
  process.exit(1);
}
if (res.status === 403) {
  console.error("✗ 403 — authenticated, but this station does not support agent sessions.");
  console.error("  Pick a station whose capabilities include `acp`.");
  process.exit(1);
}
if (res.status === 404) {
  console.error("✗ 404 — STATION_ID is unknown, or belongs to another account.");
  process.exit(1);
}
if (!res.ok) {
  console.error(`✗ ${res.status} ${await res.text()}`);
  process.exit(1);
}

const sessions = (await res.json()) as unknown[];
console.log("✓ credential accepted");
console.log(`✓ station ${c.stationId} supports acp (${sessions.length} existing session(s))`);
console.log("\n✓ ready — run `bun run scripts/probe-acp.ts` next");
