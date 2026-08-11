/**
 * Cheapest possible check that the hub credentials work, before running
 * anything that touches a station.
 *
 *   bun run scripts/check-auth.ts
 *
 * Proves three things in order: the credential is accepted, the station exists
 * and is visible to this user, and it advertises the `acp` capability.
 */

import { loadConfig } from "../src/config";
import { signIn } from "../src/hub";

const c = loadConfig();

const cookie = await signIn(c);
console.log("✓ hub credential accepted");

const res = await fetch(`${c.hubUrl}/api/stations/${c.stationId}`, { headers: { Cookie: cookie } });
if (!res.ok) {
  console.error(`✗ station read → ${res.status} ${await res.text()}`);
  console.error("  If this is 401, the cookie is stale — copy a fresh one.");
  console.error("  If this is 404, STATION_ID is wrong or belongs to another account.");
  process.exit(1);
}

const station = (await res.json()) as any;
const caps: string[] = station?.capabilities ?? station?.station?.capabilities ?? [];
console.log(`✓ station visible: ${station?.displayName ?? station?.station?.displayName ?? c.stationId}`);
console.log(`  harness:      ${station?.harness ?? station?.station?.harness ?? "?"}`);
console.log(`  capabilities: ${caps.join(", ") || "(none reported)"}`);

if (!caps.includes("acp")) {
  console.error("\n✗ station does not advertise `acp` — the bridge cannot open a session on it.");
  process.exit(1);
}
console.log("\n✓ ready — run `bun run scripts/probe-acp.ts` next");
