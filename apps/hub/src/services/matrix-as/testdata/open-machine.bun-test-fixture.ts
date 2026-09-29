/**
 * A test file that opens a real agent crypto machine and never closes it.
 *
 * Run by `crypto-exit.test.ts` as `bun test <this file>` in a child process, so
 * the exit under test is bun test's own — the path that aborted PR #618's CI
 * run (issue #457), and one that does not run `process.on('exit')` listeners.
 * The name deliberately matches none of bun test's file patterns, so the hub's
 * own run never collects it.
 */

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentCrypto } from "../crypto";

const DOMAIN = "id.agentpod.dev";
const ALICE = `@agent_alice:${DOMAIN}`;

test("an agent's machine is opened and left open", async () => {
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
  expect(crypto.loadedAgents()).toContain(ALICE);
  // Deliberately no crypto.close().
});
