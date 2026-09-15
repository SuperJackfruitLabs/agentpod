/**
 * Repair agents whose cross-signing identity outlived its private keys.
 *
 * ## Why this exists
 *
 * When the bridge moved off MSC4190 (#435, #437) its devices changed, so the
 * old `AGENTPOD` devices were deleted and their crypto stores moved aside.
 * That destroyed each agent's cross-signing **private** keys while the
 * **public** identity stayed on the homeserver — and replacing a published
 * identity turns out to need the flag that had just been turned off:
 *
 * ```
 * MSC4190 on  → POST /keys/device_signing/upload  200
 * MSC4190 off → POST /keys/device_signing/upload  401, and no UIA flows at all
 * ```
 *
 * So the repair is two passes with the flag moved between them. It is a
 * one-off: an agent created after this has nothing to repair, because it
 * publishes its identity once and keeps the keys.
 *
 * ## Running it
 *
 * Stop the hub first — two processes must not open one agent's store.
 *
 * ```sh
 * systemctl stop agentpod-hub
 *
 * # pass 1, with io.element.msc4190 FALSE: every agent gets its login device
 * bun run scripts/crypto-repair-identities.ts devices
 *
 * # flip io.element.msc4190 to TRUE, restart tuwunel, then:
 * bun run scripts/crypto-repair-identities.ts identities
 *
 * # flip it back to FALSE, restart tuwunel, then:
 * systemctl start agentpod-hub
 * ```
 *
 * Both passes are idempotent: an agent that already has its device keeps it,
 * and an agent whose identity already matches its store is re-published
 * harmlessly.
 */
import { readdir } from 'node:fs/promises';
import { createAgentCrypto } from '../src/services/matrix-as/crypto';
import {
  createCryptoTransport,
  createDeviceProvisioner,
  createSigningKeyUploader,
} from '../src/services/matrix-as/crypto-transport';

const HS = process.env.MATRIX_HOMESERVER_URL ?? 'https://id.agentpod.dev';
const DOMAIN = process.env.MATRIX_SERVER_NAME ?? 'id.agentpod.dev';
const TOKEN = process.env.MATRIX_AS_TOKEN ?? '';
const STORE = process.env.MATRIX_CRYPTO_STORE_DIR ?? '/var/lib/agentpod/crypto';
/** Where the pre-migration stores were moved. Names the agents to repair. */
const STALE = process.env.MATRIX_CRYPTO_STALE_DIR ?? '/var/lib/agentpod/crypto.stale-20260915';

const mode = process.argv[2];
if (mode !== 'devices' && mode !== 'identities') {
  console.error('usage: crypto-repair-identities.ts devices|identities');
  process.exit(2);
}
if (!TOKEN) {
  console.error('MATRIX_AS_TOKEN is required');
  process.exit(2);
}

/** Every agent that has a store now or had one before the migration. */
async function agents(): Promise<string[]> {
  const named = process.argv.slice(3);
  if (named.length) return named;

  const seen = new Set<string>();
  for (const dir of [STORE, STALE]) {
    for (const entry of await readdir(dir).catch(() => [] as string[])) {
      // Probe accounts from the migration itself are not worth repairing.
      if (entry.startsWith('agent_') && !entry.includes('_e2e_') && !entry.includes('probe')) {
        seen.add(entry);
      }
    }
  }
  return [...seen].sort();
}

const deviceIdFor = createDeviceProvisioner({
  homeserverUrl: HS,
  asToken: TOKEN,
  storeDir: STORE,
});
const wire = { homeserverUrl: HS, asToken: TOKEN, deviceIdFor };

const list = await agents();
console.log(`${mode}: ${list.length} agent(s)\n`);

let ok = 0;
const failed: string[] = [];

for (const localpart of list) {
  const userId = `@${localpart}:${DOMAIN}`;
  try {
    if (mode === 'devices') {
      const id = await deviceIdFor(userId);
      console.log(`  ok    ${localpart} — device ${id}`);
    } else {
      // One crypto per agent: building the machine is what publishes the
      // identity, and `receive` with an empty transaction is the cheapest way
      // to make that happen and then drain the outbox.
      const crypto = createAgentCrypto({
        storeDir: STORE,
        domain: DOMAIN,
        send: createCryptoTransport(wire),
        deviceIdFor,
        uploadSigningKeys: createSigningKeyUploader(wire),
      });
      try {
        await crypto.receive(userId, {});
        console.log(`  ok    ${localpart}`);
      } finally {
        await crypto.close();
      }
    }
    ok++;
  } catch (err) {
    failed.push(localpart);
    console.log(`  FAIL  ${localpart} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${ok} ok, ${failed.length} failed`);
if (failed.length) {
  console.log(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
