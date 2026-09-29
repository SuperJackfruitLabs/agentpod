/**
 * One-shot: move `SUPERPIPELINE_BRIDGE_AGENTS` out of `hub.env` and into `bridge_agents`.
 *
 * Run ON the hub host, once, after deploying the release that introduced the table. The roster
 * variable is no longer read by anything, so until this has run an enabled bridge claims nothing
 * and says so every tick.
 *
 * **The credentials never leave the machine.** That is the whole reason this exists rather than a
 * person copying four `spa_` tokens out of a file and pasting them into a form: the plaintext is
 * already on this host, and the encryption key that protects them in the table is too, so the
 * shortest safe path is to read and write both here.
 *
 * Idempotent. An agent whose key is already in the table is left exactly as it is — including its
 * credentials — so a re-run after a partial failure finishes the job rather than overwriting
 * whatever succeeded. Nothing is deleted, here or from `hub.env`; removing the variable is a
 * separate, deliberate step once this has been verified.
 *
 *   cd /opt/agentpod/apps/hub
 *   set -a; . /etc/agentpod/hub.env; set +a
 *   bun scripts/seed-bridge-roster-from-env.ts            # what it would do
 *   bun scripts/seed-bridge-roster-from-env.ts --apply    # do it
 */

import { readFileSync } from "node:fs";

import { db } from "../src/db/drizzle";
import { stations } from "../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../src/db/schema/tenants";
import { createBridgeAgent, listBridgeAgents } from "../src/services/bridge/roster";
import { eq } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const ENV_FILE = process.env.HUB_ENV_FILE ?? "/etc/agentpod/hub.env";

interface LegacyAgent {
  key: string;
  boardId: string;
  token: string;
  stationId: string;
  hubUserId: string;
  mode?: string;
  permissionWaitMs?: number;
  maxConcurrency?: number;
  profileKey?: string;
  mcpToken?: string;
}

function legacyRoster(): LegacyAgent[] {
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch (err) {
    fail(`could not read ${ENV_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const line = raw.match(/^SUPERPIPELINE_BRIDGE_AGENTS=(.*)$/m);
  if (!line) fail(`${ENV_FILE} has no SUPERPIPELINE_BRIDGE_AGENTS — nothing to migrate`);

  // systemd's `EnvironmentFile=` strips exactly one surrounding layer of quotes, so this does too.
  // Getting that wrong in either direction is a documented past incident (DEPLOYMENT.md §pre-flight).
  let value = line![1]!.trim();
  if (value.length > 1 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
    value = value.slice(1, -1);
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) fail("SUPERPIPELINE_BRIDGE_AGENTS is not a JSON array");
    return parsed as LegacyAgent[];
  } catch (err) {
    fail(`SUPERPIPELINE_BRIDGE_AGENTS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fail(message: string): never {
  console.error(`seed-bridge-roster: ${message}`);
  process.exit(1);
}

/** Never the token itself, in a script whose whole point is that it does not travel. */
const mask = (t: string | undefined) => (t ? `${t.slice(0, 8)}…(${t.length} chars)` : "—");

const legacy = legacyRoster();
const existing = new Set((await listBridgeAgents(BOOTSTRAP_TENANT_ID)).map((a) => a.key));

console.log(`${legacy.length} agent(s) in ${ENV_FILE}; ${existing.size} already in the table.\n`);

let created = 0;
let skipped = 0;
let refused = 0;

for (const a of legacy) {
  if (existing.has(a.key)) {
    console.log(`  = ${a.key}  already rostered, left alone`);
    skipped++;
    continue;
  }

  // `hubUserId` is not migrated: it is read from the station now. But a roster entry whose
  // `hubUserId` disagreed with its station's owner was already broken — every ACP call would have
  // failed as "Station not found" — so a mismatch here is worth saying out loud rather than
  // silently correcting on the way past.
  const [station] = await db.select().from(stations).where(eq(stations.id, a.stationId));
  if (!station) {
    console.error(`  ! ${a.key}  names station ${a.stationId}, which does not exist — skipped`);
    refused++;
    continue;
  }
  if (a.hubUserId && station.userId !== a.hubUserId) {
    console.warn(
      `  ~ ${a.key}  hubUserId ${a.hubUserId} is not the station's owner (${station.userId}); ` +
        `the station's owner is what will be used, and is what actually worked`,
    );
  }

  console.log(
    `  + ${a.key}  board=${a.boardId} station=${station.displayName} ` +
      `mode=${a.mode ?? "full-auto"} token=${mask(a.token)} mcpToken=${mask(a.mcpToken)}`,
  );

  if (!APPLY) continue;

  try {
    await createBridgeAgent({
      tenantId: BOOTSTRAP_TENANT_ID,
      key: a.key,
      boardId: a.boardId,
      stationId: a.stationId,
      token: a.token,
      mcpToken: a.mcpToken ?? null,
      mode: a.mode,
      permissionWaitMs: a.permissionWaitMs ?? null,
      maxConcurrency: a.maxConcurrency ?? null,
      profileKey: a.profileKey ?? null,
      createdBy: null,
    });
    created++;
  } catch (err) {
    console.error(`  ! ${a.key}  refused: ${err instanceof Error ? err.message : String(err)}`);
    refused++;
  }
}

console.log(
  APPLY
    ? `\ncreated ${created}, left alone ${skipped}, refused ${refused}.`
    : `\nDRY RUN — nothing was written. Re-run with --apply.`,
);

if (APPLY && refused === 0) {
  console.log(
    "\nThe bridge picks these up within about ten seconds; look for `claiming` in the hub log.\n" +
      "Once you have seen that, SUPERPIPELINE_BRIDGE_AGENTS can be deleted from the env file.",
  );
}

process.exit(refused > 0 ? 1 : 0);
