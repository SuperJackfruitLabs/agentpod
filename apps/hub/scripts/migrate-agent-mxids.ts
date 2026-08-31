/**
 * Re-address 32 DM rooms from station-derived users to principal-derived ones.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md`. Before this, an
 * agent's Matrix identity was `bridgeUserId(nodeName, stationKey)`; after Task
 * 8 it is `bridgeUserId(principal.handle, domain)`. The 32 rooms `provision.ts`
 * already created are still addressed to the old, station-derived user, and
 * this is what moves them — the only irreversible step in slice A.
 *
 * **No room is deleted and no history is lost.** A room id is stable; only its
 * membership changes. The new virtual user joins the existing room and the old
 * one leaves; Matrix keeps every message from a member who has departed. The
 * AS owns the whole `@agent_.*` namespace, so the new user joins without an
 * invite.
 *
 * ## Join before leave
 *
 * The reverse order briefly leaves the room with no agent in it, and a crash
 * between the two steps — the process killed, the homeserver rejecting the
 * second call — would leave it that way permanently: a DM with a human on one
 * side and nobody on the other. Joining first means the worst a crash can do
 * is leave both users briefly in the room together, which is recoverable by
 * simply running this again.
 *
 * ## `m.direct` is the step that is easy to miss
 *
 * `provision.ts` creates these rooms with `isDirect: true`, and that flag
 * rides on the OWNER's own invite — Matrix records it in the owner's account
 * data as `m.direct: { <old mxid>: [roomId] }`, keyed on the correspondent's
 * OLD address. Move the membership and stop there, and the room is still a
 * room, still readable, still exactly as functional — it has simply stopped
 * being a DM in the operator's client: no longer listed under People, with
 * nothing in the room itself to explain why. That is a quiet, confusing
 * regression, so the account-data update is folded into the same pass rather
 * than left as a follow-up.
 *
 * A live probe on 2026-08-30 settled that the fold cannot actually reach the
 * operator's account data: the AS's exclusive namespace is `@agent_.*`, the
 * operator's own mxid sits outside it, and `GET account_data` as the
 * operator answers `400 M_EXCLUSIVE`, permanently. `setDirect` below is
 * still attempted and still non-fatal on any failure, `M_EXCLUSIVE`
 * included — see `migrate-agent-mxids-run.ts` for how the report tells that
 * permanent case apart from a real, retriable one, and for who has to close
 * it (the operator's own access token, in a one-off run this script cannot
 * make).
 *

 * ## Idempotency is real, not decorative
 *
 * A run across 32 rooms is expected to fail partway through — a timeout, a
 * rate limit, an operator's Ctrl-C — and a second run must pick up exactly
 * where the first left off. The skip condition is a fact about the room, not
 * a flag this script writes: a room whose already-correct address is what
 * `rooms()` reports as `oldUserId` needs nothing done to it, so
 * `bridgeUserId(handle, domain) === oldUserId` is skipped.
 *
 * `rooms()` establishes that fact by ASKING THE HOMESERVER, not by reading a
 * column. `matrix_rooms.principal_id` has a writer now (Task 5's admin
 * assign endpoint, and the migration that backfilled it) — but that column
 * answers a different question than the one this skip condition needs. It
 * records which principal is SUPPOSED to occupy a room, not whether the
 * Matrix-side rename this script performs has actually happened. A room's
 * `principal_id` can already name the right principal while its membership
 * still answers to the old, station-derived address — closing that gap is
 * this script's own job, so checking the column instead of the homeserver
 * would report a room done before it is, and a previous run's half-finished
 * rooms would read as untouched forever right alongside it.
 * `migrate-agent-mxids-run.ts` therefore still derives
 * `oldUserId` from `(nodeName, stationKey)` and settles each of the three
 * steps against live membership and a live `m.direct` read.
 *
 * ## A station with no occupying principal
 *
 * `rooms()` is the boundary that owns this decision, not this function: a
 * station whose `principalId` is null has no handle, and therefore no address
 * to migrate to. `rooms()` must leave such a room out of the list it returns
 * rather than invent one — this function never falls back to the station-
 * derived address, because doing so would silently keep the very identity
 * this migration exists to retire.
 */
import { bridgeUserId } from "../src/services/matrix-as/names";

export interface MxidMigrationDeps {
  /** Every room still needing this, or already done — see the skip rule above. */
  rooms(): Promise<Array<{ roomId: string; handle: string; oldUserId: string }>>;
  /** Join as the new user. The AS owns `@agent_.*`, so no invite is needed. */
  join(userId: string, roomId: string): Promise<void>;
  /** Leave as the old user, once the new one is in and `m.direct` points at it. */
  leave(userId: string, roomId: string): Promise<void>;
  /** Fix up the owner's `m.direct` account data to name the new user. */
  setDirect(userId: string, roomId: string): Promise<void>;
}

export async function migrateAgentMxids(
  deps: MxidMigrationDeps
): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  for (const room of await deps.rooms()) {
    // The domain comes from the room's own old address, not from a configured
    // default: it is already known, per room, from data `rooms()` supplied —
    // asking `process.env.MATRIX_DOMAIN` instead would silently disagree with
    // it the day this ever runs against more than one homeserver.
    const domain = room.oldUserId.slice(room.oldUserId.lastIndexOf(":") + 1);
    const next = bridgeUserId(room.handle, domain);
    if (next === room.oldUserId) {
      // Already this room's address — a prior run got here, or it never
      // needed to move. Nothing to do, and nothing to redo.
      skipped++;
      continue;
    }
    // Join first. Leaving first would leave the room with no agent in it, and
    // a crash between the two would leave it that way permanently.
    await deps.join(next, room.roomId);
    // Before the old user leaves: `m.direct` naming the old mxid is what makes
    // this room quietly stop being a DM once that member is gone.
    await deps.setDirect(next, room.roomId);
    await deps.leave(room.oldUserId, room.roomId);
    migrated++;
  }
  return { migrated, skipped };
}
