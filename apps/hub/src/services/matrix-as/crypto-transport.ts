/**
 * Sending what the crypto machine asks to be sent.
 *
 * `OlmMachine` performs no network IO by design — it produces requests and
 * expects the caller's HTTP client to carry them. This is that carrier, and
 * it is the whole of the boundary between `crypto.ts` and the homeserver.
 *
 * Every request goes out **as the agent**, via the appservice's `?user_id=`
 * impersonation. Sending a device key upload as `@ai-bridge` and calling it
 * an agent's is the same class of mistake as a room full of agents speaking
 * with one voice — except that here the result is not a confusing transcript
 * but an agent whose keys belong to somebody else.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CryptoRequest } from './crypto';
import { createLogger } from '../../utils/logger';

const log = createLogger('matrix-as:crypto');

/**
 * Which endpoint each request type goes to.
 *
 * Keyed by the numeric value rather than the enum name: `RequestType` is an
 * ambient const enum, which `verbatimModuleSyntax` forbids reading at
 * runtime. The numbers are the enum's own and are stated here so a reader can
 * check them against the binding's `index.d.ts` without running anything.
 */
const ENDPOINTS: Record<number, { method: 'POST' | 'PUT'; path: (r: CryptoRequest) => string }> = {
  // KeysUpload — this device's identity and one-time keys.
  0: { method: 'POST', path: () => '/_matrix/client/v3/keys/upload' },
  // KeysQuery — whose devices exist, and what their keys are.
  1: { method: 'POST', path: () => '/_matrix/client/v3/keys/query' },
  // KeysClaim — take a one-time key so an olm session can be started.
  2: { method: 'POST', path: () => '/_matrix/client/v3/keys/claim' },
  // ToDevice — the megolm room key itself, addressed device to device.
  3: {
    method: 'PUT',
    path: (r) =>
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(r.eventType ?? 'm.room.encrypted')}/${encodeURIComponent(r.txnId ?? r.id)}`,
  },
  // SignatureUpload — cross-signing signatures.
  4: { method: 'POST', path: () => '/_matrix/client/v3/keys/signatures/upload' },
  // RoomMessage — used by verification flows, which agents do not run yet.
  5: {
    method: 'PUT',
    path: (r) =>
      `/_matrix/client/v3/rooms/${encodeURIComponent(r.roomId ?? '')}/send/${encodeURIComponent(r.eventType ?? 'm.room.message')}/${encodeURIComponent(r.txnId ?? r.id)}`,
  },
  // KeysBackup — server-side key backup, which this deployment does not use.
  6: { method: 'PUT', path: () => '/_matrix/client/v3/room_keys/keys' },
};

export interface CryptoTransportDeps {
  homeserverUrl: string;
  asToken: string;
  /**
   * The device this agent speaks through, named on every crypto request.
   *
   * `?user_id=` alone is not enough here, and the homeserver says so in a way
   * that is easy to misread: `403 M_FORBIDDEN — user must be authenticated
   * and device identified`. Crypto requests belong to a *device*, not just a
   * user, and an appservice acting for an agent that owns two devices has to
   * say which one. MSC4326; found by an end-to-end run, because every unit
   * test answers whatever it is asked.
   *
   * Per agent rather than one fixed id for all of them, because the device is
   * now issued by the homeserver at login — see `createDeviceProvisioner`.
   */
  deviceIdFor: (userId: string) => Promise<string>;
}

/**
 * The bytes to actually send for a request.
 *
 * Every request type but one sends its `body` verbatim. `SignatureUpload` is
 * the exception: the binding hands back `{"signed_keys": {…}}`, while
 * `/keys/signatures/upload` takes that inner map as the whole body and answers
 * a bare `400 M_BAD_JSON` when it does not get it — an error that names
 * neither the offending field nor the request.
 */
function bodyFor(request: CryptoRequest): string | undefined {
  if ((request.type as unknown as number) !== 4) return request.body;
  const parsed = JSON.parse(request.body ?? '{}') as { signed_keys?: unknown };
  return JSON.stringify(parsed.signed_keys ?? parsed);
}

/**
 * Build the `send` that `createAgentCrypto` needs.
 *
 * Returns the response body as a string, which is what `markRequestAsSent`
 * wants — the machine parses it into the strongly-typed reply for that
 * request, and is particular about it: a keys/upload answered with anything
 * lacking `one_time_key_counts` is rejected outright.
 */
export function createCryptoTransport(deps: CryptoTransportDeps) {
  return async function send(userId: string, request: CryptoRequest): Promise<string> {
    const route = ENDPOINTS[request.type as unknown as number];
    if (!route) {
      // A request type this build does not know is not survivable by
      // guessing: dropping it silently would leave the machine waiting for a
      // response that never comes, and every later flush would retry it.
      throw new Error(`no endpoint for crypto request type ${String(request.type)}`);
    }

    const url = new URL(route.path(request), deps.homeserverUrl);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('device_id', await deps.deviceIdFor(userId));

    const res = await fetch(url, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${deps.asToken}`,
        'Content-Type': 'application/json',
      },
      body: bodyFor(request),
    });

    const text = await res.text();
    if (!res.ok) {
      log.error('crypto request rejected by the homeserver', {
        userId,
        status: res.status,
        type: String(request.type),
        // The body of a failed crypto request can contain key material, so
        // only the error code goes in the log.
        errcode: safeErrcode(text),
      });
      throw new Error(`crypto request ${String(request.type)} failed: ${res.status}`);
    }
    return text;
  };
}

/** The `errcode` alone, never the body. */
function safeErrcode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errcode?: string };
    return parsed.errcode ?? 'unknown';
  } catch {
    return 'unparseable';
  }
}

/**
 * Get the device an agent's crypto runs as, creating one the first time.
 *
 * **The device comes from an appservice login, and its id is written next to
 * the keys it belongs to.** An earlier version used one fixed id (`AGENTPOD`)
 * created through MSC4190's `PUT /devices/{id}`; enabling MSC4190 for that
 * turns appservice login off for the whole appservice, which is how minting
 * and rotating every agent credential broke at once (#435). Login gives a
 * device without that trade, and is what the harness agents already use.
 *
 * The access token the login returns is deliberately dropped: crypto requests
 * go out as the appservice with `?user_id=&device_id=`, verified against
 * tuwunel 1.8.3 with MSC4190 off, so there is no reason to keep a per-agent
 * secret on disk. The token is never logged or written.
 *
 * `device` lives inside the agent's crypto store directory because the two are
 * useless apart: a store restored without its device id would log in again,
 * get a *different* device, and hold keys that device never uploaded. That is
 * why `backup-infra.sh` copies this file alongside the database.
 */
export function createDeviceProvisioner(deps: {
  homeserverUrl: string;
  asToken: string;
  /** Where each agent's crypto store lives; the device id goes inside it. */
  storeDir: string;
}) {
  const cache = new Map<string, Promise<string>>();

  return function deviceIdFor(userId: string): Promise<string> {
    const existing = cache.get(userId);
    if (existing) return existing;

    const resolved = (async () => {
      const localpart = userId.slice(1).split(':')[0] ?? userId;
      const dir = join(deps.storeDir, localpart);
      const file = join(dir, 'device');

      const saved = await readFile(file, 'utf8').catch(() => '');
      if (saved.trim()) return saved.trim();

      const res = await fetch(new URL('/_matrix/client/v3/login', deps.homeserverUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.asToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'm.login.application_service',
          identifier: { type: 'm.id.user', user: localpart },
        }),
      });

      const body = (await res.json().catch(() => ({}))) as {
        device_id?: string;
        errcode?: string;
      };
      if (!res.ok || !body.device_id) {
        throw new Error(
          `could not get a device for ${userId}: ${res.status} ${body.errcode ?? ''}`.trim() +
            (body.errcode === 'M_APPSERVICE_LOGIN_UNSUPPORTED'
              ? ' — the registration has io.element.msc4190 enabled, which disables' +
                ' appservice login; the bridge takes its device from login now, so' +
                ' that flag must be off'
              : ''),
        );
      }

      await mkdir(dir, { recursive: true });
      await writeFile(file, body.device_id, { mode: 0o600 });
      log.info('agent crypto device created', { userId, deviceId: body.device_id });
      return body.device_id;
    })();

    cache.set(userId, resolved);
    // A failed login must not be cached as the answer forever: the next
    // transaction should try again rather than throw the same stale error.
    void resolved.catch(() => cache.delete(userId));
    return resolved;
  };
}

/**
 * Publish an agent's cross-signing keys.
 *
 * `POST /keys/device_signing/upload` normally demands user-interactive auth,
 * which an appservice cannot perform. MSC3967 waives it when the account has
 * no cross-signing identity yet, which is exactly and only when this is
 * called — see `publishIdentity` in `crypto.ts`. A 401 here therefore means
 * the identity already exists on the server while the local store has lost
 * it, and the store is the thing to restore.
 */
export function createSigningKeyUploader(deps: CryptoTransportDeps) {
  return async function uploadSigningKeys(userId: string, body: string): Promise<void> {
    const url = new URL('/_matrix/client/v3/keys/device_signing/upload', deps.homeserverUrl);
    url.searchParams.set('user_id', userId);
    url.searchParams.set('device_id', await deps.deviceIdFor(userId));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.asToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!res.ok) {
      // The body carries the signing keys; only the code is safe to log.
      const errcode = await res
        .json()
        .then((j: unknown) => (j as { errcode?: string })?.errcode ?? '')
        .catch(() => '');
      throw new Error(
        `could not publish cross-signing keys for ${userId}: ${res.status} ${errcode}` +
          (res.status === 401
            ? ' — 401 here is an unanswerable UIA challenge: either the server already' +
              ' holds an identity for this agent (restore its crypto store), or this' +
              ' account has already uploaded device keys, which closes the waiver'
            : ''),
      );
    }
    log.info('published cross-signing identity', { userId });
  };
}
