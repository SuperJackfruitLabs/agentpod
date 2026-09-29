/**
 * Opens a real agent crypto machine, never closes it, and exits.
 *
 * Run as a child process by `crypto-exit.test.ts`. An `OlmMachine` still open
 * when Bun exits used to abort the process: Bun runs napi's env cleanup hooks,
 * napi-rs drops its Tokio runtime there, and the machine torn down afterwards
 * reaches for that runtime (`tokio_runtime.rs:114`, `Option::unwrap()` on
 * `None`) — SIGABRT, exit 134, issue #457.
 *
 *   bun exit-with-open-machine.ts natural   let the event loop drain
 *   bun exit-with-open-machine.ts exit      call process.exit(0), as the hub does
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentCrypto } from "../crypto";

const DOMAIN = "id.agentpod.dev";
const ALICE = `@agent_alice:${DOMAIN}`;

const crypto = createAgentCrypto({
  storeDir: await mkdtemp(join(tmpdir(), "agentpod-crypto-exit-")),
  domain: DOMAIN,
  // The emptiest answers the machine accepts; see answer() in crypto.test.ts.
  send: async (_userId, request) => {
    const parsed = JSON.parse(request.body || "{}") as { device_keys?: Record<string, unknown> };
    const deviceKeys: Record<string, unknown> = {};
    for (const user of Object.keys(parsed.device_keys ?? {})) deviceKeys[user] = {};
    return JSON.stringify({
      one_time_key_counts: { signed_curve25519: 50 },
      device_keys: deviceKeys,
      one_time_keys: {},
      failures: {},
    });
  },
  deviceIdFor: async () => "DEVICEFORTEST",
  uploadSigningKeys: async () => {},
});

await crypto.trackUsers(ALICE, [ALICE]);
if (!crypto.loadedAgents().includes(ALICE)) throw new Error("the machine was never opened");

// Deliberately no crypto.close().
if (process.argv[2] === "exit") process.exit(0);
