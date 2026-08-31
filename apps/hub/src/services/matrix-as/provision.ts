/**
 * Giving every station a Matrix identity and somewhere to be talked to.
 *
 * Runs when a station is adopted and again at boot, so it has to be idempotent
 * in the way that matters: not "does not crash on a second run", but "a second
 * run changes nothing an operator would notice".
 *
 * What it will not do is register over a station that answers for itself. A
 * `harness`-mode station has its own account and its own client; minting a
 * second identity for it would produce two answerers on one address, which is
 * the failure the mode exists to prevent.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { nodes } from "../../db/schema/nodes";
import { matrixRooms } from "../../db/schema/matrix";
import { principalIdentities } from "../../db/schema/identities";
import { bridgeLocalpart, roomAliasFor, stationSpeaker } from "./names";
import { ensureNodeSpace, fileRoomUnderSpace } from "./spaces";
import { pickAvatar } from "./avatar";
import { principalHandle, principalForUser } from "../principals";
import { roomForStation } from "./station-room";
import { stationForAlias } from "./stations";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-provision");

export interface ProvisionDeps {
  domain: string;
  client: {
    ensureUser(localpart: string, displayName: string): Promise<void>;
    ensureRoom(
      alias: string,
      opts: {
        creator: string;
        name: string;
        topic: string;
        invite?: string;
        isDirect?: boolean;
      }
    ): Promise<string | null>;
    invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
    /** Spaces — see `purpose-spaces.ts`. Absent in tests that assert on rooms only. */
    createSpace?(opts: { creator: string; name: string }): Promise<string | null>;
    addSpaceChild?(creator: string, spaceRoomId: string, childRoomId: string): Promise<void>;
    removeSpaceChild?(
      creator: string,
      spaceRoomId: string,
      childRoomId: string
    ): Promise<void>;
    uploadImage?(
      userId: string,
      bytes: Uint8Array,
      contentType: string
    ): Promise<string | null>;
    setAvatar?(userId: string, mxcUrl: string): Promise<void>;
    /** The identity's current avatar, or null. Absent in tests that don't care. */
    getAvatar?(userId: string): Promise<string | null>;
  };
  /**
   * Read a file from the station's workspace, or null when it is not there.
   *
   * Absent in deployments that cannot reach the node — an agent's face is never
   * worth failing provisioning over.
   */
  readWorkspaceFile?(
    stationId: string,
    path: string
  ): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/**
 * The station, its node's name, and whether its CURRENT occupant already
 * has a room.
 *
 * `roomId`/`spaceRoomId` come from `station-room.ts`, not from a bare
 * `leftJoin(matrixRooms, eq(matrixRooms.stationId, stations.id))` — that
 * join, with no `ORDER BY` and `[row]` picked off whatever Postgres
 * happened to return, was a fix-round review's finding: it could answer
 * with a DEPARTED occupant's room, which made this function believe a new
 * occupant already had one and skip creating it. A new occupant with no
 * room of its own must see `roomId: null` here, or it never gets one.
 */
async function context(stationId: string) {
  const [row] = await db
    .select({
      stationId: stations.id,
      tenantId: stations.tenantId,
      userId: stations.userId,
      stationKey: stations.stationKey,
      harness: stations.harness,
      displayName: stations.displayName,
      identityMode: stations.matrixIdentityMode,
      harnessMxid: stations.matrixId,
      purpose: stations.purpose,
      principalId: stations.principalId,
      nodeName: nodes.name,
    })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(eq(stations.id, stationId));
  if (!row) return null;

  const occupancy = await roomForStation(stationId);
  return {
    ...row,
    roomId: occupancy.room?.roomId ?? null,
    spaceRoomId: occupancy.room?.spaceRoomId ?? null,
  };
}

/**
 * The owner's Matrix id, so the room is not a locked door.
 *
 * Two lookups rather than one, and for the same reason `readerForRoom` in
 * `index.ts` does it this way: `stations.userId` is a Better Auth id and
 * `principal_identities.principal_id` holds `prn_…` values now, so handing
 * this a user id and querying that column directly answers null for every
 * station in the fleet. It did — the parameter was already named
 * `principalId` while both call sites passed `s.userId`, and the only visible
 * symptom was that `ensureRoom` quietly dropped `invite` and `isDirect`, so
 * every room this created at boot was a room nobody was in but the agent.
 *
 * `null` — an owner with no principal, or a principal with no Matrix identity
 * mapped — is an ordinary answer: the room is still made, so the agent has
 * somewhere to be, and somebody can be invited later.
 */
async function ownerMxid(userId: string): Promise<string | null> {
  const principal = await principalForUser(userId);
  if (!principal) return null;

  const [row] = await db
    .select({ externalId: principalIdentities.externalId })
    .from(principalIdentities)
    .where(
      and(
        eq(principalIdentities.principalId, principal.id),
        eq(principalIdentities.system, "matrix")
      )
    );
  return row?.externalId ?? null;
}

export async function provisionStation(stationId: string, deps: ProvisionDeps): Promise<void> {
  const s = await context(stationId);
  if (!s) return;

  const bridged = s.identityMode === "bridge";

  // Whoever answers in this room is who creates it. For a bridge-mode station
  // that is the identity minted for its occupying agent; for a harness-mode
  // one it is the account the harness already holds. Either way, if there is
  // nobody to answer as, there is nobody to create the room as — inventing an
  // identity from `(nodeName, stationKey)` would be exactly the
  // station-derived address this suite moved away from.
  // Resolved unconditionally, in both modes. Harness mode's SPEAKER is the
  // harness's own fixed identity, unchanged by who occupies the station —
  // but the ROOM'S ALIAS still has to follow the occupant (below), or a
  // harness station whose occupant changes collides on the exact alias its
  // predecessor's room still holds.
  const handle: string | null = s.principalId ? await principalHandle(s.principalId) : null;

  // `names.ts`'s `stationSpeaker` is the one place this choice is made now —
  // `gates.ts` was making it a second time and getting harness mode wrong,
  // posting as an `@agent_…` nothing had registered. Two independently
  // maintained answers to one question is how every other divergence in this
  // task started.
  const speaker = stationSpeaker(
    { identityMode: s.identityMode, harnessMxid: s.harnessMxid, handle },
    deps.domain
  );
  if (!speaker) {
    log.warn(
      bridged
        ? "station has no occupying agent, so it has no handle to provision a Matrix identity for"
        : "station answers for itself but has no Matrix identity; nothing to provision",
      { stationId, stationKey: s.stationKey }
    );
    return;
  }

  // A name a person can read. The mxid is derived and unlovely; this is what a
  // member list shows, and it is set on every run so a rename lands.
  const displayName = `${s.displayName} (${s.harness} @ ${s.nodeName})`;

  if (bridged) {
    await deps.client.ensureUser(bridgeLocalpart(handle!), displayName);
  }

  // An agent's face, if it has one.
  //
  // Gated on the identity NOT ALREADY HAVING ONE, asked of the homeserver,
  // rather than on this being the station's first provision. The first-provision
  // gate shipped in #359 and gave 0 of 32 agents a face: every room already
  // existed by the time that code deployed, so the read never ran for a single
  // one of them, and nothing short of deleting a room could make it run. Asking
  // costs one profile GET per station per boot and makes this self-healing — an
  // agent that gains a `pfp.png` next month gets its face at the next restart,
  // and one that already has a face is never re-read or re-uploaded.
  const hasFace = deps.client.getAvatar
    ? await deps.client.getAvatar(speaker).catch(() => null)
    : s.roomId; // no way to ask: fall back to "only on first provision"
  if (bridged && !hasFace && deps.readWorkspaceFile && deps.client.uploadImage) {
    const found = await pickAvatar({
      read: (path) => deps.readWorkspaceFile!(s.stationId, path),
      // Most coding-harness stations will never have a workspace picture —
      // `avatar.png` in a project repo is a file you would have to commit — so
      // without a drawn fallback they stay letters forever.
      harness: s.harness,
      stationKey: s.stationKey,
    }).catch(() => null);

    if (found) {
      const mxc = await deps.client
        .uploadImage(speaker, found.bytes, found.contentType)
        .catch(() => null);
      if (mxc && deps.client.setAvatar) {
        await deps.client.setAvatar(speaker, mxc).catch(() => {});
        log.info("gave an agent its face", { stationId, path: found.path });
      }
    }
  }

  // The room is created once. A second one for the same station would split its
  // conversation in two, with each half unaware of the other.
  if (!s.roomId) {
    // Occupant-derived when there is one — fix round 3: the station-keyed
    // form is what let a new occupant's room silently collide with its
    // predecessor's, since two different occupants of the same station
    // used to produce the identical alias. That choice now lives in
    // `names.ts`'s `roomAliasFor` rather than inline here, because fix
    // round 5 found `routes/station-matrix.ts` making the same choice
    // separately and getting it wrong.
    const alias = roomAliasFor(
      { handle, nodeName: s.nodeName, stationKey: s.stationKey },
      deps.domain
    );

    // The owner is invited AT creation rather than afterwards, because the flag
    // that makes this a DM rides on the invite's own member event and can only
    // be set there.
    //
    // A one-to-one agent room is a conversation with one correspondent, so it
    // belongs under People — 32 agents in a Rooms list is a wall. Rooms where
    // several agents work together are ordinary rooms, and are what spaces will
    // group.
    const invitee = await ownerMxid(s.userId);

    const roomId = await deps.client.ensureRoom(alias, {
      creator: speaker,
      name: s.displayName,
      topic: `${s.harness} on ${s.nodeName} — ${s.stationKey}`,
      ...(invitee ? { invite: invitee, isDirect: true } : {}),
    });

    if (!roomId) {
      // Thrown, not logged and stepped over: `provisionAll` counts failures,
      // and a station left with no room is exactly what that count is for.
      // Swallowing it is how a rebuild reported "provisioned 32, failed 0"
      // while creating nothing at all.
      throw new Error(
        `could not create a room for ${s.stationKey} at ${alias} — the homeserver refused, or its alias is held by a room this agent cannot reclaim`
      );
    }

    await db
      .insert(matrixRooms)
      .values({
        roomId,
        tenantId: s.tenantId,
        stationId: s.stationId,
        alias,
        // Bound to this occupant at creation — the room this function just
        // made exists FOR whoever `s.principalId` names (null for a
        // harness-mode or not-yet-occupied station, same as ever). Without
        // this, a freshly created room sat unbound until some later assign
        // call happened to find it, and `agents-admin.ts`'s bind-on-assign
        // already ran BEFORE this room existed for a station occupied via
        // the admin route first — it would never bind on its own.
        principalId: s.principalId,
      })
      .onConflictDoNothing();
  }

  if (bridged) {
    await db
      .update(stations)
      .set({ bridgeMatrixId: speaker })
      .where(eq(stations.id, s.stationId));
  }

  await fileByNode(s, speaker, deps);
}

/**
 * Hang the station's room under its node's space.
 *
 * Runs on every provision, which is what makes a move take effect: an agent
 * that turns up on a different machine is re-filed the next time its station is
 * announced. Skipped entirely when the deployment's client cannot do spaces —
 * a test client asserting on rooms, mainly — because an agent you can talk to
 * matters more than where it is filed.
 */
async function fileByNode(
  s: NonNullable<Awaited<ReturnType<typeof context>>>,
  speaker: string,
  deps: ProvisionDeps
): Promise<void> {
  const { createSpace, addSpaceChild, removeSpaceChild } = deps.client;
  if (!createSpace || !addSpaceChild || !removeSpaceChild) return;

  // Re-resolve: the room may have been created moments ago, above, and
  // `station-room.ts` is what makes this the CURRENT occupant's own room —
  // a departed occupant's room, still sitting at this `station_id`, must
  // never be re-filed under a space as if it belonged to whoever occupies
  // the station now.
  const occupancy = await roomForStation(s.stationId);
  if (!occupancy.room) return;
  const room = occupancy.room;

  const spaceDeps = {
    client: { createSpace, addSpaceChild, removeSpaceChild, invite: deps.client.invite },
  };

  // Every station has a node, so every station has a space — no labelling step
  // stands between a new agent and a sensible place in the roster. A space that
  // could not be made leaves the room in All rooms rather than under an
  // invented `Unsorted`.
  const desired = await ensureNodeSpace(
    s.tenantId,
    s.nodeName,
    speaker,
    await ownerMxid(s.userId),
    spaceDeps
  );

  await fileRoomUnderSpace(room.roomId, desired, room.spaceRoomId, spaceDeps);
}

/**
 * Provision the station behind a room alias the homeserver asked about.
 *
 * The homeserver asks when somebody tried to resolve the alias. Answering
 * yes without creating the room would send them somewhere that is not
 * there — so the route's 200 and this call have to agree about which
 * aliases are ours, which is why both go through `stationForAlias` and
 * neither carries a shape list of its own. Fix round 4: they did not agree,
 * and the route's narrower gate made this function's second shape
 * unreachable.
 *
 * Silent on an alias with no station behind it: the route has already
 * answered 404 for that case, and this is also called on aliases the
 * homeserver merely wondered about.
 */
export async function provisionStationForAlias(
  alias: string,
  deps: ProvisionDeps
): Promise<void> {
  const station = await stationForAlias(alias, deps.domain);
  if (station) await provisionStation(station.stationId, deps);
}

/**
 * Provision everything that has not been.
 *
 * Runs at boot. One station's failure must not leave the other 31 without
 * rooms, and the count of failures is returned rather than swallowed so
 * "provisioned 31 of 32" is something an operator can see.
 */
export async function provisionAll(
  deps: ProvisionDeps
): Promise<{ provisioned: number; failed: number }> {
  const rows = await db.select({ id: stations.id }).from(stations);

  let provisioned = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await provisionStation(row.id, deps);
      provisioned++;
    } catch (err) {
      failed++;
      log.error("could not provision a station's Matrix identity", {
        stationId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("matrix provisioning complete", { provisioned, failed });
  return { provisioned, failed };
}
