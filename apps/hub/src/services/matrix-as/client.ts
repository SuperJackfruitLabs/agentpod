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
  sendTyping(userId: string, roomId: string, typing: boolean): Promise<void>;
  setDisplayName(userId: string, displayName: string): Promise<void>;
  invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
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

      if (!assertOkOrAlready(`createRoom ${alias}`, res)) return null;
      return String(res.body.room_id ?? "") || null;
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
  };
}
