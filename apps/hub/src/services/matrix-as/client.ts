/**
 * A Matrix client that acts *as* a station.
 *
 * `?user_id=` is the whole mechanism: an Application Service presents its own
 * `as_token` and names the user it is speaking for. Without it every agent's
 * message arrives from `@ai-bridge`, and a room full of agents becomes one voice
 * pretending to be many — worse than no bridge, because it looks like it works.
 *
 * Verified against a live tuwunel before this was written:
 * `docs/superpowers/specs/2026-08-16-tuwunel-appservice-spike-findings.md`.
 */

import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-client");

export interface MatrixClientDeps {
  homeserverUrl: string;
  /** Authenticates the BRIDGE to the homeserver. Not the hs_token. */
  asToken: string;
  /** This homeserver's name, so a localpart can be addressed as a full mxid. */
  domain?: string;
  fetch?: typeof fetch;
}

/** The two "it was already done" answers, which are successes for us. */
const ALREADY: Record<string, true> = { M_USER_IN_USE: true, M_ROOM_IN_USE: true };

export interface MatrixClient {
  ensureUser(localpart: string, displayName: string): Promise<void>;
  /**
   * Register an identity and keep the credentials it comes back with.
   *
   * Verified against a live tuwunel: an appservice registration returns an
   * `access_token` and `device_id` directly, so handing a harness its own client
   * needs no admin command and no password. Fails if the identity already
   * exists — replacing credentials is a different, privileged act.
   */
  registerWithCredentials(
    localpart: string
  ): Promise<{ userId: string; accessToken: string; deviceId: string }>;
  /**
   * Replace the credentials of an identity that already exists.
   *
   * An Application Service may log in as any user inside its own namespace, so
   * this needs no homeserver admin account — which matters, because the admin
   * credential this service exists to eliminate may not exist at all.
   *
   * Every existing token is invalidated first. Login alone would MINT a device
   * rather than replace one, so repeated rotations would accumulate devices and
   * live tokens on an identity forever, and nothing can delete them afterwards:
   * `DELETE /devices/{id}` requires User-Interactive Auth, which an appservice
   * session has no password to satisfy. `rotate` therefore means replace, and
   * an identity ends every rotation holding exactly one device.
   */
  rotateCredentials(
    localpart: string
  ): Promise<{ userId: string; accessToken: string; deviceId: string }>;
  ensureRoom(
    alias: string,
    opts: {
      creator: string;
      name: string;
      topic: string;
      /** Invited at creation, because `isDirect` rides on the invite's member event. */
      invite?: string;
      /**
       * Make this a DM for the invitee.
       *
       * The server stamps `is_direct` on the invite it sends, and a conformant
       * client files the room under People itself. Deliberately not written into
       * the human's own `m.direct` account data — that needs a human's access
       * token, which is the credential this bridge exists to stop keeping.
       */
      isDirect?: boolean;
    }
  ): Promise<string | null>;
  sendText(userId: string, roomId: string, body: string): Promise<string | null>;
  /**
   * Send a message-like event of any type into a room.
   *
   * The escape hatch `sendText` is a special case of. Used for the suite's own
   * event types (`dev.agentpod.turn.v1`, `dev.agentpod.permission.v1`), which
   * no other Matrix client will render — the answer text still arrives as an
   * ordinary `m.room.message`, so nothing essential is invisible in Element.
   */
  sendCustomEvent(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>
  ): Promise<string | null>;
  sendTyping(userId: string, roomId: string, typing: boolean): Promise<void>;
  /**
   * Send a to-device event as `userId` to every device `targetUserId` has.
   *
   * Never stored in a room. Carries a turn's live text (`live.ts`) so the
   * stream and the durable record stay separate channels.
   */
  sendToDevice(
    userId: string,
    targetUserId: string,
    eventType: string,
    content: Record<string, unknown>
  ): Promise<void>;
  setDisplayName(userId: string, displayName: string): Promise<void>;
  invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
  /**
   * Join a room as a virtual user.
   *
   * **An invite is still required for an invite-only room.** This used to say
   * the AS owning the whole `@agent_.*` namespace meant a join needed no
   * invite, and that is false: namespace ownership lets the appservice *act
   * as* a user, it does not exempt that user from a room's join rules. Every
   * room `ensureRoom` creates is `preset: "private_chat"`, and a bare join is
   * refused `403 M_FORBIDDEN — cannot join a room that is not 'public'`
   * (agentpod#397, reproduced against a real tuwunel). `identity-move.ts`
   * invites as the old member first, which is what makes its join land.
   *
   * Idempotent by the ordinary meaning of the Matrix endpoint: joining a room
   * you are already in succeeds rather than erroring, which is what makes it
   * safe for the migration to call unconditionally on a re-run.
   */
  join(userId: string, roomId: string): Promise<void>;
  /**
   * Leave a room as a virtual user.
   *
   * Must be safe to call on a user who is not currently a member — a run that
   * crashed after a previous leave, and is simply run again, must not throw
   * over a departure that already happened.
   */
  leave(userId: string, roomId: string): Promise<void>;
  /**
   * Whether `userId` is currently a member of `roomId`.
   *
   * The migration's way of asking "which of this room's steps are already
   * done" — live membership, not a database flag nothing writes yet
   * (`matrix_rooms.principal_id` is reserved ahead of its first writer).
   *
   * **Throws when the homeserver did not answer.** Only a 200 and a clean 404
   * produce a boolean; see the implementation for why "could not ask" must not
   * collapse into "already left".
   */
  isJoined(userId: string, roomId: string): Promise<boolean>;
  /**
   * Retire an identity: revoke every credential it holds, then ask the
   * homeserver to deactivate the account itself.
   *
   * **Two halves, because only one of them works on this homeserver.**
   * `logout/all` as the user is accepted (the same call `rotateCredentials`
   * already relies on), and it is the half that matters operationally — §5 of
   * the uniform-identity design asks that "an unused credential on a node
   * stops being a live login", and after this the token in a harness's
   * profile is dead.
   *
   * `POST /account/deactivate` is then attempted and, on tuwunel today, is
   * refused: probed against 1.9.0 on 2026-09-01, masquerading answers `401
   * M_MISSING_TOKEN`, and with an appservice-minted user token it answers a
   * User-Interactive Auth challenge whose `flows` list is EMPTY — a challenge
   * with no satisfiable flow. tuwunel implements no Synapse admin API either
   * (`/_synapse/admin/v1/deactivate` → 403). So the account row survives,
   * holding no usable credential, and this returns that fact rather than
   * claiming a deactivation it did not get. Neither half throws: retirement
   * runs after the room has already moved, and a station that is working must
   * not be broken by the cleanup behind it.
   */
  deactivateUser(
    userId: string
  ): Promise<{ credentialsRevoked: boolean; accountDeactivated: boolean }>;
  /** A user's account data of the given type, or null when it was never set. */
  getAccountData(userId: string, type: string): Promise<Record<string, unknown> | null>;
  /**
   * Replace a user's account data of the given type outright.
   *
   * Not a merge: `m.direct` is a map covering every DM the owner has, and a
   * caller that must preserve the entries it did not come to change — which is
   * every caller of this for `m.direct` — reads first with `getAccountData`
   * and writes back the whole object. Blindly writing one entry here is the
   * single most destructive thing available to a caller of this client.
   */
  setAccountData(userId: string, type: string, content: Record<string, unknown>): Promise<void>;
  /** Mark another event — 👀 while working, ✅ done, ❌ failed. */
  sendReaction(
    userId: string,
    roomId: string,
    targetEventId: string,
    key: string
  ): Promise<string | null>;
  /** Remove an event we sent, which is how a reaction is taken back off. */
  redact(userId: string, roomId: string, eventId: string): Promise<void>;
  /**
   * Create a space — a room whose type groups other rooms.
   *
   * Deliberately **without an alias**: a space is a container, not a
   * destination, and nobody types its address. An alias is global to the
   * homeserver, so one derived from an everyday word — "personal" — would have
   * one tenant's space swallow another's.
   */
  createSpace(opts: { creator: string; name: string }): Promise<string | null>;
  /** Hang a room under a space, which is what makes a hierarchy. */
  addSpaceChild(creator: string, spaceRoomId: string, childRoomId: string): Promise<void>;
  /**
   * Take a room back out of a space. An `m.space.child` with no `via` is how
   * Matrix spells "no longer a child" — the state event cannot be deleted, only
   * emptied, and a client reading a `via`-less edge skips it.
   */
  removeSpaceChild(creator: string, spaceRoomId: string, childRoomId: string): Promise<void>;
  /** Set a user's avatar. Optional for an agent; uniform across harnesses. */
  setAvatar(userId: string, mxcUrl: string): Promise<void>;
  /**
   * What the identity's avatar is now, or null when it has none.
   *
   * The homeserver is asked rather than a local flag consulted, so an avatar
   * that was never uploaded is retried and one that exists is left alone.
   */
  getAvatar(userId: string): Promise<string | null>;
  /** Upload an image and return its mxc:// URL. */
  uploadImage(userId: string, bytes: Uint8Array, contentType: string): Promise<string | null>;
}

/**
 * A registration refused because the identity already exists.
 *
 * Typed rather than a string match, for the same reason `GrantReachDenied` is:
 * the caller has to *decide* what to do about it, and deciding on a substring of
 * an error message is how that breaks silently later.
 */
export class MatrixUserInUse extends Error {
  readonly errcode = "M_USER_IN_USE";
  constructor(localpart: string) {
    super(`matrix register ${localpart} refused: the identity already exists`);
    this.name = "MatrixUserInUse";
  }
}

export const isMatrixUserInUse = (e: unknown): e is MatrixUserInUse =>
  e instanceof MatrixUserInUse;

/**
 * The appservice tried to act as a user outside its own exclusive namespace.
 *
 * Confirmed live against tuwunel on 2026-08-30: `GET account_data` as the
 * human operator answers `400 M_EXCLUSIVE — User is not in namespace.` This
 * is permanent, not transient — the AS's exclusive namespace is `@agent_.*`,
 * the operator's own mxid is outside it, and no retry changes that. Typed,
 * like `MatrixUserInUse`, so a caller (the mxid migration's report, in
 * particular) can tell this apart from a real, retriable failure without
 * matching an error message.
 */
export class MatrixExclusiveNamespace extends Error {
  readonly errcode = "M_EXCLUSIVE";
  constructor(what: string, userId: string) {
    super(`matrix ${what} refused: ${userId} is outside the appservice's exclusive namespace`);
    this.name = "MatrixExclusiveNamespace";
  }
}

export const isMatrixExclusiveNamespace = (e: unknown): e is MatrixExclusiveNamespace =>
  e instanceof MatrixExclusiveNamespace;

export function createMatrixClient(deps: MatrixClientDeps): MatrixClient {
  const doFetch = deps.fetch ?? fetch;

  /** `?user_id=` on every call — the difference between the agent and the bridge. */
  const asUser = (path: string, userId?: string): string => {
    const url = `${deps.homeserverUrl}${path}`;
    if (!userId) return url;
    return `${url}${url.includes("?") ? "&" : "?"}user_id=${encodeURIComponent(userId)}`;
  };

  async function call(
    path: string,
    init: { method: string; body?: unknown; userId?: string }
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await doFetch(asUser(path, init.userId), {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deps.asToken}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // A body-less 200 is ordinary for some of these.
    }
    return { status: res.status, body };
  }

  /** Throw unless the failure is one of the "already done" answers. */
  function assertOkOrAlready(
    what: string,
    res: { status: number; body: Record<string, unknown> }
  ): boolean {
    if (res.status >= 200 && res.status < 300) return true;

    const errcode = String(res.body.errcode ?? "");
    if (ALREADY[errcode]) {
      log.info("matrix: already done", { what, errcode });
      return false;
    }

    throw new Error(
      `matrix ${what} failed: ${res.status} ${errcode} ${String(res.body.error ?? "")}`.trim()
    );
  }

  /** The room an alias points at, or null when nothing does. */
  async function resolveAlias(alias: string): Promise<string | null> {
    const res = await call(
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { method: "GET" }
    );
    if (res.status !== 200) return null;
    return String(res.body.room_id ?? "") || null;
  }

  /**
   * Whether `userId` is still in `roomId`.
   *
   * **Anything that is not a 200 or a clean 404 throws.** This used to answer
   * `false` for every non-200, which quietly conflated "the homeserver says
   * no" with "the homeserver did not say" — and this is the idempotency check
   * on the only irreversible step in the mxid migration. A transient 502 read
   * as `false` tells the migration both that the new user never joined and
   * that the old one has already left: it re-joins an identity that is already
   * in the room, skips the leave it still owes, and reports the room finished
   * with two agents sitting in it. A failure to answer must stop the run and
   * be retried, which is what a re-run is for; the same failure swallowed
   * strands the room with nothing left looking at it.
   *
   * A 404 is the one non-200 that IS an answer: the homeserver knows nothing
   * of this user, so it is in no rooms, so it is not in this one.
   */
  async function isJoined(userId: string, roomId: string): Promise<boolean> {
    const res = await call("/_matrix/client/v3/joined_rooms", { method: "GET", userId });
    if (res.status === 404) return false;
    if (res.status !== 200) {
      throw new Error(
        `matrix joined_rooms ${userId} failed: ${res.status} ${String(
          res.body.errcode ?? ""
        )} ${String(res.body.error ?? "")}`.trim()
      );
    }
    const rooms = Array.isArray(res.body.joined_rooms) ? res.body.joined_rooms : [];
    return rooms.some((r) => r === roomId);
  }

  return {
    async ensureUser(localpart, displayName) {
      const res = await call("/_matrix/client/v3/register", {
        method: "POST",
        body: { type: "m.login.application_service", username: localpart },
      });
      assertOkOrAlready(`register ${localpart}`, res);

      // Set the display name EVERY time, not only on creation. The user is
      // created exactly once and provisioning runs forever, so a name set only
      // at creation means a renamed station keeps introducing itself by its old
      // name — and the display name is what carries the readability a derived
      // mxid does not have.
      //
      // The register reply has no `user_id` when the user already existed, so
      // the mxid is composed rather than read back.
      const userId =
        String(res.body.user_id ?? "") ||
        (deps.domain ? `@${localpart}:${deps.domain}` : "");
      if (userId) await this.setDisplayName(userId, displayName);
    },

    async registerWithCredentials(localpart) {
      const res = await call("/_matrix/client/v3/register", {
        method: "POST",
        body: { type: "m.login.application_service", username: localpart },
      });

      // Deliberately NOT treating M_USER_IN_USE as success here. Everywhere else
      // "already done" is what idempotency means; here it means the caller asked
      // for credentials to an identity that already has some, and answering with
      // nothing would leave a harness holding no token while believing it does.
      if (res.status < 200 || res.status >= 300) {
        // Distinguished from every other failure because it is the one the
        // caller can act on: the identity exists, so rotate it instead.
        if (String(res.body.errcode ?? "") === "M_USER_IN_USE") {
          throw new MatrixUserInUse(localpart);
        }
        throw new Error(
          `matrix register ${localpart} failed: ${res.status} ${String(res.body.errcode ?? "")}`.trim()
        );
      }

      const accessToken = String(res.body.access_token ?? "");
      if (!accessToken) {
        throw new Error(
          `matrix register ${localpart} returned no access_token — this homeserver ` +
            "does not issue appservice credentials this way"
        );
      }

      return {
        userId: String(res.body.user_id ?? `@${localpart}:${deps.domain ?? ""}`),
        accessToken,
        deviceId: String(res.body.device_id ?? ""),
      };
    },

    async rotateCredentials(localpart) {
      const userId = `@${localpart}:${deps.domain ?? ""}`;

      // Impersonated, so no admin account is involved: an appservice may act as
      // any user in its namespace. Verified against tuwunel 1.8.3.
      const out = await call("/_matrix/client/v3/logout/all", {
        method: "POST",
        body: {},
        userId,
      });
      if (out.status < 200 || out.status >= 300) {
        throw new Error(
          `matrix logout/all ${localpart} failed: ${out.status} ${String(out.body.errcode ?? "")}`.trim()
        );
      }

      // Not impersonated — the login body names the user, and passing
      // `?user_id=` as well is rejected.
      const res = await call("/_matrix/client/v3/login", {
        method: "POST",
        body: {
          type: "m.login.application_service",
          identifier: { type: "m.id.user", user: localpart },
        },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(
          `matrix login ${localpart} failed: ${res.status} ${String(res.body.errcode ?? "")}`.trim()
        );
      }

      const accessToken = String(res.body.access_token ?? "");
      if (!accessToken) {
        throw new Error(
          `matrix login ${localpart} returned no access_token — this homeserver ` +
            "does not issue appservice credentials this way"
        );
      }

      return {
        userId: String(res.body.user_id ?? userId),
        accessToken,
        deviceId: String(res.body.device_id ?? ""),
      };
    },

    async ensureRoom(alias, opts) {
      // The localpart only — the homeserver adds its own domain, and sending the
      // full alias produces `#…:domain:domain`.
      const aliasLocalpart = alias.replace(/^#/, "").replace(/:.*$/, "");

      const res = await call("/_matrix/client/v3/createRoom", {
        method: "POST",
        userId: opts.creator,
        body: {
          room_alias_name: aliasLocalpart,
          name: opts.name,
          topic: opts.topic,
          preset: "private_chat",
          ...(opts.invite ? { invite: [opts.invite] } : {}),
          ...(opts.isDirect ? { is_direct: true } : {}),
        },
      });

      if (assertOkOrAlready(`createRoom ${alias}`, res)) {
        return String(res.body.room_id ?? "") || null;
      }

      // M_ROOM_IN_USE. The alias is taken, and by what decides everything:
      //
      //  - by a room this agent is still in — the ordinary restart. That room
      //    IS the answer, so resolve the alias and hand it back. Returning null
      //    here (what shipped) made provisioning create nothing and report
      //    success.
      //  - by a room it has left — an emptied room after a clean slate. The
      //    alias outlives the room's usefulness and nothing else will ever
      //    release it, so take it back and try once more.
      const existing = await resolveAlias(alias);
      if (!existing) return null;

      // Left to throw on a homeserver that could not answer, and deliberately.
      // The branch below this line DELETES the alias directory entry, so a
      // swallowed 502 answering "not joined" would release the alias of a room
      // this agent is still living in. `provisionAll` counts a thrown station
      // as a failure and the next boot retries it; a released alias is not
      // retried, it is gone.
      if (await isJoined(opts.creator, existing)) return existing;

      log.info("reclaiming an alias from a room this agent has left", {
        alias,
        roomId: existing,
      });
      const dropped = await call(
        `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
        { method: "DELETE", userId: opts.creator }
      );
      if (dropped.status < 200 || dropped.status >= 300) {
        log.warn("could not release a stale alias; the room cannot be recreated", {
          alias,
          status: dropped.status,
        });
        return null;
      }

      const retry = await call("/_matrix/client/v3/createRoom", {
        method: "POST",
        userId: opts.creator,
        body: {
          room_alias_name: aliasLocalpart,
          name: opts.name,
          topic: opts.topic,
          preset: "private_chat",
          ...(opts.invite ? { invite: [opts.invite] } : {}),
          ...(opts.isDirect ? { is_direct: true } : {}),
        },
      });
      if (!assertOkOrAlready(`createRoom ${alias} (after reclaiming its alias)`, retry)) {
        return null;
      }
      return String(retry.body.room_id ?? "") || null;
    },

    async sendText(userId, roomId, body) {
      // A fresh transaction id per send: the homeserver deduplicates on it, so
      // reusing one would silently drop a genuinely new message.
      const txn = `apb-${crypto.randomUUID()}`;
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
        { method: "PUT", userId, body: { msgtype: "m.text", body } }
      );
      assertOkOrAlready("send", res);
      return String(res.body.event_id ?? "") || null;
    },

    async sendCustomEvent(userId, roomId, eventType, content) {
      // A fresh transaction id per send, exactly as `sendText`: the homeserver
      // deduplicates on it, so reusing one would silently drop a genuinely new
      // event.
      const txn = `apb-${crypto.randomUUID()}`;
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${txn}`,
        { method: "PUT", userId, body: content }
      );
      assertOkOrAlready("sendCustomEvent", res);
      return String(res.body.event_id ?? "") || null;
    },

    async sendToDevice(userId, targetUserId, eventType, content) {
      // Delivered to the target's devices and never stored in a room — see
      // `live.ts` for why a turn's live text goes here rather than into the
      // timeline as edits.
      //
      // `*` is every device the reader has. A device that is asleep simply
      // misses the stream and gets the real message when it wakes, which is
      // correct rather than a gap: nothing here is the source of truth.
      const res = await call(
        `/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${crypto.randomUUID()}`,
        {
          method: "PUT",
          userId,
          body: { messages: { [targetUserId]: { "*": content } } },
        }
      );
      assertOkOrAlready("sendToDevice", res);
    },

    async sendTyping(userId, roomId, typing) {
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          userId,
          // A stop carries no timeout: it is an end, not a duration.
          body: typing ? { typing: true, timeout: 30_000 } : { typing: false },
        }
      );
      assertOkOrAlready("typing", res);
    },

    async setDisplayName(userId, displayName) {
      const res = await call(
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
        { method: "PUT", userId, body: { displayname: displayName } }
      );
      assertOkOrAlready("displayname", res);
    },

    async createSpace(opts) {
      const res = await call("/_matrix/client/v3/createRoom", {
        method: "POST",
        userId: opts.creator,
        body: {
          name: opts.name,
          preset: "private_chat",
          creation_content: { type: "m.space" },
        },
      });
      if (!assertOkOrAlready(`createSpace ${opts.name}`, res)) return null;
      return String(res.body.room_id ?? "") || null;
    },

    async addSpaceChild(creator, spaceRoomId, childRoomId) {
      // The child event lives on the SPACE, which is what makes a space's claim
      // about its children authoritative — a room claiming a parent is not.
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/state/m.space.child/${encodeURIComponent(childRoomId)}`,
        {
          method: "PUT",
          userId: creator,
          body: { via: [deps.domain ?? ""] },
        }
      );
      assertOkOrAlready("space child", res);
    },

    async removeSpaceChild(creator, spaceRoomId, childRoomId) {
      // Empty content, not a delete: Matrix has no way to remove a state event,
      // and an `m.space.child` without `via` is the spelling every client reads
      // as "not a child any more".
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(spaceRoomId)}/state/m.space.child/${encodeURIComponent(childRoomId)}`,
        { method: "PUT", userId: creator, body: {} }
      );
      assertOkOrAlready("space child removal", res);
    },

    async sendReaction(userId, roomId, targetEventId, key) {
      const txn = `apr-${crypto.randomUUID()}`;
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txn}`,
        {
          method: "PUT",
          userId,
          body: {
            "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key },
          },
        }
      );
      assertOkOrAlready("reaction", res);
      return String(res.body.event_id ?? "") || null;
    },

    async redact(userId, roomId, eventId) {
      const txn = `apx-${crypto.randomUUID()}`;
      const res = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${txn}`,
        { method: "PUT", userId, body: {} }
      );
      assertOkOrAlready("redact", res);
    },

    async uploadImage(userId, bytes, contentType) {
      // Media upload is not JSON, so it bypasses `call`.
      const url = `${deps.homeserverUrl}/_matrix/media/v3/upload?user_id=${encodeURIComponent(userId)}`;
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": contentType, Authorization: `Bearer ${deps.asToken}` },
        // Cast through unknown: this is the one call that sends bytes rather
        // than JSON, and the DOM's BodyInit is not in this project's lib set.
        body: bytes as unknown as never,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { content_uri?: string };
      return body.content_uri ?? null;
    },

    async getAvatar(userId) {
      const res = await call(
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/avatar_url`,
        { method: "GET", userId }
      );
      // A profile with no avatar answers 404 M_NOT_FOUND on some homeservers and
      // an empty body on others; both mean the same thing and neither is an
      // error worth throwing over.
      if (res.status === 404) return null;
      const url = res.body.avatar_url;
      return typeof url === "string" && url !== "" ? url : null;
    },

    async setAvatar(userId, mxcUrl) {
      const res = await call(
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/avatar_url`,
        { method: "PUT", userId, body: { avatar_url: mxcUrl } }
      );
      assertOkOrAlready("avatar", res);
    },

    async invite(asUserId, roomId, invitee) {
      const res = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
        method: "POST",
        userId: asUserId,
        body: { user_id: invitee },
      });
      assertOkOrAlready("invite", res);
    },

    async join(userId, roomId) {
      const res = await call(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
        method: "POST",
        userId,
        body: {},
      });
      assertOkOrAlready("join", res);
    },

    async leave(userId, roomId) {
      const res = await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
        method: "POST",
        userId,
        body: {},
      });
      assertOkOrAlready("leave", res);
    },

    isJoined,

    async deactivateUser(userId) {
      // Impersonated, exactly as `rotateCredentials` does it: an appservice may
      // act as any user in its own namespace, so no admin account is involved.
      const out = await call("/_matrix/client/v3/logout/all", {
        method: "POST",
        body: {},
        userId,
      });
      const credentialsRevoked = out.status >= 200 && out.status < 300;
      if (!credentialsRevoked) {
        log.warn("could not revoke a retired identity's credentials", {
          userId,
          status: out.status,
          errcode: String(out.body.errcode ?? ""),
        });
      }

      const gone = await call("/_matrix/client/v3/account/deactivate", {
        method: "POST",
        body: { erase: false },
        userId,
      });
      const accountDeactivated = gone.status >= 200 && gone.status < 300;
      if (!accountDeactivated) {
        // Expected on tuwunel — see this method's doc comment. Info, not warn:
        // a refusal that is structural gets reported once as a fact, not
        // raised as an alarm on every retirement forever, which is the lesson
        // `migrate-agent-mxids-run.ts` recorded about `M_EXCLUSIVE`.
        log.info("this homeserver does not let the appservice deactivate an account", {
          userId,
          status: gone.status,
          errcode: String(gone.body.errcode ?? ""),
        });
      }

      return { credentialsRevoked, accountDeactivated };
    },

    async getAccountData(userId, type) {
      const res = await call(
        `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
        { method: "GET", userId }
      );
      // No account data of this type yet — the map this migration reads and
      // rewrites simply starts empty, same as a profile with no avatar.
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) {
        const errcode = String(res.body.errcode ?? "");
        if (errcode === "M_EXCLUSIVE") {
          throw new MatrixExclusiveNamespace(`account_data GET ${type}`, userId);
        }
        throw new Error(
          `matrix account_data GET ${type} failed: ${res.status} ${errcode}`.trim()
        );
      }
      return res.body;
    },

    async setAccountData(userId, type, content) {
      const res = await call(
        `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(type)}`,
        { method: "PUT", userId, body: content }
      );
      assertOkOrAlready("account_data", res);
    },
  };
}
