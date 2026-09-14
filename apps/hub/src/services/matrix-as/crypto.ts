/**
 * End-to-end encryption for the appservice's agents.
 *
 * ## Why this is not matrix-bot-sdk
 *
 * The obvious route is `matrix-bot-sdk`, which implements encrypted
 * appservices and would handle all of this. It also wants to own the
 * `/_matrix/app/v1` transaction endpoint, the client, the intents and the
 * storage — and this service already has 11,000 lines of hand-rolled
 * `matrix-as` that work, are tested, and know things about stations, gates
 * and missions that no bridge SDK does.
 *
 * `@matrix-org/matrix-sdk-crypto-nodejs` is the same Rust state machine
 * underneath, minus the opinions: **it performs no network IO**. It is fed
 * what arrived, and it hands back requests for someone else to send. That
 * someone is `MatrixClient`, which already has `sendToDevice` — the one call
 * olm needs that a non-encrypted bridge would never have had.
 *
 * So this module is a translation layer, not a replacement:
 *
 *     transaction  ──▶  machine.receiveSyncChanges()
 *                          │
 *                          ▼
 *                       outgoingRequests()  ──▶  MatrixClient
 *
 * ## What the homeserver has to be doing
 *
 * `tuwunel` 1.8.2 added the MSC3202 transaction extensions this depends on —
 * device-list changes, one-time-key counts, unused fallback key types — and
 * 1.8.0 added MSC4190 device management. Neither is advertised in
 * `/_matrix/client/versions`, which is a trap: reading `unstable_features`
 * says they are absent, and the release notes say otherwise. The registration
 * needs `de.sorunome.msc2409.push_ephemeral: true` for any of it to arrive.
 *
 * ## One machine per agent
 *
 * Each `@agent_*` user is a separate Matrix identity with its own device and
 * its own keys, so each gets its own `OlmMachine`. They are cached here for
 * the life of the process because building one generates keys and hits the
 * store; the store itself is on disk and survives restarts.
 *
 * **That store is as load-bearing as the database.** Lose it and every agent
 * loses the keys to every encrypted room it is in, unrecoverably — the
 * existing nightly backup covers tuwunel's database and not this.
 */
import {
  DeviceId,
  DeviceLists,
  OlmMachine,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-nodejs';
// A type, never a value: it is an ambient const enum, and this package builds
// with `verbatimModuleSyntax`, which forbids reading one at runtime.
import type { RequestType } from '@matrix-org/matrix-sdk-crypto-nodejs';

/** What the appservice must do with a request the machine produced. */
export interface CryptoRequest {
  id: string;
  type: RequestType;
  body: string;
  /** `ToDeviceRequest` and `RoomMessageRequest` carry these; others do not. */
  eventType?: string;
  txnId?: string;
  roomId?: string;
}

/**
 * The parts of an appservice transaction one agent's machine cares about.
 *
 * Note the shape: this is **already narrowed to a single agent**. MSC3202
 * delivers one-time-key counts and fallback types keyed by user and then by
 * device, because an appservice holds many users where a client holds one —
 * so the caller picks out this agent's entry before calling. `OlmMachine`
 * itself only ever speaks for one user, and handing it another agent's counts
 * would have it stop replenishing keys and quietly become unreachable.
 */
export interface CryptoTransaction {
  /** MSC2409: to-device events — olm key exchange arrives here. */
  toDevice?: unknown[];
  /** MSC3202: which users' device lists changed. Flat, as in `/sync`. */
  deviceLists?: { changed?: string[]; left?: string[] };
  /** This agent's device's remaining one-time keys, per algorithm. */
  otkCounts?: Record<string, number>;
  /** Algorithms this agent's device has no unused fallback key for. */
  unusedFallbackKeys?: string[];
}

export interface AgentCryptoDeps {
  /** Where each agent's crypto store lives. One directory per user. */
  storeDir: string;
  /**
   * Create this agent's device on the homeserver, before any key is uploaded
   * to it.
   *
   * MSC4190, and not optional: an appservice user registered through
   * `m.login.application_service` gets a server-assigned device id, and
   * uploading keys for a *different* device id — the fixed one below — is
   * refused with a bare `403 M_FORBIDDEN` that says nothing about devices.
   * That is how this was first written, and only an end-to-end run against a
   * real homeserver found it; every unit test passed, because a fake
   * transport answers whatever it is asked.
   *
   * It also needs `io.element.msc4190: true` in the registration, without
   * which the endpoint answers `404 Device management not enabled for
   * appservice`.
   */
  ensureDevice: (userId: string, deviceId: string) => Promise<void>;
  /** This homeserver's name, e.g. `id.agentpod.dev`. */
  domain: string;
  /**
   * Send a request the machine produced. Returns the homeserver's response
   * body, which the machine needs back to complete the exchange.
   *
   * Deliberately injected rather than reaching for `MatrixClient` directly:
   * this module is the only part of the bridge that must be testable without
   * a homeserver, because everything it does is cryptographic and everything
   * that goes wrong with it is silent.
   */
  send: (userId: string, request: CryptoRequest) => Promise<string>;
  /**
   * Publish the agent's cross-signing keys.
   *
   * Separate from `send` because this one request is not a `CryptoRequest`:
   * `bootstrapCrossSigning` hands back a bare JSON body with no request id and
   * no type, and the machine does not want to be told when it has been sent.
   */
  uploadSigningKeys: (userId: string, body: string) => Promise<void>;
}

export interface AgentCrypto {
  /** Feed a transaction to the agent's machine and flush what it produces. */
  receive(userId: string, tx: CryptoTransaction): Promise<void>;
  /**
   * Encrypt content for a room the agent is in.
   *
   * `members` is everyone currently joined, and is not optional: megolm
   * encrypts once and shares the session key with each recipient device, so a
   * member missing from this list simply cannot read the result.
   */
  encrypt(
    userId: string,
    roomId: string,
    members: string[],
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Decrypt an `m.room.encrypted` event, or null when the key is missing. */
  decrypt(
    userId: string,
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  /** Tell the machine which users share a room, so it can target keys. */
  trackUsers(userId: string, members: string[]): Promise<void>;
  /** For tests and shutdown. */
  close(): void;
}

import { EncryptionSettings, RoomId } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../utils/logger';

const log = createLogger('matrix-as:crypto');

/**
 * The device every agent speaks through.
 *
 * Fixed rather than generated, and asserted to the homeserver via MSC4190. A
 * device id that changed per restart would leave a trail of abandoned devices
 * that every other client in the room must still encrypt to, forever.
 */
export const DEVICE_ID = 'AGENTPOD';

export function createAgentCrypto(deps: AgentCryptoDeps): AgentCrypto {
  const machines = new Map<string, Promise<OlmMachine>>();

  /**
   * One machine per agent, built once.
   *
   * The store path is per-user because two agents sharing a store would share
   * an identity, and megolm's whole premise is that they do not. The device
   * id is fixed rather than generated: MSC4190 lets an appservice assert its
   * own device id, and a device id that changed on every restart would leave
   * a trail of abandoned devices that other clients must still encrypt to.
   */
  function machineFor(userId: string): Promise<OlmMachine> {
    let existing = machines.get(userId);
    if (existing) return existing;

    const localpart = userId.slice(1).split(':')[0] ?? userId;
    const built = (async () => {
      const dir = join(deps.storeDir, localpart);
      await mkdir(dir, { recursive: true });
      // Before the machine, not after: the machine's first act is to want its
      // keys uploaded, and there is nothing to upload them to until the
      // device exists.
      await deps.ensureDevice(userId, DEVICE_ID);
      const machine = await OlmMachine.initialize(
        new UserId(userId),
        new DeviceId(DEVICE_ID),
        dir,
      );
      await publishIdentity(userId, machine);
      return machine;
    })();
    machines.set(userId, built);
    return built;
  }

  /**
   * Give the agent a cross-signing identity, and publish it.
   *
   * Not optional, and not a nicety for the verification UI. Room keys are
   * shared under the SDK's default `IdentityBasedStrategy`, which refuses to
   * send a megolm key to a user who has published no identity — the sender
   * emits `m.room_key.withheld` instead, the recipient stores a key it cannot
   * use, and every message from then on decrypts to nothing. There is no error
   * on the sending side at all: the send succeeds, and only the reader can
   * tell that anything is wrong.
   *
   * Done once per agent and then never again, because the store is persistent:
   * a second bootstrap against a server that already holds the identity needs
   * user-interactive auth, which an appservice has no way to satisfy.
   */
  async function publishIdentity(userId: string, machine: OlmMachine): Promise<void> {
    const status = await machine.crossSigningStatus();
    if (status.hasMaster && status.hasSelfSigning && status.hasUserSigning) return;

    const reqs = await machine.bootstrapCrossSigning(false);
    if (reqs.uploadKeysReq) {
      const body = await deps.send(userId, reqs.uploadKeysReq as CryptoRequest);
      await machine.markRequestAsSent(
        (reqs.uploadKeysReq as CryptoRequest).id ?? '',
        0,
        body,
      );
    }
    await deps.uploadSigningKeys(userId, reqs.uploadSigningKeysReq);
    if (reqs.uploadSignaturesReq) {
      const req = reqs.uploadSignaturesReq as unknown as CryptoRequest;
      const body = await deps.send(userId, req);
      await machine.markRequestAsSent(req.id ?? '', 4, body);
    }
  }

  /**
   * Drain the machine's outbox.
   *
   * Loops until empty rather than draining once: sending one request routinely
   * produces the next — a keys/query answers with devices that need a
   * keys/claim, which produces the to-device message that actually shares the
   * key. Draining once would leave the last step undone and the recipient
   * unable to read anything, which fails silently and looks like a homeserver
   * problem.
   */
  async function flush(userId: string, machine: OlmMachine): Promise<void> {
    for (let pass = 0; pass < 10; pass++) {
      const requests = await machine.outgoingRequests();
      if (requests.length === 0) return;
      for (const request of requests) {
        const anyRequest = request as unknown as { id: string; type: RequestType; body: string };
        const response = await deps.send(userId, {
          id: anyRequest.id,
          type: anyRequest.type,
          body: anyRequest.body,
        });
        await machine.markRequestAsSent(anyRequest.id, anyRequest.type, response);
      }
    }
    // Ten passes is not a real limit, it is a stuck-loop guard. Reaching it
    // means a request is being produced faster than it is consumed, which is
    // a bug in here rather than a busy agent.
    throw new Error(`crypto outbox for ${userId} did not settle in 10 passes`);
  }

  return {
    async receive(userId, tx) {
      const machine = await machineFor(userId);
      await machine.receiveSyncChanges(
        JSON.stringify(tx.toDevice ?? []),
        new DeviceLists(
          (tx.deviceLists?.changed ?? []).map((u) => new UserId(u)),
          (tx.deviceLists?.left ?? []).map((u) => new UserId(u)),
        ),
        tx.otkCounts ?? {},
        tx.unusedFallbackKeys ?? [],
      );
      await flush(userId, machine);
    },

    async trackUsers(userId, members) {
      const machine = await machineFor(userId);
      await machine.updateTrackedUsers(members.map((m) => new UserId(m)));
      await flush(userId, machine);
    },

    async encrypt(userId, roomId, members, eventType, content) {
      const machine = await machineFor(userId);
      const room = new RoomId(roomId);
      const recipients = members.map((m) => new UserId(m));

      // The three steps before an event can be encrypted at all, in the only
      // order that works. The first version of this did the first and the
      // third and the machine answered "Session wasn't created nor shared" —
      // which is accurate and says nothing about which step is missing.
      //
      // 1. Know the recipients' devices — and actually go and ask.
      //
      // `updateTrackedUsers` only *marks* them as worth tracking; the
      // keys/query that discovers their devices comes out of the outbox, so
      // without this flush the next two steps run against a machine that has
      // never heard of the recipient. It then shares the room key with
      // nobody, encrypts happily, and the recipient receives an event it has
      // no session for — which looks exactly like a homeserver that dropped
      // the to-device message.
      await machine.updateTrackedUsers(recipients);
      await flush(userId, machine);

      // 2. Have an olm session with each of them, claiming a one-time key
      //    where there is none. Olm is what carries the megolm key in step 3.
      const missing = await machine.getMissingSessions(recipients);
      if (missing) {
        const req = missing as unknown as { id: string; type: RequestType; body: string };
        const response = await deps.send(userId, { id: req.id, type: req.type, body: req.body });
        await machine.markRequestAsSent(req.id, req.type, response);
      }

      // 3. Share the megolm session itself, device by device. The SDK returns
      //    nothing here when every recipient already has it, so this is not a
      //    cost paid per message.
      const shares = await machine.shareRoomKey(room, recipients, new EncryptionSettings());
      for (const share of shares) {
        const req = share as unknown as {
          id: string;
          eventType: string;
          txnId: string;
          body: string;
        };
        const response = await deps.send(userId, {
          id: req.id,
          // `shareRoomKey` returns ToDeviceRequests, which carry no `type`
          // field of their own — the request type is implied by the class.
          type: 3 as unknown as RequestType,
          body: req.body,
          eventType: req.eventType,
          txnId: req.txnId,
        });
        await machine.markRequestAsSent(req.id, 3 as unknown as RequestType, response);
      }

      const encrypted = await machine.encryptRoomEvent(
        room,
        eventType,
        JSON.stringify(content),
      );
      await flush(userId, machine);
      return JSON.parse(encrypted) as Record<string, unknown>;
    },

    async decrypt(userId, roomId, event) {
      const machine = await machineFor(userId);
      try {
        const decrypted = await machine.decryptRoomEvent(
          JSON.stringify(event),
          new RoomId(roomId),
        );
        return JSON.parse(decrypted.event) as Record<string, unknown>;
      } catch (err) {
        // Logged rather than swallowed silently: the message names the actual
        // cause ("withheld code: m.no_olm", "unknown megolm session"), and
        // without it an agent that reads nothing looks identical to an agent
        // nobody is talking to.
        log.debug('could not decrypt an event for an agent', {
          userId,
          reason: err instanceof Error ? err.message : String(err),
        });
        // A missing key is expected rather than exceptional: it happens for
        // every event sent before this agent joined, and for anything sent
        // while it was offline and the sender has since forgotten the session.
        // Null lets the caller render the same "no key" placeholder every
        // Matrix client shows, instead of turning a normal condition into a
        // failed transaction the homeserver will retry forever.
        return null;
      }
    },

    close() {
      machines.clear();
    },
  };
}

export { EncryptionSettings };
export type { RequestType };

/**
 * Narrow a whole-appservice transaction to the agents it actually concerns,
 * and feed each one's machine.
 *
 * This is where MSC3202's nesting earns itself. The homeserver sends one
 * transaction describing *every* user in the namespace; an `OlmMachine`
 * speaks for exactly one. Feeding agent A the counts belonging to agent B
 * does not throw — it makes A believe its key pool is full when it is empty,
 * so it stops replenishing and becomes unreachable without ever reporting a
 * fault. That is the failure this function exists to prevent.
 *
 * Every agent mentioned anywhere in the transaction is fed, including those
 * mentioned only by a device-list change: a machine that is never told its
 * peer rotated a device keeps encrypting to a device that is gone.
 *
 * `toDevice` is passed to each of them whole. The events carry no routing of
 * their own in MSC3202, and olm ignores what is not addressed to it — so
 * handing every agent the full list is correct, if wasteful, where trying to
 * pre-sort it would risk dropping a key someone needed.
 */
export async function feedAgents(
  crypto: AgentCrypto,
  tx: {
    toDevice: unknown[];
    deviceLists: { changed: string[]; left: string[] };
    otkCounts: Record<string, Record<string, Record<string, number>>>;
    unusedFallbackKeys: Record<string, Record<string, string[]>>;
  },
  isOurs: (userId: string) => boolean,
): Promise<void> {
  const agents = new Set<string>();
  for (const user of Object.keys(tx.otkCounts)) if (isOurs(user)) agents.add(user);
  for (const user of Object.keys(tx.unusedFallbackKeys)) if (isOurs(user)) agents.add(user);
  for (const user of tx.deviceLists.changed) if (isOurs(user)) agents.add(user);

  for (const userId of agents) {
    // Flattened per device, then merged: MSC3202 reports counts per device,
    // and this agent has exactly one — `AGENTPOD`, asserted rather than
    // generated. Merging rather than indexing by that name means a device id
    // changing here does not silently stop the counts arriving.
    const otk: Record<string, number> = {};
    for (const perDevice of Object.values(tx.otkCounts[userId] ?? {})) {
      for (const [algorithm, count] of Object.entries(perDevice)) otk[algorithm] = count;
    }
    const fallback = new Set<string>();
    for (const list of Object.values(tx.unusedFallbackKeys[userId] ?? {})) {
      for (const algorithm of list) fallback.add(algorithm);
    }

    await crypto.receive(userId, {
      toDevice: tx.toDevice,
      deviceLists: tx.deviceLists,
      otkCounts: otk,
      unusedFallbackKeys: [...fallback],
    });
  }
}
