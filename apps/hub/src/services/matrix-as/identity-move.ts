/**
 * Moving a station's Matrix identity from a station-derived address to its
 * principal-derived `@agent_<handle>`, without it ever going silent.
 *
 * §4 of `docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md`.
 * **The ordering is the deliverable**, and it comes from an outage rather than
 * from taste: on 2026-08-31 the room migration re-addressed every station's
 * room and 14 harness-mode stations went mute, because each was logged in as
 * an account the room no longer contained. Every one had to be put back by
 * hand.
 *
 * The obvious order — switch the credential, then move the room — has that
 * mute window built into it. So the order here is:
 *
 *  1. the operator authorises (`routes/station-matrix.ts`);
 *  2. **`preJoinNewIdentity`** puts `@agent_<handle>` in the station's room
 *     while the OLD identity is still a member and still working;
 *  3. the node redeems the authorisation, writes the profile, restarts;
 *  4. the harness comes up as `@agent_<handle>` — *already a member*;
 *  5. the node reports the new mxid and **`onNodeReportedMatrixId`** sees that
 *     `matrix_id` is now the address the occupying principal's handle implies,
 *     which is what convergence means (§1, and `targetIdentity` below for why
 *     it is the handle that is asked and not `bridge_matrix_id`);
 *  6. only then does **`retireOldIdentity`** take the old account out of the
 *     room, record it against the same principal, and retire its credential.
 *
 * Nothing between steps 2 and 6 is mute: both identities are in the room, and
 * the station keeps answering as whichever one its harness currently holds.
 * The only irreversible step is the last, and it runs only after the new
 * identity has demonstrably worked.
 *
 * ## Two things this file knows because the fleet taught them (agentpod#397)
 *
 * **These rooms are invite-only.** `client.ts`'s `ensureRoom` creates them
 * with `preset: "private_chat"`, and a bare join by a user the room has not
 * invited is refused `403 M_FORBIDDEN — cannot join a room that is not
 * 'public'`. Owning the `@agent_.*` namespace lets the appservice *act as* a
 * user; it does not exempt that user from a room's join rules. So the new
 * identity is **invited by the old one** — still a member, and the room's
 * creator, so it holds the power level — and only then joins.
 *
 * **Inviting somebody already in the room is refused** — `403 M_FORBIDDEN —
 * cannot invite user that is joined or banned`. So the invite is skipped when
 * the new identity is already a member. Without that, a second run over a
 * partly-moved fleet fails on exactly the stations the first run fixed, which
 * is the opposite of what a retry is for.
 *
 * Both refusals were reproduced against a real tuwunel while this was written;
 * neither is guesswork, and neither can be proven against a fake.
 *
 * ## Refusing rather than guessing
 *
 * `matrix_rooms.station_id` stopped being unique when a room began following
 * its principal, so a station can carry more than one row. The room to move is
 * chosen by the rule the rest of the hub already uses — a bound room if the
 * occupant has one, otherwise the oldest unbound one — and when that choice is
 * genuinely ambiguous the move **refuses**, exactly as migration `0062` does.
 * A move that guesses puts an agent's new identity in a departed occupant's
 * room and leaves its own room without it.
 */

import { and, desc, eq, gt, isNotNull, or } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixCredentialAuthorizations } from "../../db/schema/matrix-credentials";
import { createLogger } from "../../utils/logger";
import { bridgeUserId } from "./names";
import { roomForStation, unboundRoomsForStation } from "./station-room";
import { principalHandle } from "../principals";
import { linkIdentity } from "../principal-identities";
import { onStationMatrixIdReported } from "./hooks";

const log = createLogger("identity-move");

/**
 * The Matrix operations a move needs, and no others.
 *
 * A structural interface rather than the whole `MatrixClient`, for the reason
 * `GateProjectionDeps` is one: the caller passes the real client in
 * production, and a test can pass a recorder for the parts where no
 * homeserver is involved. Membership itself is asserted against a real
 * homeserver — see `tests/integration/identity-move.test.ts`.
 */
export interface IdentityMoveClient {
  invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
  join(userId: string, roomId: string): Promise<void>;
  leave(userId: string, roomId: string): Promise<void>;
  isJoined(userId: string, roomId: string): Promise<boolean>;
  retireAccount(
    userId: string
  ): Promise<{ credentialsRevoked: boolean; accountDeactivated: boolean }>;
}

export interface IdentityMoveDeps {
  /** This homeserver's name, for building the address a handle implies. */
  domain: string;
  client: IdentityMoveClient;
}

/** What a move needs to know about a station. */
interface MovingStation {
  id: string;
  principalId: string | null;
  /** What the harness reports it answers as today. Null in bridge mode. */
  matrixId: string | null;
}

async function loadStation(stationId: string): Promise<MovingStation | null> {
  const [row] = await db
    .select({
      id: stations.id,
      principalId: stations.principalId,
      matrixId: stations.matrixId,
    })
    .from(stations)
    .where(eq(stations.id, stationId))
    .limit(1);
  return row ?? null;
}

/**
 * The address this station's occupant implies — where the move ends, and the
 * only thing convergence may be measured against.
 *
 * **This used to be `stations.bridge_matrix_id`, and that column cannot answer
 * the question.** It records the identity the appservice minted, which for a
 * harness station is written from `names.ts`'s `stationSpeaker` — and
 * `stationSpeaker` correctly returns the harness's OWN mxid there. So the
 * column holds "what this station already is", not "what the appservice would
 * mint for its occupant", and on the live fleet all 14 harness stations carry
 * `matrix_id = bridge_matrix_id = ` their old station-derived address. Every
 * comparison against it therefore read "converged" for exactly the stations
 * this file exists to move, the console offered none of them the move, and
 * nothing could ever start. Every test passed because every fixture set the
 * column to the handle-derived value — which is what the design assumed and
 * what `provision.ts` does not do.
 *
 * The question the invariant means to ask is *"is this station on its
 * principal's address?"*, and only the handle answers that. So it is asked of
 * the handle, through the same `bridgeUserId` derivation the rest of the
 * bridge uses. `bridge_matrix_id` keeps its stated meaning and is not
 * redefined, not backfilled, and no longer read here.
 *
 * Null means the station has no occupying principal, so it has no handle and
 * therefore no address to move to. That is a real answer — such a station is
 * not movable — and never patched over with the station-derived form, which
 * is the identity this slice exists to retire.
 */
async function targetIdentity(station: MovingStation, domain: string): Promise<string | null> {
  const handle = station.principalId ? await principalHandle(station.principalId) : null;
  return handle ? bridgeUserId(handle, domain) : null;
}

/**
 * Which of a station's rooms this move touches — or a refusal.
 *
 * A room already bound to the occupying principal is an unambiguous answer:
 * `matrix_rooms_principal_idx` makes it unique. Otherwise the choice is among
 * the station's unbound rooms under `station-room.ts`'s oldest-`created_at`
 * rule — and more than one candidate is refused rather than picked, because a
 * deterministic pick is still a guess about which room an operator meant, and
 * this move is the one act that cannot be taken back.
 */
type RoomChoice =
  | { status: "room"; roomId: string }
  | { status: "no-room" }
  | { status: "ambiguous-room"; candidates: string[] };

async function roomToMove(stationId: string): Promise<RoomChoice> {
  const occupancy = await roomForStation(stationId);
  if (occupancy.principalId && occupancy.room) {
    return { status: "room", roomId: occupancy.room.roomId };
  }

  const unbound = await unboundRoomsForStation(stationId);
  if (unbound.length > 1) {
    log.warn("station carries more than one candidate room; refusing to guess which one moves", {
      stationId,
      candidates: unbound.map((r) => r.roomId),
    });
    return { status: "ambiguous-room", candidates: unbound.map((r) => r.roomId) };
  }
  const only = unbound[0];
  return only ? { status: "room", roomId: only.roomId } : { status: "no-room" };
}

// ─── Step 2: the pre-join ─────────────────────────────────────────────────────

export type PreJoinOutcome =
  /** The new identity was invited and joined. Both identities are now present. */
  | { status: "joined"; roomId: string; newMxid: string; oldMxid: string }
  /** It was already a member — a re-run, and the reason the invite is skipped. */
  | { status: "already"; roomId: string; newMxid: string }
  | { status: "unknown-station" }
  /**
   * No occupying agent, so no handle, so no address to move to.
   *
   * There is no separate "the appservice never minted one" refusal any more:
   * the target is the address the occupant's HANDLE implies, and a station
   * with a handle always has one. That refusal existed only because this read
   * `bridge_matrix_id`, whose emptiness said nothing about whether the station
   * could move.
   */
  | { status: "no-agent" }
  | { status: "no-room" }
  | { status: "ambiguous-room"; candidates: string[] }
  /**
   * Nobody in the room can issue the invite: the station reports no identity
   * of its own, or the one it reports has already left. Refused rather than
   * attempted, so the operator reads a sentence instead of an M_FORBIDDEN.
   */
  | { status: "no-inviter"; roomId: string; newMxid: string };

/** What an operator should be told about a refusal, in one sentence. */
export function preJoinRefusal(outcome: PreJoinOutcome): string | null {
  switch (outcome.status) {
    case "joined":
    case "already":
      return null;
    case "unknown-station":
      return "This station no longer exists.";
    case "no-agent":
      return "This station has no occupying agent, so there is nothing to move to its own identity.";
    case "no-room":
      return "This station has no Matrix room, so there is nowhere to put its new identity before the harness switches.";
    case "ambiguous-room":
      return (
        "This station carries more than one Matrix room and which one to move is ambiguous " +
        `(${outcome.candidates.join(", ")}), so the move is refused rather than guessed.`
      );
    case "no-inviter":
      return (
        "The identity this station currently answers as is not in its room, so it cannot invite " +
        "the new one — moving now would leave the station unable to speak."
      );
  }
}

/**
 * Put `@agent_<handle>` in the station's room while the old identity is still
 * there and still working.
 *
 * Runs BEFORE the credential switches, and that is the whole point: by the
 * time the harness restarts under its new address, the room already contains
 * it. Nothing is mute at any moment, and if every later step fails the station
 * carries on exactly as it was — one extra member in a room is not an outage.
 *
 * Idempotent, because re-authorising is how the operator retries (Ruling 9):
 * a station whose new identity is already a member answers `already` and
 * changes nothing, rather than failing on the invite the homeserver refuses
 * for a member.
 */
export async function preJoinNewIdentity(
  stationId: string,
  deps: IdentityMoveDeps
): Promise<PreJoinOutcome> {
  const station = await loadStation(stationId);
  if (!station) return { status: "unknown-station" };

  // Where the move ENDS, derived from the occupant's handle — see
  // `targetIdentity`. This read `station.bridgeMatrixId`, on the reasoning
  // that acting on the account the appservice really minted beats acting on
  // one re-derived here. The reasoning was sound and the column was the wrong
  // one: for a harness station `bridge_matrix_id` holds the station's OWN
  // address, so the pre-join invited and joined the identity the station is
  // moving off — a no-op that reports `already` for every station on the
  // fleet.
  const newMxid = await targetIdentity(station, deps.domain);
  if (!newMxid) return { status: "no-agent" };

  const choice = await roomToMove(stationId);
  if (choice.status !== "room") return choice;
  const { roomId } = choice;

  // Asked before anything is attempted, because the homeserver refuses an
  // invite for a user already in the room — so a re-run over a partly-moved
  // fleet would fail on exactly the stations an earlier run fixed.
  if (await deps.client.isJoined(newMxid, roomId)) {
    return { status: "already", roomId, newMxid };
  }

  const oldMxid = station.matrixId;
  if (!oldMxid) return { status: "no-inviter", roomId, newMxid };
  if (!(await deps.client.isJoined(oldMxid, roomId))) {
    return { status: "no-inviter", roomId, newMxid };
  }

  // Invite THEN join. A bare join is refused on an invite-only room, and every
  // room this bridge creates is invite-only.
  await deps.client.invite(oldMxid, roomId, newMxid);
  await deps.client.join(newMxid, roomId);

  // The old identity must still be here. If it is not, the station is mute
  // right now and nothing later in this flow will notice on its own.
  if (!(await deps.client.isJoined(oldMxid, roomId))) {
    log.error("the identity a station answers as has left its room during a move", {
      stationId,
      roomId,
      oldMxid,
    });
  }

  log.info("a station's new Matrix identity is in its room, ahead of the credential switch", {
    stationId,
    roomId,
    newMxid,
    oldMxid,
  });
  return { status: "joined", roomId, newMxid, oldMxid };
}

// ─── Step 6: the retirement ───────────────────────────────────────────────────

export type RetireOutcome =
  | { status: "unknown-station" }
  | {
      status: "refused";
      /**
       * `live-identity` — the mxid asked about is the one the station answers
       * as now, so retiring it is the outage this file exists to prevent.
       *
       * `speaker-absent` — the identity the station answers as is NOT in the
       * room this retirement resolved. Taking the old one out would leave that
       * room with nobody in it who can speak for the station, which is the
       * 2026-08-31 shape exactly: mute, with no error anywhere. Fix round 1 —
       * the only guard here used to be `live-identity`, which is a claim about
       * who SPEAKS and not about who is IN THE ROOM, and the two come apart
       * whenever the station's room set changed between the pre-join and
       * convergence, or convergence arrived on a path where the pre-join never
       * ran at all.
       */
      reason: "live-identity" | "speaker-absent";
      /** The room the refusal was about, when there was one. */
      roomId?: string;
    }
  | {
      status: "retired";
      /**
       * Null when there was no room to leave — either the station has none, or
       * its room set is ambiguous and this refuses to guess. Recording and
       * revoking still happen in both cases; neither needs a room.
       */
      roomId: string | null;
      /** Each step's own truth: a failure here is logged, never fatal. */
      left: boolean;
      recorded: boolean;
      credentialsRevoked: boolean;
      /**
       * Whether the ACCOUNT itself is gone, as opposed to its credentials.
       * False is an ordinary answer on tuwunel — see `client.ts`'s
       * `retireAccount`.
       */
      accountDeactivated: boolean;
    };

/**
 * Take the old identity out of the room, record who it was, and stop its
 * credential being a live login.
 *
 * §5: a retired account's messages stay in its room — Matrix keeps history
 * from departed members — but the account need not. Recording it against the
 * same principal is what keeps that history attributable afterwards; the fleet
 * has exactly one `matrix` principal identity today, so before this ran
 * nothing could resolve any station's old address at all.
 *
 * **Two guards, and they are not the same guard.** The identity a station
 * currently answers as is never retired — checked against the database rather
 * than trusted from the caller, because the caller is what could be wrong. And
 * the room is never left unless the identity the station answers as is
 * verifiably IN it, asked of the homeserver at the moment of the leave. The
 * first is about who speaks; the second is about who is present; and a station
 * goes mute in the gap between them. Fix round 1 added the second after a
 * review found that a convergence arriving on a path where the pre-join never
 * ran would take the old identity out of a room the new one had never been
 * invited to — the 2026-08-31 outage, reachable again.
 *
 * Each of the three steps is attempted even if an earlier one failed, and each
 * reports its own outcome. Aborting on the first failure would leave the old
 * mxid unrecorded — and `stations.matrix_id` has already moved on by the time
 * this runs, so nothing else remembers it.
 */
export async function retireOldIdentity(
  stationId: string,
  oldMxid: string,
  deps: IdentityMoveDeps
): Promise<RetireOutcome> {
  const station = await loadStation(stationId);
  if (!station) return { status: "unknown-station" };

  // The address the station is moving TO, handle-derived (`targetIdentity`).
  // The guard below compared against `bridge_matrix_id`, which on the fleet IS
  // the old station-derived address — so the one identity a real retirement is
  // ever called on was the one this refused to touch, and step 6 could not run
  // even if everything before it had.
  const target = await targetIdentity(station, deps.domain);

  if (!oldMxid || oldMxid === station.matrixId || oldMxid === target) {
    log.warn("refusing to retire the identity a station currently answers as", {
      stationId,
      oldMxid,
    });
    return { status: "refused", reason: "live-identity" };
  }

  const choice = await roomToMove(stationId);
  const roomId = choice.status === "room" ? choice.roomId : null;

  let left = false;
  if (roomId) {
    // **Asked of the homeserver, immediately before the leave.** The whole
    // point of this flow is that the room contains a working identity at every
    // moment, and the only way to know that is to ask — our own state cannot
    // say it. This is deliberately stronger than carrying the room id through
    // from `preJoinNewIdentity`: the pre-join happens in the operator's
    // request and this runs on a node's detect minutes or hours later, so
    // nothing in this process survives between them, and a room id carried
    // across that gap would be a remembered claim about membership rather
    // than a checked one. A stale carried id and a changed room set fail the
    // same way; this question catches both.
    // `?? target` is the bridge-mode fallback: a station with no `matrix_id`
    // is one the appservice speaks for, and it speaks as the occupant's
    // handle-derived address — the same thing `names.ts`'s `stationSpeaker`
    // answers in bridge mode, and what `provision.ts` therefore wrote into
    // `bridge_matrix_id` for such a station. Read off the handle rather than
    // off that column so the fallback and the guard above ask one question.
    //
    // **That is safe here only because of the guard above**, and the coupling
    // is load-bearing enough to say out loud: the live-identity check already
    // refused when `oldMxid === target`, so by this line the identity being
    // retired can never be the one this fallback resolves to. Without that
    // guard this would ask "is the account I am about to remove still in the
    // room?", get `true`, and take it out — which is the mute station this
    // whole file exists to prevent. Anyone loosening the guard above has to
    // give this line its own check.
    const speaker = station.matrixId ?? target;
    if (!speaker || !(await deps.client.isJoined(speaker, roomId))) {
      log.error(
        "refusing to retire an identity out of a room the station cannot speak in — " +
          "leaving would make it mute",
        { stationId, roomId, oldMxid, speaker }
      );
      // Nothing else runs either: the credential this would revoke is the one
      // an operator would put the harness back on to recover, and a
      // `principal_identities` row saying an identity is retired while it is
      // still the live one is a lie that outlives the incident.
      return { status: "refused", reason: "speaker-absent", roomId };
    }

    try {
      await deps.client.leave(oldMxid, roomId);
      left = true;
    } catch (err) {
      log.warn("a retired identity could not be taken out of its room", {
        stationId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (choice.status === "ambiguous-room") {
    // Fix round 1's Minor. An ambiguous room set means this cannot choose
    // which room to take the old identity OUT of — and that is all it means.
    // Recording who the identity was and revoking its credential need no room
    // at all, and refusing them here left an agent's history unattributable
    // and a live credential on a node over a question about somewhere else.
    log.warn(
      "cannot choose which room a retired identity should leave; recording and " +
        "revoking it anyway, since neither needs a room",
      { stationId, oldMxid, candidates: choice.candidates }
    );
  }

  let recorded = false;
  if (station.principalId) {
    try {
      await linkIdentity(station.principalId, "matrix", oldMxid);
      recorded = true;
    } catch (err) {
      // Both unique indexes are load-bearing and both can legitimately be hit
      // here: an agent that has already retired one identity has a `matrix`
      // row, and a re-run has this exact row. Neither is a reason to fail the
      // retirement — but neither may pass silently, because the whole point of
      // the record is that the history stays attributable.
      log.warn("could not record a retired Matrix identity against its principal", {
        stationId,
        principalId: station.principalId,
        oldMxid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let credentialsRevoked = false;
  let accountDeactivated = false;
  try {
    const done = await deps.client.retireAccount(oldMxid);
    credentialsRevoked = done.credentialsRevoked;
    accountDeactivated = done.accountDeactivated;
  } catch (err) {
    log.warn("could not retire a Matrix account's credentials", {
      stationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!credentialsRevoked) {
    // The security half of §5. An unrevoked credential on a node is still a
    // live login for an account nothing is watching.
    log.warn("a retired Matrix identity still holds a live credential", { stationId, oldMxid });
  }

  log.info("retired a station's previous Matrix identity", {
    stationId,
    oldMxid,
    roomId,
    left,
    recorded,
    credentialsRevoked,
    accountDeactivated,
  });
  return { status: "retired", roomId, left, recorded, credentialsRevoked, accountDeactivated };
}

// ─── Step 5: convergence ──────────────────────────────────────────────────────

export type ConvergenceOutcome =
  | { status: "unknown-station" }
  /** The node reported something that is not the address this move ends at. */
  | { status: "not-converged"; reported: string; expected: string | null }
  /** Already converged before this report — nothing left to do. */
  | { status: "already" }
  | { status: "converged"; retired: RetireOutcome | null };

/**
 * The node has reported what its harness answers as. Is that convergence?
 *
 * "Is this the address the occupant's handle implies" is the whole test (§1's
 * invariant, as `targetIdentity` restates it), and it is deliberately the ONLY
 * thing that triggers the irreversible step. A harness that never restarts, an
 * adapter that wrote the wrong file, a credential the harness ignored — all of
 * them show up here as "not this address", and all of them leave the station
 * working under its old identity with both accounts in the room.
 *
 * Asked of the handle rather than of `bridge_matrix_id`: on the fleet that
 * column holds the station's own old address, so a harness that had done
 * nothing at all reported exactly what this used to call convergence.
 *
 * Called before `station-registry` writes the reported value, because the
 * value it is about to overwrite is the only record of who the old identity
 * was.
 */
export async function onNodeReportedMatrixId(
  stationId: string,
  mxid: string,
  deps: IdentityMoveDeps
): Promise<ConvergenceOutcome> {
  const station = await loadStation(stationId);
  if (!station) return { status: "unknown-station" };

  const target = await targetIdentity(station, deps.domain);
  if (!mxid || !target || mxid !== target) {
    return { status: "not-converged", reported: mxid, expected: target };
  }

  const oldMxid = station.matrixId;
  if (oldMxid === mxid) return { status: "already" };

  // Record the convergence here rather than relying on the caller's own write:
  // this function is what decided the move is complete, and the retirement
  // below reads as "the station already answers as the new address".
  await db.update(stations).set({ matrixId: mxid }).where(eq(stations.id, stationId));

  log.info("a station has converged on its own Matrix identity", { stationId, mxid, oldMxid });

  if (!oldMxid) return { status: "converged", retired: null };
  return { status: "converged", retired: await retireOldIdentity(stationId, oldMxid, deps) };
}

/**
 * Points the hook every detect announces through (`hooks.ts`'s
 * `onStationMatrixIdReported`) at this file's own convergence listener.
 *
 * `index.ts` calls this once, at boot, in place of inlining the
 * registration — the same move `stationMatrixCredentialRoutesFor`
 * (`routes/station-matrix-credential.ts`) made for the credential-route mount
 * decision, and for the same reason. An inline registration inside
 * `index.ts`'s boot sequence cannot be exercised without booting the whole
 * hub (DB init, the node sweeper, the kaambaan bridge, the real Matrix
 * bridge) — nothing in this suite does that — so a deleted or broken
 * registration would leave every test green while a moved station silently
 * never converges: the exact defect the whole-branch review was built to
 * find. Pulling the registration into a function `index.ts` calls rather
 * than restates means a test can call the SAME function and drive the SAME
 * registration, instead of reimplementing its shape locally (which is what
 * `station-matrix-identity.test.ts` used to do here).
 */
export function wireConvergenceListener(deps: IdentityMoveDeps): void {
  onStationMatrixIdReported(async (stationId, mxid) => {
    await onNodeReportedMatrixId(stationId, mxid, deps);
  });
}

// ─── What an operator (and the gate sweep) can see ────────────────────────────

/**
 * Where a station stands in §1's invariant — the states §6 renders, and the
 * one the fleet could not answer on 2026-08-31.
 *
 * Derived from `matrix_id`, the occupant's handle and the authorisation
 * record; there is no "moving" flag, because a flag is a fourth place for this
 * to be wrong — and no longer any reading of `bridge_matrix_id`, because that
 * column answered a different question than the one this asks
 * (`targetIdentity`).
 */
export type MoveState =
  | { status: "unknown" }
  /** `matrix_id IS NULL` — the appservice speaks for it, and always did. */
  | { status: "bridge" }
  /** `matrix_id` IS the address the occupant's handle implies — converged. */
  | { status: "converged"; mxid: string }
  /**
   * Harness mode with nobody occupying the station: there is no handle, so
   * there is no address to move to, and this station is not movable at all.
   *
   * A real answer rather than an omission, and distinct from
   * `retired-identity` on purpose: the console must not offer a move it has
   * no target for, and must not silently render nothing either — a station
   * answering as an address no principal owns is a thing an operator needs to
   * be told about, not a blank.
   */
  | { status: "no-agent"; runningAs: string }
  /**
   * Authorised and not yet converged. **Waiting, not broken** (Ruling 9): the
   * broker signal is fire-and-forget, so a station sits here from the moment an
   * operator authorises until its harness comes back under the new address. A
   * station stuck here is the signal that a harness did not restart — which is
   * the state that used to produce nothing but silence.
   */
  | { status: "waiting"; runningAs: string; willBecome: string; since: Date }
  /**
   * The station answers as something other than its principal's address, with
   * no live authorisation behind it: it is running under a retired identity
   * and nobody has asked for it to move. That is the fleet's condition for all
   * 14 harness stations today, and it is a thing to do, not a fault.
   *
   * `willBecome` is never null here — a station with no handle is `no-agent`
   * above, and reaches this branch not at all.
   */
  | { status: "retired-identity"; runningAs: string; willBecome: string };

/**
 * An authorisation counts as a move in flight while it can still lead to one:
 * either it has been redeemed (the node has the credential; the harness is
 * restarting) or it is still redeemable. An authorisation that expired
 * unredeemed is §4's "nothing happened" — the station drops back to
 * `retired-identity`, which is exactly the state from which an operator
 * authorises again.
 */
async function liveAuthorization(
  stationId: string
): Promise<{ createdAt: Date; usedAt: Date | null } | null> {
  const [row] = await db
    .select({
      createdAt: matrixCredentialAuthorizations.createdAt,
      usedAt: matrixCredentialAuthorizations.usedAt,
    })
    .from(matrixCredentialAuthorizations)
    .where(
      and(
        eq(matrixCredentialAuthorizations.stationId, stationId),
        or(
          isNotNull(matrixCredentialAuthorizations.usedAt),
          gt(matrixCredentialAuthorizations.expiresAt, new Date())
        )
      )
    )
    .orderBy(desc(matrixCredentialAuthorizations.createdAt))
    .limit(1);
  return row ?? null;
}

export async function moveState(stationId: string, domain: string): Promise<MoveState> {
  const station = await loadStation(stationId);
  if (!station) return { status: "unknown" };
  if (!station.matrixId) return { status: "bridge" };

  // The question this whole state machine means to ask — "is this station on
  // its principal's address?" — and only the handle answers it. Compared
  // against `bridge_matrix_id` until 2026-09-01, which made every harness
  // station on the fleet read `converged` while sitting on the very identity
  // it was supposed to leave: the console offered nobody a move, and no move
  // could start. See `targetIdentity`.
  const target = await targetIdentity(station, domain);
  if (!target) return { status: "no-agent", runningAs: station.matrixId };
  if (station.matrixId === target) {
    return { status: "converged", mxid: station.matrixId };
  }

  const authorization = await liveAuthorization(stationId);
  if (authorization) {
    return {
      status: "waiting",
      runningAs: station.matrixId,
      willBecome: target,
      since: authorization.createdAt,
    };
  }
  return { status: "retired-identity", runningAs: station.matrixId, willBecome: target };
}

/**
 * How long a REDEEMED authorisation excuses a later fault as "mid-move"
 * before the sweep should start calling it broken instead.
 *
 * Ruling 19 (parked finding 16): `moveState`'s `waiting` has no upper bound,
 * on purpose — a stalled move staying visible in the console is useful, and
 * is exactly what §6 asks for. But `moveInProgress` is what `gates.ts` uses
 * to EXCUSE a fault, and with no bound of its own a station stuck in
 * `waiting` forever reads as mid-move forever: every later `no-room` or
 * `no-speaker` gets attributed to a move that isn't happening, and that
 * station can never again read as a fault. A harness restart plus a detect
 * is comfortably under a minute; past this, nothing is moving.
 */
const STALLED_MOVE_BOUND_MS = 15 * 60 * 1000;

/**
 * Is this station mid-move?
 *
 * Read by `gates.ts` so a gate that cannot be placed during a move is
 * attributable to the move rather than reading as a broken station (§6). A
 * move must not look healthy, and it must not look like a fault either — but
 * only for as long as it is plausibly still a move. `moveState` (above)
 * answers "what does the console show"; this answers "should the sweep
 * excuse the fault it just saw", and the two questions get different
 * answers once a redeemed authorisation is old enough (Ruling 19).
 */
export async function moveInProgress(stationId: string, domain: string): Promise<boolean> {
  const state = await moveState(stationId, domain);
  if (state.status !== "waiting") return false;

  const authorization = await liveAuthorization(stationId);
  // Not yet redeemed: still within its own expiry, which `liveAuthorization`
  // already enforces — no separate bound needed here.
  if (!authorization?.usedAt) return true;
  return Date.now() - authorization.usedAt.getTime() < STALLED_MOVE_BOUND_MS;
}
