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

    const res = await fetch(url, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${deps.asToken}`,
        'Content-Type': 'application/json',
      },
      body: request.body,
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
