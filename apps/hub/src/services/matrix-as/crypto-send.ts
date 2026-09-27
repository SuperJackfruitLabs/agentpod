/**
 * Encrypting what agents send, when the room calls for it.
 *
 * A decorator around `MatrixClient` rather than a change inside it. The
 * client is 700 lines that every part of this bridge depends on and that
 * knows nothing about crypto; threading an optional `OlmMachine` through
 * every send would put a conditional in the hot path of a plaintext
 * deployment to serve a feature it has switched off.
 *
 * Wrapped, the decision is made once, at the edge:
 *
 *     sendText ─▶ is this room encrypted?
 *                   no  ─▶ the original client, unchanged
 *                   yes ─▶ share the key, encrypt, send m.room.encrypted
 *
 * ## Why the encrypted-ness is cached, and what that costs
 *
 * Every send would otherwise cost a state lookup. `m.room.encryption` is
 * effectively immutable — Matrix has no un-encrypt, and turning it *on* is a
 * state event this bridge would see — so caching "yes" forever is safe. A
 * cached "no" is the risk: a room encrypted by somebody else after we looked
 * would keep receiving plaintext from us. So "no" is cached only briefly,
 * and "yes" is permanent.
 */
import type { MatrixClient } from './client';
import type { AgentCrypto } from './crypto';
import { createLogger } from '../../utils/logger';

const log = createLogger('matrix-as:crypto-send');

/** How long a room is trusted to still be unencrypted. */
const UNENCRYPTED_TTL_MS = 60_000;

export interface EncryptedSendDeps {
  homeserverUrl: string;
  asToken: string;
}

export function withEncryption(
  client: MatrixClient,
  crypto: AgentCrypto,
  deps: EncryptedSendDeps,
): MatrixClient {
  /** roomId → true (forever) | { until } for a room seen unencrypted. */
  const encrypted = new Map<string, true | { until: number }>();

  async function get(path: string, asUserId: string): Promise<Response> {
    const url = new URL(path, deps.homeserverUrl);
    url.searchParams.set('user_id', asUserId);
    return fetch(url, { headers: { Authorization: `Bearer ${deps.asToken}` } });
  }

  async function isEncrypted(roomId: string, asUserId: string): Promise<boolean> {
    const cached = encrypted.get(roomId);
    if (cached === true) return true;
    if (cached && cached.until > Date.now()) return false;

    const res = await get(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
      asUserId,
    );
    if (res.ok) {
      encrypted.set(roomId, true);
      return true;
    }
    // A 404 is the ordinary answer for a room with no encryption state, which
    // is most of them. Anything else — a network blip, a permission problem —
    // is treated the same way on purpose: the alternative is failing a send
    // that would have worked, and an agent that cannot speak is worse than
    // one that speaks in the clear in a room that was never encrypted.
    if (res.status !== 404) {
      log.warn('could not read room encryption state; treating as plaintext', {
        roomId,
        status: res.status,
      });
    }
    encrypted.set(roomId, { until: Date.now() + UNENCRYPTED_TTL_MS });
    return false;
  }

  async function membersOf(roomId: string, asUserId: string): Promise<string[]> {
    const res = await get(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      asUserId,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { joined?: Record<string, unknown> };
    return Object.keys(body.joined ?? {});
  }

  /**
   * Encrypt and send, or fail loudly.
   *
   * There is deliberately no fallback to plaintext here. A room that says it
   * is encrypted has told every participant their messages are private, and
   * sending in the clear because encryption was inconvenient would be the one
   * failure this whole subsystem exists to prevent — and it would look like
   * success to the sender.
   */
  async function sendEncrypted(
    asUserId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<string | null> {
    // Everyone in the room needs the megolm session before anyone can read
    // the message, so the member list is fetched per send rather than cached:
    // somebody who joined a moment ago and is missing from a stale list does
    // not get a broken message, they get nothing at all.
    const members = await membersOf(roomId, asUserId);
    const envelope = await crypto.encrypt(asUserId, roomId, members, eventType, content);
    return client.sendCustomEvent(asUserId, roomId, 'm.room.encrypted', envelope);
  }

  return {
    ...client,

    // `extra` carries namespaced keys beside the body — the turn error card,
    // `dev.agentpod.turn_error`. It must survive both branches: every agent
    // room is encrypted, and rebuilding the content from `body` alone is how
    // no room received a card until 2026-09-26. As in the plain client, it
    // can never replace msgtype or body.
    async sendText(userId, roomId, body, extra) {
      if (!(await isEncrypted(roomId, userId))) {
        return client.sendText(userId, roomId, body, extra);
      }
      return sendEncrypted(userId, roomId, 'm.room.message', {
        ...(extra ?? {}),
        msgtype: 'm.text',
        body,
      });
    },

    async sendCustomEvent(userId, roomId, eventType, content) {
      // `m.room.encrypted` arrives here from `sendEncrypted` above, already
      // encrypted. Encrypting it again would produce an envelope inside an
      // envelope that no client unwraps.
      if (eventType === 'm.room.encrypted') {
        return client.sendCustomEvent(userId, roomId, eventType, content);
      }
      if (!(await isEncrypted(roomId, userId))) {
        return client.sendCustomEvent(userId, roomId, eventType, content);
      }
      return sendEncrypted(userId, roomId, eventType, content);
    },
  };
}
