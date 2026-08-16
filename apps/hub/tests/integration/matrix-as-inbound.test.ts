import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { setGrant, deleteGrant } from "../../src/services/grants";
import { handleRoomMessage } from "../../src/services/matrix-as/inbound";
import {
  clearPendingPermission,
  notePendingPermission,
  pendingPermissionFor,
} from "../../src/services/matrix-as/permissions";

/**
 * Where a Matrix message becomes work.
 *
 * This is what the identity work was for: an inbound message is an
 * authorization question the suite can already answer — `resolveMatrixId` gives
 * a principal, the control pair says whether that principal may dispatch this
 * agent.
 *
 * A room is not a console session. It is a shared space that several people can
 * type into, so the grant is checked **per message**, not once when the session
 * was created. Otherwise the first permitted person to speak would open a
 * session everyone else could then drive.
 */

const OWNER = "test-user-mx-inbound";
const OTHER = "test-user-mx-inbound-other";
const NODE = "node_mx_inbound";
const STATION = "station_mx_inbound";
const ROOM = "!inbound:id.agentpod.dev";
const DOMAIN = "id.agentpod.dev";
const OWNER_MXID = "@owner-inbound:id.agentpod.dev";
const OTHER_MXID = "@other-inbound:id.agentpod.dev";

let sent: Array<{ roomId: string; body: string }> = [];
let created: Array<{ stationId: string; userId: string }> = [];
let prompts: Array<{ sessionId: string; text: string; userId: string }> = [];
let sessionCounter = 0;
let createFails: Error | null = null;
let attached: Array<{ sessionId: string; roomId: string; agentUser: string }> = [];

function deps() {
  return {
    domain: DOMAIN,
    client: {
      sendText: async (_userId: string, roomId: string, body: string) => {
        sent.push({ roomId, body });
        return "$evt";
      },
    },
    acp: {
      createSession: async (input: { stationId: string; userId: string }) => {
        if (createFails) throw createFails;
        created.push(input);
        // A real createSession writes a row, and the bridge reads that row's
        // status to decide whether the session is still usable. A fake that
        // returned only an id would make every session look already-gone.
        const id = `acps_mx_inbound_${++sessionCounter}`;
        await rawSql`DELETE FROM acp_sessions WHERE id = ${id}`;
        await rawSql`
          INSERT INTO acp_sessions (id, tenant_id, station_id, user_id, mode, status, last_seq, created_at, last_event_at)
          VALUES (${id}, (SELECT tenant_id FROM stations WHERE id = ${input.stationId}),
                  ${input.stationId}, ${input.userId}, 'default', 'idle', 0, now(), now())`;
        return { id };
      },
      promptSession: async (userId: string, sessionId: string, text: string) => {
        prompts.push({ userId, sessionId, text });
      },
    },
    attach: (sessionId: string, roomId: string, agentUser: string) => {
      attached.push({ sessionId, roomId, agentUser });
    },
  };
}

/** `deps()` plus the ability to answer a parked permission request. */
function depsWithPermissions() {
  const base = deps();
  return {
    ...base,
    acp: {
      ...base.acp,
      answerPermission: async (
        userId: string,
        sessionId: string,
        requestSeq: number,
        optionId: string
      ) => {
        if (answerFails) throw answerFails;
        answered.push({ userId, sessionId, requestSeq, optionId });
      },
    },
  };
}

let answered: Array<{
  userId: string;
  sessionId: string;
  requestSeq: number;
  optionId: string;
}> = [];
let answerFails: Error | null = null;

function message(sender: string, body: string, roomId = ROOM) {
  return {
    type: "m.room.message",
    sender,
    room_id: roomId,
    event_id: `$${Math.random().toString(36).slice(2)}`,
    content: { msgtype: "m.text", body },
  };
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "mx-inbound@example.com", name: "Owner" });
  await createTestUser({ id: OTHER, email: "mx-inbound-other@example.com", name: "Other" });
  const tenant = await resolveTenantForUser(OWNER);

  await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'inbound-box', 'inbound-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', 'openclaw:krishna', 'leaf', 'krishna',
            '["acp"]'::jsonb, now(), now())`;

  // Both principals are known to this hub by their Matrix ids.
  for (const [p, mxid] of [[OWNER, OWNER_MXID], [OTHER, OTHER_MXID]] as const) {
    await rawSql`DELETE FROM principal_identities WHERE principal_id = ${p}`;
    await rawSql`
      INSERT INTO principal_identities (id, principal_id, system, external_id, created_at)
      VALUES (${`pid_${p}`}, ${p}, 'matrix', ${mxid}, now())`;
  }

  process.env.ENFORCE_CONTROL_PAIR = "true";
});

beforeEach(async () => {
  answered = [];
  answerFails = null;
  clearPendingPermission(ROOM);
  sent = [];
  created = [];
  prompts = [];
  attached = [];
  createFails = null;
  await rawSql`DELETE FROM acp_sessions WHERE id LIKE 'acps_mx_inbound_%'`;
  await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
  await rawSql`
    INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
    VALUES (${ROOM}, (SELECT tenant_id FROM stations WHERE id = ${STATION}), ${STATION},
            '#agentpod_inbound-box_openclaw-krishna:id.agentpod.dev', now())`;
  await rawSql`UPDATE stations SET matrix_identity_mode = 'bridge' WHERE id = ${STATION}`;
});

afterAll(async () => {
  delete process.env.ENFORCE_CONTROL_PAIR;
  try {
    await rawSql`DELETE FROM acp_sessions WHERE id LIKE 'acps_mx_inbound_%'`;
    await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
    await rawSql`DELETE FROM principal_identities WHERE principal_id IN (${OWNER}, ${OTHER})`;
    await rawSql`DELETE FROM principal_grants WHERE principal_id IN (${OWNER}, ${OTHER})`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id IN (${OWNER}, ${OTHER})`;
  } catch {
    // cleanup only
  }
});

describe("an inbound room message", () => {
  test("prompts the station when the sender's grant covers it", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(created).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toBe("status?");
  });

  test("attaches the room to the session, or the answer has nowhere to go", async () => {
    // The gap that live verification found: a session was created and prompted
    // and the agent answered into a stream nobody was listening to. Both halves
    // had tests; the joint did not.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(attached).toHaveLength(1);
    expect(attached[0]!.roomId).toBe(ROOM);
    expect(attached[0]!.agentUser).toBe("@agent_inbound-box_openclaw-krishna:id.agentpod.dev");
    expect(attached[0]!.sessionId).toBe(prompts[0]!.sessionId);
  });

  test("attaches again when reusing an existing session, because a restart forgets", async () => {
    // Attachments live in memory. After a hub restart the session row survives
    // and the listener does not, so a room whose session predates the restart
    // would go permanently quiet.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    await handleRoomMessage(message(OWNER_MXID, "second"), deps());

    expect(created).toHaveLength(1);
    expect(attached).toHaveLength(2);
  });

  test("does not attach when the message was refused", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(attached).toHaveLength(0);
  });

  test("refuses IN THE ROOM when the grant does not cover this station", async () => {
    // Silence would read as a broken agent and send the operator to the console,
    // the node and the harness — everywhere except the grant.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/hermes:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/not permitted|may not|permission/i);
  });

  test("checks every message, not only the one that opened the session", async () => {
    // A room is shared. Without a per-message check, the first permitted person
    // to speak would open a session that everyone else in the room could drive.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });
    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    expect(prompts).toHaveLength(1);

    await deleteGrant(OTHER);
    await handleRoomMessage(message(OTHER_MXID, "and me"), deps());

    expect(prompts).toHaveLength(1);
    expect(sent.at(-1)!.body).toMatch(/not permitted|may not|permission/i);
  });

  test("refuses a sender this hub cannot identify", async () => {
    await handleRoomMessage(message("@stranger:id.agentpod.dev", "hello"), deps());

    expect(prompts).toHaveLength(0);
    expect(sent[0]!.body).toMatch(/do not recognise|not linked|unknown/i);
  });

  test("reuses the room's session instead of starting one per message", async () => {
    // A conversation is a conversation. One session per message would throw away
    // the agent's context between two consecutive sentences.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    await handleRoomMessage(message(OWNER_MXID, "second"), deps());

    expect(created).toHaveLength(1);
    expect(prompts.map((p) => p.text)).toEqual(["first", "second"]);
  });

  test("starts a new session when the room's one has ended", async () => {
    // Boot reconciliation ends every live session with 'hub restarted'. Without
    // this the room keeps prompting a corpse and every bridged room dies
    // permanently at the first restart — the agent simply stops answering, with
    // 'Session not found or not active' as the only clue.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });
    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    const dead = prompts[0]!.sessionId;

    await rawSql`
      UPDATE acp_sessions SET status = 'ended', ended_reason = 'hub restarted' WHERE id = ${dead}`;

    await handleRoomMessage(message(OWNER_MXID, "second"), deps());

    expect(created).toHaveLength(2);
    expect(prompts[1]!.sessionId).not.toBe(dead);
  });

  test("says so when the station cannot be reached, rather than swallowing it", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });
    createFails = new Error("node offline");

    await handleRoomMessage(message(OWNER_MXID, "hi"), deps());

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/offline|could not/i);
  });

  test("ignores a message in a room that maps to no station", async () => {
    // Someone can invite the bridge bot anywhere. A room we do not own is not
    // ours to answer in.
    await handleRoomMessage(message(OWNER_MXID, "hi", "!elsewhere:id.agentpod.dev"), deps());

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("stays out of a harness-mode station's room entirely", async () => {
    // That station answers for itself. Two answerers on one address is the
    // failure the mode exists to prevent.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });
    await rawSql`UPDATE stations SET matrix_identity_mode = 'harness' WHERE id = ${STATION}`;

    await handleRoomMessage(message(OWNER_MXID, "hi"), deps());

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("ignores anything that is not a text message", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(
      { type: "m.room.member", sender: OWNER_MXID, room_id: ROOM, content: { membership: "join" } },
      deps()
    );

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("ignores an empty message rather than prompting with nothing", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "   "), deps());

    expect(prompts).toHaveLength(0);
  });

  test("passes the message through unchanged, including its exact text", async () => {
    // The prompt is the user's words. Trimming, prefixing or decorating them
    // would put the bridge's voice into the agent's input.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "deploy  the thing\nnow"), deps());

    expect(prompts[0]!.text).toBe("deploy  the thing\nnow");
  });

  test("prompts as the principal who sent it, not as the station's owner", async () => {
    // The ACP session belongs to whoever is talking, so the transcript and the
    // control pair both attribute the turn correctly.
    await setGrant(OTHER, { mayDispatch: ["agentpod:*/openclaw:*"], mayGrantReach: false });

    await handleRoomMessage(message(OTHER_MXID, "hello"), deps());

    expect(created[0]!.userId).toBe(OTHER);
  });
});

describe("answering a permission request from the room", () => {
  const OPTIONS = [
    { optionId: "allow_once", name: "Allow once" },
    { optionId: "reject", name: "Reject" },
  ];

  const parkOn = (sessionId = "acps_parked") =>
    notePendingPermission(ROOM, { sessionId, requestSeq: 7, options: OPTIONS });

  test("a number answers it, and nothing is prompted", async () => {
    // While a permission is pending the session is PARKED — it cannot take a
    // prompt. Treating the answer as a message would lose the answer and fail
    // the prompt in the same breath.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/*"], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(answered).toEqual([
      { userId: OWNER, sessionId: "acps_parked", requestSeq: 7, optionId: "allow_once" },
    ]);
    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  test("the option's name answers it too", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/*"], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "Reject"), depsWithPermissions());

    expect(answered[0]!.optionId).toBe("reject");
  });

  test("a reply that is not an option approves nothing and says so", async () => {
    // "yes" against options named "Allow once" and "Allow always" does not say
    // which. Resolving it to the nearest-looking one is the failure this must
    // never have.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/*"], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "yes go ahead"), depsWithPermissions());

    expect(answered).toEqual([]);
    expect(sent.at(-1)!.body).toMatch(/nothing has been approved/i);
    // …and the question still stands, so the next reply can answer it.
    expect(pendingPermissionFor(ROOM)).toBeDefined();
  });

  test("someone who may not dispatch the agent may not approve for it either", async () => {
    // Approving an action IS dispatching the agent, by another name.
    await setGrant(OWNER, { mayDispatch: ["agentpod:other/*"], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(answered).toEqual([]);
    expect(sent.at(-1)!.body).toMatch(/not permitted/i);
  });

  test("a refused answer leaves the question standing", async () => {
    // A cleared question plus a failed answer would park the agent forever
    // with nothing able to release it.
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/*"], mayGrantReach: false });
    parkOn();
    answerFails = new Error("No pending permission request.");

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(pendingPermissionFor(ROOM)).toBeDefined();
    expect(sent.at(-1)!.body).toMatch(/could not record that answer/i);
  });

  test("an ordinary message is still an ordinary message when nothing is pending", async () => {
    await setGrant(OWNER, { mayDispatch: ["agentpod:*/*"], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(answered).toEqual([]);
    expect(prompts.at(-1)!.text).toBe("1");
  });
});
