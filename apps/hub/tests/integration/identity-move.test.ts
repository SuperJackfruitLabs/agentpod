/**
 * The ordered move — a station changes its Matrix identity without going mute.
 *
 * §4 of `docs/superpowers/specs/2026-09-01-uniform-matrix-identity-design.md`.
 * The failure this guards against is **silence, not an error**: on 2026-08-31
 * a room migration moved 14 harness stations' rooms onto their new addresses
 * while each harness was still logged in as the old one, and every station
 * went quiet with nothing anywhere reporting a fault.
 *
 * ## Why half of this file refuses to run against a fake
 *
 * §7: "Every assertion about Matrix membership or session identity is checked
 * against the real thing, or it does not count." Three defects reached
 * production on 2026-08-31 behind green fakes — a fake that accepted a bare
 * join into an invite-only room, and fakes that accepted any user id. A fake
 * homeserver can be written to agree with whatever this file believes about
 * membership, which makes a passing membership assertion worth nothing.
 *
 * So the membership tests below talk to a real homeserver, and are **skipped,
 * loudly, when there is not one** rather than quietly re-pointed at a fake.
 * To run them:
 *
 *     docker run -d --name agentpod-test-hs -p 6167:6167 \
 *       -v "$PWD/hs/data:/var/lib/tuwunel" \
 *       -v "$PWD/hs/tuwunel.toml:/etc/tuwunel/tuwunel.toml:ro" \
 *       -v "$PWD/hs/appservices:/etc/tuwunel/appservices:ro" \
 *       -e TUWUNEL_CONFIG=/etc/tuwunel/tuwunel.toml \
 *       ghcr.io/matrix-construct/tuwunel:latest
 *
 * with an appservice registration owning `@agent_.*` / `#agentpod_.*`, then
 * `MATRIX_TEST_HOMESERVER_URL` and `MATRIX_TEST_AS_TOKEN` set for the run. The
 * full recipe is in `TESTING.md`; the homeserver's own name is read back off a
 * registration rather than configured here, so there is one fewer thing to get
 * wrong.
 *
 * The tests that involve no homeserver at all — the ambiguous-room refusal,
 * what a station mid-move looks like to the gate sweep — run always, because
 * nothing about them is a claim about Matrix.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { createPrincipal } from "../../src/services/principals";
import { identitiesFor } from "../../src/services/principal-identities";
import { createMatrixClient, type MatrixClient } from "../../src/services/matrix-as/client";
import { bridgeLocalpart, bridgeUserId, stationSpeaker } from "../../src/services/matrix-as/names";
import { projectGate, type GatePendingDelivery } from "../../src/services/matrix-as/gates";
import {
  moveInProgress,
  moveState,
  onNodeReportedMatrixId,
  preJoinNewIdentity,
  retireOldIdentity,
  type IdentityMoveDeps,
} from "../../src/services/matrix-as/identity-move";
import {
  mintCredentialAuthorization,
  redeemCredentialAuthorization,
} from "../../src/services/matrix-credential";

const RUN = Math.random().toString(36).slice(2, 8);
const OWNER = `test-user-identity-move-${RUN}`;
const NODE = `node_identity_move_${RUN}`;
const STATION = `station_identity_move_${RUN}`;
const HANDLE = `identity-move-echo-${RUN}`;
const BOARD = `brd_identity_move_${RUN}`;

let TENANT: string;
let OWNER_PRINCIPAL: string;
let AGENT_PRINCIPAL: string;

// ─── Is there a real homeserver? ──────────────────────────────────────────────

const HS_URL = (process.env.MATRIX_TEST_HOMESERVER_URL ?? "").replace(/\/+$/, "");
const AS_TOKEN = process.env.MATRIX_TEST_AS_TOKEN ?? "";

/**
 * Did this run ASK for a homeserver?
 *
 * Either variable set is intent — a typo in one of the two names is a run that
 * meant to prove membership and would otherwise prove nothing.
 */
const REQUESTED = Boolean(HS_URL || AS_TOKEN);

/**
 * Ask the homeserver for its own name by registering a throwaway identity in
 * the appservice's namespace and reading the domain off the mxid it hands
 * back. A homeserver that will not do that cannot serve any test in this file,
 * so the probe and the capability check are the same act.
 *
 * Returns why it could not, rather than a bare null. Fix round 1: this used to
 * swallow everything and answer null, which made the skip predicate "the probe
 * worked" rather than "no homeserver was requested" — so a run pointed at a
 * dead port, or carrying a bad token, downgraded silently to eight green skips
 * and exit 0. That is the same shape as the failure this whole file exists to
 * catch: a thing that did not happen, reported as nothing at all.
 */
async function probeHomeserver(): Promise<{ domain: string } | { failed: string }> {
  if (!HS_URL) return { failed: "MATRIX_TEST_HOMESERVER_URL is not set" };
  if (!AS_TOKEN) return { failed: "MATRIX_TEST_AS_TOKEN is not set" };
  try {
    const res = await fetch(`${HS_URL}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AS_TOKEN}` },
      body: JSON.stringify({
        type: "m.login.application_service",
        username: `agent_probe_${RUN}`,
      }),
    });
    const body = (await res.json()) as { user_id?: string; errcode?: string; error?: string };
    const domain = body.user_id?.split(":")[1];
    if (domain) return { domain };
    return {
      failed:
        `${HS_URL} answered ${res.status} ${body.errcode ?? ""} ${body.error ?? ""}`.trim() +
        " — it registered no appservice user, so no membership assertion here can run",
    };
  } catch (err) {
    return {
      failed: `${HS_URL} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const PROBE = await probeHomeserver();
const LIVE_DOMAIN = "domain" in PROBE ? PROBE.domain : null;
/** The domain the database fixture uses either way, so the DB-only tests are identical. */
const DOMAIN = LIVE_DOMAIN ?? "hs.test";
const NEW_MXID = bridgeUserId(HANDLE, DOMAIN);

if (!LIVE_DOMAIN && !REQUESTED) {
  console.warn(
    "\n[identity-move] NO REAL HOMESERVER — the membership half of the ordered move was NOT proven.\n" +
      "  Unproven here: that the new identity joins before the credential switches and the old one\n" +
      "  stays; that a bare join into these invite-only rooms is refused; that a re-run over an\n" +
      "  already-moved station does not fail on the invite; that the old identity leaves only after\n" +
      "  convergence; and that a retired identity's credential stops working.\n" +
      "  Set MATRIX_TEST_HOMESERVER_URL and MATRIX_TEST_AS_TOKEN to run them (see TESTING.md).\n"
  );
}

const live = LIVE_DOMAIN ? describe : describe.skip;
const requested = REQUESTED ? describe : describe.skip;

const client: MatrixClient | null = LIVE_DOMAIN
  ? createMatrixClient({ homeserverUrl: HS_URL, asToken: AS_TOKEN, domain: DOMAIN })
  : null;

const deps = (): IdentityMoveDeps => ({ domain: DOMAIN, client: client! });

/** The credential each old identity was issued, so retirement can be proven to kill it. */
const issuedTokens = new Map<string, string>();

/**
 * Who is in this room, asked of the homeserver as a member of it.
 *
 * `joined_members` is a member's view, so the querier has to be in the room —
 * which is why the caller says who to ask as. Deliberately not read from any
 * state this test wrote.
 */
async function roomMembers(roomId: string, asUser: string): Promise<string[]> {
  const res = await fetch(
    `${HS_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members` +
      `?user_id=${encodeURIComponent(asUser)}`,
    { headers: { Authorization: `Bearer ${AS_TOKEN}` } }
  );
  const body = (await res.json()) as { joined?: Record<string, unknown> };
  return Object.keys(body.joined ?? {});
}

/**
 * Is this identity's credential still a live login?
 *
 * **This is what "active" means here, and it is narrower than "the account
 * row is gone".** tuwunel does not let an appservice deactivate an account:
 * probed 2026-09-01 against 1.9.0, masquerading on `/account/deactivate`
 * answers `401 M_MISSING_TOKEN`, and with an appservice-minted user token it
 * answers a User-Interactive Auth challenge whose `flows` list is empty — a
 * challenge with no satisfiable flow — while `/_synapse/admin/...` answers
 * 403. What retirement can do, and does, is revoke every credential the
 * identity holds, which is the half §5 asks for in so many words: "an unused
 * credential on a node stops being a live login". So this asks the
 * homeserver whether the token that identity was issued still works.
 */
async function accountIsActive(mxid: string): Promise<boolean> {
  const token = issuedTokens.get(mxid);
  if (!token) throw new Error(`no credential recorded for ${mxid} — the test fixture is wrong`);
  const res = await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status === 200;
}

/** The production answer to "who does this hub speak as here", for one station. */
async function speakerFor(stationId: string): Promise<string | null> {
  const rows = await rawSql`
    SELECT matrix_identity_mode, matrix_id FROM stations WHERE id = ${stationId}`;
  const row = rows[0] as { matrix_identity_mode: string; matrix_id: string | null };
  return stationSpeaker(
    { identityMode: row.matrix_identity_mode, harnessMxid: row.matrix_id, handle: HANDLE },
    DOMAIN
  );
}

/**
 * A station as the fleet actually has it today: harness mode, answering as a
 * station-derived address, with the principal-derived one already minted
 * beside it, and one room bound to its occupant.
 *
 * A real room on a real homeserver, created the way `provision.ts` creates
 * one — `preset: "private_chat"`, i.e. invite-only, which is the whole reason
 * the pre-join needs an invite.
 */
async function stationMidFleet(label: string): Promise<{ roomId: string; oldMxid: string }> {
  const issued = await client!.registerWithCredentials(`agent_${RUN}_${label}_old`);
  issuedTokens.set(issued.userId, issued.accessToken);

  const alias = `#agentpod_${RUN}_${label}:${DOMAIN}`;
  const roomId = await client!.ensureRoom(alias, {
    creator: issued.userId,
    name: `identity move ${label}`,
    topic: "the room a station has always had",
  });
  if (!roomId) throw new Error(`could not create a room at ${alias}`);

  await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
  await rawSql`
    INSERT INTO matrix_rooms (room_id, tenant_id, station_id, principal_id, alias, created_at)
    VALUES (${roomId}, ${TENANT}, ${STATION}, ${AGENT_PRINCIPAL}, ${alias}, now())`;
  await rawSql`
    UPDATE stations
       SET matrix_id = ${issued.userId},
           bridge_matrix_id = ${NEW_MXID},
           matrix_identity_mode = 'harness'
     WHERE id = ${STATION}`;
  await rawSql`DELETE FROM principal_identities WHERE principal_id = ${AGENT_PRINCIPAL}`;

  return { roomId, oldMxid: issued.userId };
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `identity-move-${RUN}@example.com`, name: "Owner" });
  OWNER_PRINCIPAL = await createPrincipal({
    kind: "human",
    handle: `identity-move-owner-${RUN}`,
    userId: OWNER,
  });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: HANDLE });
  TENANT = await resolveTenantForUser(OWNER);

  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${TENANT}, ${OWNER}, ${"im-box-" + RUN}, 'im-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name,
                          capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${TENANT}, ${OWNER}, ${NODE}, 'hermes', ${"hermes:echo-" + RUN}, 'leaf', 'echo',
            '["acp"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;

  // The identity the appservice minted for this agent — registered for real,
  // because everything below asks a homeserver to put it in a room.
  if (client) await client.ensureUser(bridgeLocalpart(HANDLE), "Echo");
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_gate_events WHERE board_id = ${BOARD}`;
    await rawSql`DELETE FROM bridge_dispatches WHERE board_id = ${BOARD}`;
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${AGENT_PRINCIPAL}`;
    await rawSql`DELETE FROM principals WHERE id IN (${AGENT_PRINCIPAL}, ${OWNER_PRINCIPAL})`;
    await rawSql`DELETE FROM "user" WHERE id = ${OWNER}`;
  } catch {
    // cleanup only
  }
});

/** kaambaan's record that this fleet ran the card. Not the thing under test. */
async function dispatched(cardId: string): Promise<void> {
  await rawSql`
    INSERT INTO bridge_dispatches (external_source, external_run_id, tenant_id, board_id,
                                   external_card_id, agent_key, station_id, lease_epoch,
                                   outcome, started_at, updated_at)
    VALUES ('kaambaan', ${"run_" + cardId}, ${TENANT}, ${BOARD}, ${cardId}, 'test',
            ${STATION}, 1, 'produced', now(), now())`;
}

function delivery(gateId: string, cardId: string): GatePendingDelivery {
  return {
    event: "gate.pending",
    boardId: BOARD,
    cardId,
    gateId,
    stageKey: "review",
    returnStageKey: "build",
    cardTitle: "Ship the fix",
    producedBy: "agt_x",
    options: [{ id: "approve", label: "Approve" }],
    ts: "2026-09-01T00:00:00.000Z",
  };
}

// ─── A requested homeserver must actually answer ─────────────────────────────

requested("a homeserver was asked for on this run", () => {
  test("...and it answered, so the membership assertions below really ran", () => {
    // Setting `MATRIX_TEST_HOMESERVER_URL` / `MATRIX_TEST_AS_TOKEN` is an
    // explicit intent to prove membership against the real thing. A run that
    // asked and could not reach or authenticate against a homeserver must FAIL
    // here rather than skip eight tests green: a skip is the right answer to
    // "nobody asked", and the wrong answer to "somebody asked and it did not
    // work". §7 — checked against the real thing, or it does not count — is
    // not satisfied by a run that quietly checked nothing.
    expect("domain" in PROBE ? null : (PROBE as { failed: string }).failed).toBeNull();
  });
});

// ─── The ordering, against a real homeserver ─────────────────────────────────

live("the ordered move, against a real homeserver", () => {
  test("a bare join into one of these rooms is refused — the invite is load-bearing", async () => {
    // The defect behind agentpod#397, asserted directly rather than assumed.
    // `client.ts` used to claim in so many words that owning the `@agent_.*`
    // namespace meant a join needed no invite. It does not: namespace
    // ownership lets the appservice ACT AS a user, it does not exempt that
    // user from a room's join rules. A fake that accepts a bare join makes
    // every other test in this file pass while production 403s.
    const { roomId, oldMxid } = await stationMidFleet("bare");

    let refusal: unknown = null;
    try {
      await client!.join(NEW_MXID, roomId);
    } catch (err) {
      refusal = err;
    }

    expect(refusal, "the homeserver refused an uninvited join").not.toBeNull();
    expect(String(refusal)).toContain("M_FORBIDDEN");
    expect(await roomMembers(roomId, oldMxid)).not.toContain(NEW_MXID);
  });

  test("the new identity joins BEFORE the credential switches, and the old one stays", async () => {
    const { roomId, oldMxid } = await stationMidFleet("prejoin");

    const outcome = await preJoinNewIdentity(STATION, deps());

    expect(outcome.status).toBe("joined");
    const members = await roomMembers(roomId, NEW_MXID);
    expect(members).toContain(NEW_MXID);
    // Nothing is mute at any point: the harness is still logged in as the old
    // identity at this moment, and the room still contains it.
    expect(members).toContain(oldMxid);
    // And the credential has not moved: `matrix_id` is what the harness
    // reports, and nothing has told it to report anything else yet.
    expect(await speakerFor(STATION)).toBe(oldMxid);
  });

  test("running the pre-join twice does not fail on the invite", async () => {
    // The second hard-won fact behind agentpod#397: inviting a user who is
    // already in the room is refused (`cannot invite user that is joined or
    // banned`). Without the skip, a second run over a partly-moved fleet
    // fails on exactly the stations the first run fixed — which is the
    // opposite of what a retry is for, and re-authorising IS the retry.
    const { roomId } = await stationMidFleet("rerun");

    expect((await preJoinNewIdentity(STATION, deps())).status).toBe("joined");
    const second = await preJoinNewIdentity(STATION, deps());

    expect(second.status).toBe("already");
    expect(await roomMembers(roomId, NEW_MXID)).toContain(NEW_MXID);
  });

  test("the old identity is NOT retired until the node reports convergence", async () => {
    const { roomId, oldMxid } = await stationMidFleet("converge");
    await preJoinNewIdentity(STATION, deps());

    expect(await roomMembers(roomId, NEW_MXID)).toContain(oldMxid);

    const outcome = await onNodeReportedMatrixId(STATION, NEW_MXID, deps());

    expect(outcome.status).toBe("converged");
    expect(await roomMembers(roomId, NEW_MXID)).not.toContain(oldMxid);
    expect(await roomMembers(roomId, NEW_MXID)).toContain(NEW_MXID);
  });

  test("a node that never reports leaves the station working under its old identity", async () => {
    const { roomId, oldMxid } = await stationMidFleet("silent");
    await preJoinNewIdentity(STATION, deps());

    // No convergence report. This is the harness that would not restart, the
    // adapter that wrote the wrong file, and the credential the harness
    // ignored — all three land here, and all three are survivable.
    expect(await roomMembers(roomId, NEW_MXID)).toContain(oldMxid);
    expect(await speakerFor(STATION)).toBe(oldMxid);
  });

  test("a report that is not the new address is not convergence", async () => {
    const { roomId, oldMxid } = await stationMidFleet("wrongfile");
    await preJoinNewIdentity(STATION, deps());

    // §3's failure: an adapter that wrote a file the harness never loads, so
    // the harness comes back up as itself and the reader reports the address
    // it always had. Nothing irreversible may happen on that.
    const outcome = await onNodeReportedMatrixId(STATION, oldMxid, deps());

    expect(outcome.status).toBe("not-converged");
    expect(await roomMembers(roomId, NEW_MXID)).toContain(oldMxid);
    expect(await speakerFor(STATION)).toBe(oldMxid);
  });

  test("retiring records the old mxid against the same principal, then retires its credential", async () => {
    const { oldMxid } = await stationMidFleet("retire");
    await preJoinNewIdentity(STATION, deps());
    // Convergence first, and only then retirement — the order this file
    // exists to hold. `retireOldIdentity` refuses outright to retire the
    // identity a station is currently answering as, so this is also the only
    // order in which it can be called at all.
    await onNodeReportedMatrixId(STATION, NEW_MXID, deps());

    const ids = await identitiesFor(AGENT_PRINCIPAL);
    expect(ids).toContainEqual({ system: "matrix", externalId: oldMxid });
    // §5: history stays readable and attributable, and the credential stops
    // being a live login. See `accountIsActive` for what this homeserver does
    // and does not let an appservice do about the account itself.
    expect(await accountIsActive(oldMxid)).toBe(false);
  });

  test("retiring the identity a station currently answers as is refused", async () => {
    const { roomId, oldMxid } = await stationMidFleet("guard");
    await preJoinNewIdentity(STATION, deps());

    // The 2026-08-31 outage in one call: take the live identity out of the
    // room. It is refused against the database rather than trusted from the
    // caller, because the caller is what could be wrong.
    const outcome = await retireOldIdentity(STATION, oldMxid, deps());

    expect(outcome.status).toBe("refused");
    expect(await roomMembers(roomId, NEW_MXID)).toContain(oldMxid);
    expect(await accountIsActive(oldMxid)).toBe(true);
  });

  test("the old identity is not taken out of a room the station cannot speak in", async () => {
    // Fix round 1's Important. Convergence can arrive on a path where the
    // pre-join never ran — a node reporting the new mxid because somebody set
    // the credential by hand, or a station whose room set changed in between —
    // and the "is this the live identity?" guard says nothing about that,
    // because it is a claim about who SPEAKS, not about who is IN THE ROOM.
    // Retiring here removes the last member that can talk: mute, no error.
    const { roomId, oldMxid } = await stationMidFleet("orphan");
    // Converged, with NO pre-join: `@agent_<handle>` was never invited and is
    // not in this room.
    await rawSql`UPDATE stations SET matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
    expect(await roomMembers(roomId, oldMxid)).not.toContain(NEW_MXID);

    const outcome = await retireOldIdentity(STATION, oldMxid, deps());

    expect(outcome.status).toBe("refused");
    expect(outcome).toMatchObject({ reason: "speaker-absent" });
    // Everything is exactly as it was: the room still has a member, and the
    // credential an operator would put the harness back on still works.
    expect(await roomMembers(roomId, oldMxid)).toContain(oldMxid);
    expect(await accountIsActive(oldMxid)).toBe(true);
    expect(await identitiesFor(AGENT_PRINCIPAL)).toEqual([]);
  });

  test("a gate for a station mid-move lands in the room, as the identity that holds it", async () => {
    // Fix round 1's third Important. This used to assert `sent` against
    // recorders that accept any user id, while explaining it with "both
    // identities are in the room, so a gate still lands" — a claim the test
    // could not see, in exactly the fake shape that let three defects through
    // on 2026-08-31. It sends for real now: a real room, mid-move, with the
    // hub choosing the speaker itself. If it chose an mxid that is not in the
    // room the homeserver refuses and this throws, which is the whole point.
    const { roomId, oldMxid } = await stationMidFleet("gate");
    await preJoinNewIdentity(STATION, deps());
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    await mintCredentialAuthorization(STATION);

    const cardId = `crd_${RUN}_gate`;
    const gateId = `gate_${RUN}_gate`;
    await dispatched(cardId);

    const sent: Array<{ userId: string; roomId: string }> = [];
    const outcome = await projectGate(TENANT, delivery(gateId, cardId), {
      domain: DOMAIN,
      sendText: async (userId: string, room: string, body: string) => {
        sent.push({ userId, roomId: room });
        return client!.sendText(userId, room, body);
      },
      sendCustomEvent: async (
        userId: string,
        room: string,
        eventType: string,
        content: Record<string, unknown>
      ) => {
        sent.push({ userId, roomId: room });
        return client!.sendCustomEvent(userId, room, eventType, content);
      },
    });

    // Sent, by a homeserver that would have refused an mxid the room does not
    // contain — so the gate genuinely landed, as the identity the harness
    // actually holds. What must NOT happen is a move reading as `no-speaker`,
    // which is the signature of a broken station and what the sweep counts as
    // stuck.
    expect(outcome.status).toBe("sent");
    expect(sent.every((x) => x.userId === oldMxid && x.roomId === roomId)).toBe(true);
    expect(await moveInProgress(STATION)).toBe(true);
  });

  test("a station answering as an mxid its room does not contain is not silent", async () => {
    // Fix round 2, and the state this slice itself can create: converged on
    // paper — `matrix_id` IS `bridge_matrix_id`, so `moveState` says
    // `converged` and `stationSpeaker` is non-null — while the room contains
    // only the old identity. Every existing signal reads healthy here:
    // `no-speaker` cannot happen, the send 403s, and `projectGate` used to
    // throw with its claim already taken, after which every later pass
    // answered `already` — the one status the sweep treats as the healthy
    // answer and deliberately does not warn on. A person waiting on an
    // approval, and a fleet reporting nothing wrong.
    const { roomId, oldMxid } = await stationMidFleet("mute");
    await rawSql`UPDATE stations SET matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
    expect(await roomMembers(roomId, oldMxid)).not.toContain(NEW_MXID);
    expect((await moveState(STATION)).status).toBe("converged");

    const cardId = `crd_${RUN}_mute`;
    const gateId = `gate_${RUN}_mute`;
    await dispatched(cardId);
    const project = () =>
      projectGate(TENANT, delivery(gateId, cardId), {
        domain: DOMAIN,
        sendText: (u: string, r: string, b: string) => client!.sendText(u, r, b),
        sendCustomEvent: (u: string, r: string, t: string, c: Record<string, unknown>) =>
          client!.sendCustomEvent(u, r, t, c),
      });

    // The homeserver is the one refusing here, not a fake: the speaker is not
    // a member, so the send cannot land.
    await expect(project()).rejects.toThrow(/M_FORBIDDEN/);

    // The claim went back, so this gate is still deliverable the moment
    // somebody puts the identity in the room.
    const claims = await rawSql`SELECT gate_id FROM matrix_gate_events WHERE gate_id = ${gateId}`;
    expect(claims.length, "the claim was released rather than left at pending:<gateId>").toBe(0);

    // And the next pass fails the same way rather than answering `already`,
    // which is what made this invisible.
    await expect(project()).rejects.toThrow(/M_FORBIDDEN/);
  });
});

// ─── Refusing rather than guessing, and what a move looks like ───────────────

describe("a station whose room choice is ambiguous refuses the move", () => {
  test("two unbound rooms is a refusal, not a pick", async () => {
    // `matrix_rooms.station_id` is no longer unique. Guessing which room to
    // move is what migration `0062` refuses to do, and this refuses for the
    // same reason: the wrong guess puts an agent's new identity in a departed
    // occupant's room and leaves its own room without it — silently.
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`
      INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
      VALUES (${"!amb-a-" + RUN}, ${TENANT}, ${STATION}, ${"#amb-a-" + RUN}, now() - interval '2 days'),
             (${"!amb-b-" + RUN}, ${TENANT}, ${STATION}, ${"#amb-b-" + RUN}, now() - interval '1 day')`;
    await rawSql`
      UPDATE stations SET matrix_id = ${"@agent_old_" + RUN + ":" + DOMAIN},
                          bridge_matrix_id = ${NEW_MXID},
                          matrix_identity_mode = 'harness'
       WHERE id = ${STATION}`;

    // A client that would throw if it were touched at all: the refusal has to
    // happen before anything reaches a homeserver.
    const refuse = () => {
      throw new Error("the move touched the homeserver despite an ambiguous room");
    };
    const outcome = await preJoinNewIdentity(STATION, {
      domain: DOMAIN,
      client: {
        invite: async () => refuse(),
        join: async () => refuse(),
        leave: async () => refuse(),
        isJoined: async () => refuse(),
        retireAccount: async () => refuse(),
      },
    });

    expect(outcome.status).toBe("ambiguous-room");
    expect(outcome).toHaveProperty("candidates");
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
  });

  test("but retirement still records the identity and revokes its credential", async () => {
    // Fix round 1's Minor. An ambiguous room set says only that this cannot
    // choose which room the old identity should LEAVE. Recording who it was —
    // the thing that keeps a room's history attributable — and revoking its
    // credential need no room at all, and refusing them over a question about
    // somewhere else left an unattributable history and a live credential on
    // a node. No membership is asserted here, so no homeserver is involved.
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${AGENT_PRINCIPAL}`;
    await rawSql`
      INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
      VALUES (${"!amb2-a-" + RUN}, ${TENANT}, ${STATION}, ${"#amb2-a-" + RUN}, now() - interval '2 days'),
             (${"!amb2-b-" + RUN}, ${TENANT}, ${STATION}, ${"#amb2-b-" + RUN}, now() - interval '1 day')`;
    const stale = `@agent_stale_${RUN}:${DOMAIN}`;
    await rawSql`
      UPDATE stations SET matrix_id = ${NEW_MXID}, bridge_matrix_id = ${NEW_MXID},
                          matrix_identity_mode = 'harness'
       WHERE id = ${STATION}`;

    const revoked: string[] = [];
    const outcome = await retireOldIdentity(STATION, stale, {
      domain: DOMAIN,
      client: {
        invite: async () => {
          throw new Error("unreachable");
        },
        join: async () => {
          throw new Error("unreachable");
        },
        leave: async () => {
          throw new Error("left a room it had refused to choose");
        },
        isJoined: async () => {
          throw new Error("asked about membership in a room it had refused to choose");
        },
        retireAccount: async (userId: string) => {
          revoked.push(userId);
          return { credentialsRevoked: true, accountDeactivated: false };
        },
      },
    });

    expect(outcome).toMatchObject({ status: "retired", roomId: null, left: false, recorded: true });
    expect(revoked).toEqual([stale]);
    expect(await identitiesFor(AGENT_PRINCIPAL)).toContainEqual({
      system: "matrix",
      externalId: stale,
    });

    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${AGENT_PRINCIPAL}`;
  });
});

describe("what a station mid-move looks like", () => {
  test("a station between authorisation and convergence is waiting, not broken", async () => {
    // Ruling 9: the operator's feedback is asynchronous by design, so this
    // state has to be DERIVABLE — it is what the console renders, and what
    // was missing on 2026-08-31 when nothing could answer "how far has this
    // got". Derived from two existing columns and the authorisation record;
    // there is no "moving" flag to go stale.
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    await rawSql`
      UPDATE stations SET matrix_id = ${"@agent_old_" + RUN + ":" + DOMAIN},
                          bridge_matrix_id = ${NEW_MXID},
                          matrix_identity_mode = 'harness'
       WHERE id = ${STATION}`;

    // Nobody has asked for a move: this is the fleet's condition for all 14
    // harness stations today. A thing to do, not a fault.
    expect((await moveState(STATION)).status).toBe("retired-identity");

    await mintCredentialAuthorization(STATION);
    expect((await moveState(STATION)).status).toBe("waiting");

    // An authorisation that expires unredeemed is §4's "nothing happened",
    // and the station drops back to the state an operator authorises from —
    // which is what keeps re-authorising available as the retry.
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    await mintCredentialAuthorization(STATION, { ttlMs: -1 });
    expect((await moveState(STATION)).status).toBe("retired-identity");

    // And convergence ends the move without anything having to say so.
    await rawSql`UPDATE stations SET matrix_id = ${NEW_MXID} WHERE id = ${STATION}`;
    expect((await moveState(STATION)).status).toBe("converged");
    expect(await moveInProgress(STATION)).toBe(false);
  });

  test("a stalled move stays `waiting` forever, but stops being excused past 15 minutes", async () => {
    // Ruling 19 (parked finding 16). The happy path now exits via
    // `converged`, so a REDEEMED authorization that never converges only
    // happens when something is genuinely broken (a harness that never
    // restarted, a write to a profile the reader can't see). `moveState`
    // must keep saying `waiting` — that visibility in the console is the
    // whole point of §6 — but `moveInProgress`, which `gates.ts` reads to
    // EXCUSE a fault as "mid-move", must stop excusing it once a harness
    // restart plus a detect (comfortably under a minute) has had 15 minutes
    // to happen and plainly hasn't.
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    const oldMxid = "@agent_old_" + RUN + ":" + DOMAIN;
    await rawSql`
      UPDATE stations SET matrix_id = ${oldMxid},
                          bridge_matrix_id = ${NEW_MXID},
                          matrix_identity_mode = 'harness'
       WHERE id = ${STATION}`;
    await mintCredentialAuthorization(STATION);
    expect(await redeemCredentialAuthorization(STATION)).toBe(true);

    // Redeemed 5 minutes ago: well within the bound, still excused.
    await rawSql`
      UPDATE matrix_credential_authorizations SET used_at = now() - interval '5 minutes'
       WHERE station_id = ${STATION}`;
    expect((await moveState(STATION)).status).toBe("waiting");
    expect(await moveInProgress(STATION)).toBe(true);

    // Redeemed 20 minutes ago: past the bound. `moveState` still reports
    // `waiting` — nothing about the console's view changed — but the sweep
    // must stop treating this station's later faults as excused by a move.
    await rawSql`
      UPDATE matrix_credential_authorizations SET used_at = now() - interval '20 minutes'
       WHERE station_id = ${STATION}`;
    expect((await moveState(STATION)).status).toBe("waiting");
    expect(await moveInProgress(STATION)).toBe(false);

    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
  });

  test("a gate that finds no room is attributed to the move, exactly as no-agent and no-speaker are", async () => {
    // Spec §6 names `no-room` alongside `no-speaker` as an outcome that must
    // be attributable to a move; only `no-agent` and `no-speaker` carried
    // `midMove`. A station whose room set changes while its identity is
    // moving lands here, and the sweep's stuck-gate line could not tell that
    // from a broken station — which is the noise §6 asks it to avoid.
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${STATION}`;
    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
    await rawSql`
      UPDATE stations SET matrix_id = ${"@agent_old_" + RUN + ":" + DOMAIN},
                          bridge_matrix_id = ${NEW_MXID},
                          matrix_identity_mode = 'harness'
       WHERE id = ${STATION}`;

    const cardId = `crd_${RUN}_noroom`;
    await dispatched(cardId);

    // Nothing may be sent on this path — there is nowhere to send it — so a
    // deps object that throws proves the outcome is reached before any client
    // call rather than after a swallowed one.
    const noSend = {
      domain: DOMAIN,
      sendText: async () => {
        throw new Error("nothing may be sent when there is no room");
      },
      sendCustomEvent: async () => {
        throw new Error("nothing may be sent when there is no room");
      },
    };

    // Nobody has authorised anything: this is an ordinary missing room.
    expect(await projectGate(TENANT, delivery(`gate_${RUN}_noroom_a`, cardId), noSend)).toEqual({
      status: "no-room",
      midMove: false,
    });

    await mintCredentialAuthorization(STATION);
    expect(await projectGate(TENANT, delivery(`gate_${RUN}_noroom_b`, cardId), noSend)).toEqual({
      status: "no-room",
      midMove: true,
    });

    // A card this fleet never dispatched has no station behind it, so there is
    // nothing to ask — and `midMove` is absent rather than a false `false`,
    // which would claim an attribution nobody made.
    expect(
      await projectGate(TENANT, delivery(`gate_${RUN}_noroom_c`, `crd_${RUN}_never`), noSend)
    ).toEqual({ status: "no-room" });

    await rawSql`DELETE FROM matrix_credential_authorizations WHERE station_id = ${STATION}`;
  });
});
