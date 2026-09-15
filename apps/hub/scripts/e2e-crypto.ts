/**
 * Two agents, one encrypted room, a real homeserver.
 *
 * Everything else in this subsystem is tested in pieces: the state machine
 * against a fake transport, the transaction route against a fake machine.
 * Both can pass while the whole thing fails, because the part neither covers
 * is the one that is hardest to get right — a megolm key actually reaching
 * another identity's device and decrypting there.
 *
 * So this talks to the real homeserver, as two real agents, and asserts that
 * what comes back out is what went in. It is a script rather than a test
 * because it needs credentials and a network, and `bun test` should not.
 *
 *     MATRIX_AS_TOKEN=... bun run scripts/e2e-crypto.ts
 *
 * It leaves two `@agent_e2e_*` users and one room behind. Both are cheap and
 * reusable; the room is named so it is obvious what it is.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCrypto } from '../src/services/matrix-as/crypto';
import {
  createCryptoTransport,
  createDeviceProvisioner,
  createSigningKeyUploader,
} from '../src/services/matrix-as/crypto-transport';

const HS = process.env.MATRIX_HOMESERVER_URL ?? 'https://id.agentpod.dev';
const DOMAIN = process.env.MATRIX_SERVER_NAME ?? 'id.agentpod.dev';
const TOKEN = process.env.MATRIX_AS_TOKEN ?? '';
if (!TOKEN) throw new Error('MATRIX_AS_TOKEN is required');

/**
 * Fresh users every run, because a Matrix device's identity keys are
 * write-once.
 *
 * Re-running with fixed names against a throwaway store uploads *new* device
 * keys for a device id the homeserver already knows, and the homeserver keeps
 * the first set. The one-time keys are then signed by a key nobody can verify
 * against, every olm session fails to start, and the sender withholds the room
 * key with `m.no_olm` — with no error on either side. A run that reuses a
 * previous run's user is therefore testing the wrong thing.
 *
 * The same rule is why the crypto store is backed up: see `publishIdentity`.
 */
const RUN = Date.now().toString(36);
const ALICE = `@agent_e2e_a_${RUN}:${DOMAIN}`;
const BOB = `@agent_e2e_b_${RUN}:${DOMAIN}`;

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function api(
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; device?: string } = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(path, HS);
  if (opts.as) url.searchParams.set('user_id', opts.as);
  // To-device messages and key uploads belong to a *device*, not a user. An
  // appservice acting for an agent with more than one device must say which,
  // or the homeserver answers "device identified" errors — or, for /sync,
  // simply hands back no to-device traffic at all, which is worse because it
  // looks like nothing was sent.
  if (opts.device) url.searchParams.set('device_id', opts.device);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/**
 * Register an appservice user, tolerating one that already exists.
 *
 * `inhibit_login: true` is MSC4190's form, and is required once
 * `io.element.msc4190` is on: without it the homeserver answers
 * `M_APPSERVICE_LOGIN_UNSUPPORTED`, because under that MSC a device is no
 * longer something registration hands out — it is something the appservice
 * creates deliberately, which is the whole point. The response carries
 * `device_id: null` to say so.
 */
async function ensureUser(userId: string) {
  const localpart = userId.slice(1).split(':')[0]!;
  const res = await api('POST', '/_matrix/client/v3/register', {
    body: {
      type: 'm.login.application_service',
      username: localpart,
      inhibit_login: true,
    },
  });
  if (res.status !== 200 && res.body?.errcode !== 'M_USER_IN_USE') {
    throw new Error(`register ${userId}: ${res.status} ${res.body?.errcode ?? ''}`);
  }
}

async function main() {
  console.log(`\n  homeserver: ${HS}\n`);

  await ensureUser(ALICE);
  await ensureUser(BOB);
  check('both agents exist', true);

  // An encrypted room, created the way a client would: encryption is an
  // initial state event, because turning it on afterwards leaves a window in
  // which plaintext was possible.
  const created = await api('POST', '/_matrix/client/v3/createRoom', {
    as: ALICE,
    body: {
      name: 'crypto e2e',
      preset: 'private_chat',
      invite: [BOB],
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    },
  });
  const roomId = created.body?.room_id as string;
  check('encrypted room created', Boolean(roomId), roomId ?? String(created.status));
  if (!roomId) return;

  const joined = await api('POST', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    as: BOB,
  });
  check('bob joined', joined.status === 200, String(joined.status));

  const state = await api(
    'GET',
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
    { as: ALICE },
  );
  check('the room really is encrypted', state.status === 200, state.body?.algorithm ?? '');

  // Separate stores, as in production: one per agent, never shared.
  const dirA = await mkdtemp(join(tmpdir(), 'e2e-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'e2e-b-'));
  // Each agent gets its device the way production does: an appservice login,
  // remembered beside its store.
  const deviceA = createDeviceProvisioner({ homeserverUrl: HS, asToken: TOKEN, storeDir: dirA });
  const deviceB = createDeviceProvisioner({ homeserverUrl: HS, asToken: TOKEN, storeDir: dirB });
  const wire = { homeserverUrl: HS, asToken: TOKEN };
  const cryptoA = createAgentCrypto({
    storeDir: dirA,
    domain: DOMAIN,
    send: createCryptoTransport({ ...wire, deviceIdFor: deviceA }),
    deviceIdFor: deviceA,
    uploadSigningKeys: createSigningKeyUploader({ ...wire, deviceIdFor: deviceA }),
  });
  const cryptoB = createAgentCrypto({
    storeDir: dirB,
    domain: DOMAIN,
    send: createCryptoTransport({ ...wire, deviceIdFor: deviceB }),
    deviceIdFor: deviceB,
    uploadSigningKeys: createSigningKeyUploader({ ...wire, deviceIdFor: deviceB }),
  });

  try {
    // Both must publish device keys before either can encrypt to the other.
    await cryptoA.receive(ALICE, {});
    await cryptoB.receive(BOB, {});
    check('both agents uploaded device keys', true);

    const SECRET = `e2e-${Date.now()}-the-quick-brown-fox`;

    const envelope = await cryptoA.encrypt(ALICE, roomId, [ALICE, BOB], 'm.room.message', {
      msgtype: 'm.text',
      body: SECRET,
    });
    check(
      'alice produced an encrypted envelope',
      envelope.algorithm === 'm.megolm.v1.aes-sha2',
      String(envelope.algorithm ?? ''),
    );
    check('the plaintext is not in the envelope', !JSON.stringify(envelope).includes(SECRET));

    const sent = await api(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/${Date.now()}`,
      { as: ALICE, body: envelope },
    );
    check('the homeserver accepted it', sent.status === 200, String(sent.status));

    // What the server actually stored — the proof that nothing plaintext went
    // out, independent of what our own code believes it sent.
    const stored = await api(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(sent.body.event_id)}`,
      { as: ALICE },
    );
    check('the server stored it as m.room.encrypted', stored.body?.type === 'm.room.encrypted', String(stored.body?.type));

    // Bob's side. The megolm key reached him as a to-device message, which he
    // collects by syncing — the appservice gets these through MSC3202
    // instead, but the machine cannot tell the difference.
    const sync = await api('GET', '/_matrix/client/v3/sync?timeout=8000', {
      as: BOB,
      device: await deviceB(BOB),
    });
    const toDevice = sync.body?.to_device?.events ?? [];
    check('bob received to-device traffic', toDevice.length > 0, `${toDevice.length} event(s)`);

    await cryptoB.receive(BOB, {
      toDevice,
      otkCounts: sync.body?.device_one_time_keys_count ?? {},
    });

    console.log(
      `        to-device: ${toDevice
        .map((e: any) => `${e.type}${e.content?.code ? ` (${e.content.code})` : ''}`)
        .join(', ')}`,
    );
    const decrypted = await cryptoB.decrypt(BOB, roomId, stored.body);
    const body = (decrypted as any)?.content?.body;
    check('BOB DECRYPTED ALICE’S MESSAGE', body === SECRET, body ? `"${body}"` : 'no key');
  } finally {
    await cryptoA.close();
    await cryptoB.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }

  console.log(`\n  ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
