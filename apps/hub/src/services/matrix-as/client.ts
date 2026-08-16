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
  ensureRoom(
    alias: string,
    opts: { creator: string; name: string; topic: string }
  ): Promise<string | null>;
  sendText(userId: string, roomId: string, body: string): Promise<string | null>;
  sendTyping(userId: string, roomId: string, typing: boolean): Promise<void>;
  setDisplayName(userId: string, displayName: string): Promise<void>;
  invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
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
