import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { setGrant } from "../../src/auth/org-plane/grants";
import { createPrincipal, forgetPrincipals, linkMatrixId, clearGrant } from "../helpers/principals";
import { handleRoomMessage } from "../../src/services/matrix-as/inbound";
import { SESSION_BUSY_MESSAGE } from "../../src/services/acp/sessions";
import { pollUntil } from "../helpers/wait";
import { setOrgPlaneForTests, TEST_PLANE } from "../../src/auth/org-plane/config";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "../../src/auth/org-plane/directory";
import { OrgPlaneError } from "../../src/auth/org-plane/client";
import {
  clearPendingPermission,
  notePendingPermission,
  pendingPermissionFor,
} from "../../src/services/matrix-as/permissions";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { harnessPermission } from "../../src/services/matrix-as/permission-wire";
import { notePermissionEvent, permissionRecord, recordPermissionRequest } from "../../src/services/matrix-as/permission-records";
import { answerTypedPermission, settleFromSessionEvent } from "../../src/services/matrix-as/permission-answer";

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

let OWNER_PRINCIPAL: string;
let OTHER_PRINCIPAL: string;
/** The agent occupying STATION — the matcher compares a grant against this now. */
let AGENT_PRINCIPAL: string;
/** Some other agent, granted where a test wants to prove the scope check is real. */
const OTHER_AGENT = "prn_ffffffffffffffffffff";

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
        optionId: string,
        by?: unknown
      ) => {
        if (answerFails) throw answerFails;
        answered.push({ userId, sessionId, requestSeq, optionId });
        answeredBy.push(by);
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
let answeredBy: unknown[] = [];

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
  const tenant = BOOTSTRAP_TENANT_ID;

  await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
  await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'inbound-box', 'inbound-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  OWNER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "mx-inbound-it-owner", userId: OWNER });
  OTHER_PRINCIPAL = await createPrincipal({ kind: "human", handle: "mx-inbound-it-other", userId: OTHER });
  AGENT_PRINCIPAL = await createPrincipal({ kind: "agent", handle: "mx-inbound-it-agent" });

  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', 'openclaw:krishna', 'leaf', 'krishna',
            '["acp"]'::jsonb, ${AGENT_PRINCIPAL}, now(), now())`;

  // Both people are linked to their Matrix ids at the plane.
  for (const [p, mxid] of [[OWNER_PRINCIPAL, OWNER_MXID], [OTHER_PRINCIPAL, OTHER_MXID]] as const) {
    await linkMatrixId(p, mxid);
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
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await forgetPrincipals({ handles: ["mx-inbound-it-owner", "mx-inbound-it-other", "mx-inbound-it-agent"] });
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await deleteTestUsers([OWNER, OTHER]);
  } catch {
    // cleanup only
  }
});

describe("an inbound room message", () => {
  test("prompts the station when the sender's grant covers it", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(created).toHaveLength(1);
    // The station is scoped on `stations.user_id`. Asserting only that A
    // session was created is what once let the bridge pass the wrong id here
    // and fail on every real room. (Since the org-plane cutover a user id IS
    // the person's prn_, so the two ids this used to tell apart are one.)
    expect(created[0]!.userId).toBe(OWNER);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toBe("status?");
    // `promptSession` scopes on the session's user the same way the station
    // lookup does. The fake recorded this id from the beginning and nothing
    // asserted it, so the bridge could create a session correctly and then be
    // unable to prompt it.
    expect(prompts[0]!.userId).toBe(OWNER);
  });


  test("attaches the room to the session, or the answer has nowhere to go", async () => {
    // The gap that live verification found: a session was created and prompted
    // and the agent answered into a stream nobody was listening to. Both halves
    // had tests; the joint did not.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(attached).toHaveLength(1);
    expect(attached[0]!.roomId).toBe(ROOM);
    // Built from the occupying agent's principal handle now, not from where
    // the station runs.
    expect(attached[0]!.agentUser).toBe("@agent_mx-inbound-it-agent:id.agentpod.dev");
    expect(attached[0]!.sessionId).toBe(prompts[0]!.sessionId);
  });

  test("attaches again when reusing an existing session, because a restart forgets", async () => {
    // Attachments live in memory. After a hub restart the session row survives
    // and the listener does not, so a room whose session predates the restart
    // would go permanently quiet.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    await handleRoomMessage(message(OWNER_MXID, "second"), deps());

    expect(created).toHaveLength(1);
    expect(attached).toHaveLength(2);
  });

  test("does not attach when the message was refused", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(attached).toHaveLength(0);
  });

  test("refuses IN THE ROOM when the grant does not cover this station", async () => {
    // Silence would read as a broken agent and send the operator to the console,
    // the node and the harness — everywhere except the grant.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "status?"), deps());

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/not permitted|may not|permission/i);
  });

  test("checks every message, not only the one that opened the session", async () => {
    // A room is shared. Without a per-message check, the first permitted person
    // to speak would open a session that everyone else in the room could drive.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    expect(prompts).toHaveLength(1);

    clearGrant(OTHER_PRINCIPAL);
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
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

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
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    await handleRoomMessage(message(OWNER_MXID, "first"), deps());
    const dead = prompts[0]!.sessionId;

    await rawSql`
      UPDATE acp_sessions SET status = 'ended', ended_reason = 'hub restarted' WHERE id = ${dead}`;

    await handleRoomMessage(message(OWNER_MXID, "second"), deps());

    expect(created).toHaveLength(2);
    expect(prompts[1]!.sessionId).not.toBe(dead);
  });

  test("says so when the station cannot be reached, rather than swallowing it", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
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
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    await rawSql`UPDATE stations SET matrix_identity_mode = 'harness' WHERE id = ${STATION}`;

    await handleRoomMessage(message(OWNER_MXID, "hi"), deps());

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("ignores anything that is not a text message", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(
      { type: "m.room.member", sender: OWNER_MXID, room_id: ROOM, content: { membership: "join" } },
      deps()
    );

    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("ignores an empty message rather than prompting with nothing", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "   "), deps());

    expect(prompts).toHaveLength(0);
  });

  test("passes the message through unchanged, including its exact text", async () => {
    // The prompt is the user's words. Trimming, prefixing or decorating them
    // would put the bridge's voice into the agent's input.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "deploy  the thing\nnow"), deps());

    expect(prompts[0]!.text).toBe("deploy  the thing\nnow");
  });

  test("opens the session as the station's OWNER, even when another principal sent it", async () => {
    // This test used to assert the opposite — that the session is opened as the
    // sending principal, "so the transcript and the control pair both attribute
    // the turn correctly". The intent was right and the mechanism was not:
    // `createSession` resolves the station with `getStation(userId, stationId)`,
    // which scopes on `stations.user_id`. A `prn_…` matches no row there, so in
    // production EVERY bridged room answered "Station not found." for a message
    // the hub had already received, resolved and authorised. The fake here
    // accepted any id, which is why the suite stayed green while no real room
    // worked.
    //
    // Authorisation is still the principal's: OTHER_PRINCIPAL dispatches this
    // station on a grant, and is not its owner. Only the station LOOKUP uses
    // the owner.
    //
    // What is genuinely lost is attribution — `acp_sessions.user_id` no longer
    // records which principal asked. That needs its own column rather than this
    // one serving two masters, and it is written down as a gap, not fixed here.
    await setGrant(OTHER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OTHER_MXID, "hello"), deps());

    expect(created[0]!.userId).toBe(OWNER);
    expect(created[0]!.userId).not.toBe(OTHER_PRINCIPAL);
  });
});

let transcriptKeys: unknown[] = [];

describe("a voice note", () => {
  function voice(sender: string, extra: Record<string, unknown> = {}) {
    return {
      type: "m.room.message",
      sender,
      room_id: ROOM,
      event_id: "$voice1",
      content: {
        msgtype: "m.audio",
        body: "Voice message.m4a",
        url: "mxc://id.agentpod.dev/voice1",
        info: { mimetype: "audio/mp4", duration: 42_000 },
        ...extra,
      },
    };
  }

  /** `deps()` with media, notices and a transcriber that hears `heard`. */
  function voiceDeps(heard: string | Error) {
    const base = deps();
    const notices: Array<{ body: string; replyTo: string | null }> = [];
    transcriptKeys = [];
    return {
      notices,
      deps: {
        ...base,
        client: {
          ...base.client,
          downloadMedia: async () => new Uint8Array([1, 2, 3]),
          sendCustomEvent: async (_u: string, _r: string, _t: string, content: Record<string, unknown>) => {
            const rel = content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string } } | undefined;
            notices.push({ body: String(content.body), replyTo: rel?.["m.in_reply_to"]?.event_id ?? null });
            if (content["dev.agentpod.voice_transcript"]) transcriptKeys.push(content["dev.agentpod.voice_transcript"]);
            return "$notice";
          },
        },
        transcriber: {
          transcribe: async () => {
            if (heard instanceof Error) throw heard;
            return { text: heard, language: "en" };
          },
        },
      },
    };
  }

  test("is transcribed: the agent gets the words, and the room gets the transcript under the note", async () => {
    // The 2026-09-24 report: a voice note reached Krishna as its file name.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d, notices } = voiceDeps("send the report by Friday");

    await handleRoomMessage(voice(OWNER_MXID), d);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toBe("[Voice note, 0:42, transcribed] send the report by Friday");
    expect(prompts[0]!.text).not.toContain("Voice message.m4a");
    expect(notices).toEqual([{ body: "Transcript: send the report by Friday", replyTo: "$voice1" }]);
    expect(transcriptKeys).toEqual([{ schema_version: 1, text: "send the report by Friday", language: "en", seconds: 42 }]);
  });

  test("one that cannot be transcribed still reaches the agent, with the reason, and the room is told", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d, notices } = voiceDeps(new Error("the transcription service answered 503"));

    await handleRoomMessage(voice(OWNER_MXID), d);

    expect(prompts[0]!.text).toBe(
      "[The user sent a voice note, Voice message.m4a, but the transcription service answered 503.]"
    );
    expect(notices[0]!.body).toBe("I could not transcribe this voice note: the transcription service answered 503.");
  });

  test("over five minutes is not transcribed", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d } = voiceDeps("never heard");

    await handleRoomMessage(voice(OWNER_MXID, { info: { mimetype: "audio/mp4", duration: 301_000 } }), d);

    expect(prompts[0]!.text).toContain("it is longer than 5 minutes");
    expect(prompts[0]!.text).not.toContain("never heard");
  });

  test("the service is looked up per voice note, for the room's station, with that station's limit", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d } = voiceDeps("never used");
    const askedFor: string[] = [];
    const heardBy: string[] = [];
    const withLookup = {
      ...d,
      transcriber: undefined,
      transcriberFor: async (stationId: string) => {
        askedFor.push(stationId);
        return {
          transcriber: {
            transcribe: async () => {
              heardBy.push(stationId);
              return { text: "from the station's own service", language: "en" };
            },
          },
          maxSeconds: 30,
        };
      },
    };

    await handleRoomMessage(voice(OWNER_MXID), withLookup);
    // 42 s is over this station's 30 s limit: named, not heard.
    expect(askedFor).toEqual([STATION]);
    expect(heardBy).toEqual([]);
    expect(prompts[0]!.text).toContain("it is longer than 30 seconds");

    prompts.length = 0;
    await handleRoomMessage(voice(OWNER_MXID, { info: { mimetype: "audio/mp4", duration: 20_000 } }), withLookup);
    expect(heardBy).toEqual([STATION]);
    expect(prompts[0]!.text).toBe("[Voice note, 0:20, transcribed] from the station's own service");
  });

  test("a station whose lookup answers none is told the hub has no service", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d } = voiceDeps("never used");

    await handleRoomMessage(voice(OWNER_MXID), { ...d, transcriber: undefined, transcriberFor: async () => null });

    expect(prompts[0]!.text).toBe(
      "[The user sent a voice note, Voice message.m4a, but this hub has no transcription service set up.]"
    );
  });

  test("the turn it starts is noted as a voice turn, so a station set to answer voice with voice speaks it", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d } = voiceDeps("send the report by Friday");
    const noted: Array<{ eventId: string; voice: boolean | undefined }> = [];
    const withTrigger = {
      ...d,
      noteTrigger: (_s: string, eventId: string, opts?: { voice?: boolean }) => {
        noted.push({ eventId, voice: opts?.voice });
      },
    };

    await handleRoomMessage(voice(OWNER_MXID), withTrigger);
    // Even one that could not be heard: the user spoke, so the answer may be spoken.
    await handleRoomMessage(voice(OWNER_MXID, { info: { mimetype: "audio/mp4", duration: 999_000 } }), withTrigger);
    await handleRoomMessage(
      { type: "m.room.message", sender: OWNER_MXID, room_id: ROOM, event_id: "$typed", content: { msgtype: "m.text", body: "hi" } },
      withTrigger
    );

    expect(noted).toEqual([
      { eventId: "$voice1", voice: true },
      { eventId: "$voice1", voice: true },
      { eventId: "$typed", voice: false },
    ]);
  });

  test("a lookup that throws is a voice note that cannot be heard, not a lost message", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const { deps: d } = voiceDeps("never used");

    await handleRoomMessage(voice(OWNER_MXID), {
      ...d,
      transcriber: undefined,
      transcriberFor: async () => {
        throw new Error("database unavailable");
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("but its transcription settings could not be read");
  });

  test("a sender who may not dispatch the agent gets no transcription either", async () => {
    // Transcribing is work done as the agent; it follows the same grant.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: false });
    let transcribed = false;
    const { deps: d } = voiceDeps("x");
    d.transcriber = {
      transcribe: async () => {
        transcribed = true;
        return { text: "x", language: "en" };
      },
    };

    await handleRoomMessage(voice(OWNER_MXID), d);

    expect(transcribed).toBe(false);
    expect(prompts).toHaveLength(0);
  });
});

/**
 * A voice note that has to wait. Transcription takes seconds, and the appservice
 * hands the hub a room's events one after another — so on krishna, 2026-09-30,
 * the voice turn ran first and "Hi?" typed a second later waited in the room
 * queue, and was prompted the moment the voice turn went idle. Whatever the
 * order, the voice flag must reach the turn the voice note is in.
 */
describe("a voice note and a typed message in one room, one turn running", () => {
  const VOICE_EVENT = {
    type: "m.room.message",
    sender: OWNER_MXID,
    room_id: ROOM,
    event_id: "$voice-q",
    content: {
      msgtype: "m.audio",
      body: "Voice message.m4a",
      url: "mxc://id.agentpod.dev/voice-q",
      info: { mimetype: "audio/mp4", duration: 4_000 },
    },
  };
  const typed = (eventId: string, body: string) => ({
    type: "m.room.message",
    sender: OWNER_MXID,
    room_id: ROOM,
    event_id: eventId,
    content: { msgtype: "m.text", body },
  });

  /** `deps()` with a session whose turn is running until `finishTurn()`. */
  function queueDeps() {
    const base = deps();
    const noted: Array<{ eventId: string; voice: boolean | undefined }> = [];
    let busy = false;
    let idle: (() => void) | null = null;
    const d = {
      ...base,
      client: {
        ...base.client,
        downloadMedia: async () => new Uint8Array([1, 2, 3]),
        sendCustomEvent: async () => "$notice",
      },
      transcriber: { transcribe: async () => ({ text: "what is the build status", language: "en" }) },
      acp: {
        ...base.acp,
        isBusy: () => busy,
        whenIdle: () =>
          busy ? new Promise<"idle">((resolve) => (idle = () => resolve("idle"))) : Promise.resolve("idle" as const),
      },
      noteTrigger: (_s: string, eventId: string, opts?: { voice?: boolean }) => {
        noted.push({ eventId, voice: opts?.voice });
      },
    };
    return {
      d,
      noted,
      startTurn: () => (busy = true),
      finishTurn: () => {
        busy = false;
        idle?.();
      },
    };
  }

  /** Open the room's session with a first message, then hold a turn open. */
  async function withRunningTurn(q: ReturnType<typeof queueDeps>) {
    await handleRoomMessage(typed("$opening", "hello"), q.d);
    q.startTurn();
    q.noted.length = 0;
    prompts = [];
  }

  test("a voice note queued behind a running turn is noted as a voice turn when it is sent", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const q = queueDeps();
    await withRunningTurn(q);

    await handleRoomMessage(VOICE_EVENT, q.d);
    expect(prompts).toHaveLength(0);
    q.finishTurn();

    await pollUntil(() => prompts.length === 1);
    expect(q.noted).toEqual([{ eventId: "$voice-q", voice: true }]);
  });

  test("voice then typed, both waiting: one turn, a voice turn, marked on the last message", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const q = queueDeps();
    await withRunningTurn(q);

    await handleRoomMessage(VOICE_EVENT, q.d);
    await handleRoomMessage(typed("$hi", "Hi?"), q.d);
    q.finishTurn();

    await pollUntil(() => prompts.length === 1);
    expect(q.noted).toEqual([{ eventId: "$hi", voice: true }]);
    expect(prompts[0]!.text).toContain("what is the build status");
    expect(prompts[0]!.text).toContain("Hi?");
  });

  test("typed then voice, both waiting: still a voice turn", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const q = queueDeps();
    await withRunningTurn(q);

    await handleRoomMessage(typed("$hi", "Hi?"), q.d);
    await handleRoomMessage(VOICE_EVENT, q.d);
    q.finishTurn();

    await pollUntil(() => prompts.length === 1);
    expect(q.noted).toEqual([{ eventId: "$voice-q", voice: true }]);
  });

  test("a prompt that loses the busy race takes its trigger back, and is sent again with it", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    const q = queueDeps();
    await handleRoomMessage(typed("$opening", "hello"), q.d);
    q.noted.length = 0;
    const forgotten: string[] = [];
    let refuse = true;
    const d = {
      ...q.d,
      acp: {
        ...q.d.acp,
        promptSession: async (userId: string, sessionId: string, text: string) => {
          if (refuse) {
            // Another prompt got in between the busy check and this one.
            refuse = false;
            q.startTurn();
            throw new Error(SESSION_BUSY_MESSAGE);
          }
          prompts.push({ userId, sessionId, text });
        },
      },
      forgetTrigger: (_s: string, eventId: string) => {
        forgotten.push(eventId);
      },
    };

    await handleRoomMessage(VOICE_EVENT, d);
    expect(forgotten).toEqual(["$voice-q"]);
    q.finishTurn();

    await pollUntil(() => prompts.length === 2);
    expect(q.noted).toEqual([
      { eventId: "$voice-q", voice: true },
      { eventId: "$voice-q", voice: true },
    ]);
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
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    // The OWNER, not the principal: `answerPermission` resolves the live
    // session with `requireLive(userId, sessionId)`, scoped on a Better Auth
    // id. This assertion named the principal and passed, while in production
    // the same value produced "Session not found or not active."
    expect(answered).toEqual([
      { userId: OWNER, sessionId: "acps_parked", requestSeq: 7, optionId: "allow_once" },
    ]);
    expect(created).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  test("the option's name answers it too", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "Reject"), depsWithPermissions());

    expect(answered[0]!.optionId).toBe("reject");
  });

  test("a reply that is not an option approves nothing and says so", async () => {
    // "yes" against options named "Allow once" and "Allow always" does not say
    // which. Resolving it to the nearest-looking one is the failure this must
    // never have.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "yes go ahead"), depsWithPermissions());

    expect(answered).toEqual([]);
    expect(sent.at(-1)!.body).toMatch(/nothing has been approved/i);
    // …and the question still stands, so the next reply can answer it.
    expect(pendingPermissionFor(ROOM)).toBeDefined();
  });

  test("someone who may not dispatch the agent may not approve for it either", async () => {
    // Approving an action IS dispatching the agent, by another name.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: false });
    parkOn();

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(answered).toEqual([]);
    expect(sent.at(-1)!.body).toMatch(/not permitted/i);
  });

  test("a refused answer leaves the question standing", async () => {
    // A cleared question plus a failed answer would park the agent forever
    // with nothing able to release it.
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
    parkOn();
    answerFails = new Error("No pending permission request.");

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(pendingPermissionFor(ROOM)).toBeDefined();
    expect(sent.at(-1)!.body).toMatch(/could not record that answer/i);
  });

  test("an ordinary message is still an ordinary message when nothing is pending", async () => {
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });

    await handleRoomMessage(message(OWNER_MXID, "1"), depsWithPermissions());

    expect(answered).toEqual([]);
    expect(prompts.at(-1)!.text).toBe("1");
  });
});

/**
 * A plain message in a BOARD room is an answer, not a prompt.
 *
 * A board room has no station — that is the whole point of it: it is spoken by an
 * identity whose keys this hub owns, so it can both encrypt and decrypt there. Until
 * now a message typed into one fell through to the station lookup, found nothing, and
 * was dropped in silence. That is correct for chatter and wrong for the one thing a
 * board room exists to carry back.
 */
describe("a message in a board room", () => {
  const BOARD_ROOM = "!board-inbound:id.agentpod.dev";
  const SPEAKER = "@agent_superpipeline:id.agentpod.dev";

  function withElicitations() {
    const answered: Array<{ sender: string; body: string; roomId: string }> = [];
    const base = deps() as ReturnType<typeof deps> & {
      elicitations?: { handle(e: { sender: string; body: string }, roomId: string): Promise<unknown> };
    };
    base.elicitations = {
      handle: async (e, roomId) => {
        answered.push({ ...e, roomId });
        return { status: "answered" };
      },
    };
    return { deps: base, answered };
  }

  beforeAll(async () => {
    const tenant = await rawSql`SELECT tenant_id FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM matrix_board_rooms WHERE room_id = ${BOARD_ROOM}`;
    await rawSql`
      INSERT INTO matrix_board_rooms (board_id, room_id, tenant_id, speaker_mxid, alias, created_at)
      VALUES ('brd_inbound_test', ${BOARD_ROOM}, ${tenant[0]!.tenant_id}, ${SPEAKER},
              'agentpod_board_brd_inbound_test', now())`;
  });

  test("is offered to the elicitation answerer", async () => {
    const { deps: d, answered } = withElicitations();
    await handleRoomMessage(message(OWNER_MXID, "2", BOARD_ROOM), d);

    expect(answered).toEqual([{ sender: OWNER_MXID, body: "2", roomId: BOARD_ROOM }]);
  });

  test("the board's own voice is never read as an answer", async () => {
    // The hub posts the question AS the speaker, and the appservice hands that message
    // straight back. Without this guard the hub answers its own question the moment it
    // asks it — and the option it "chose" would be whatever its own prose matched.
    const { deps: d, answered } = withElicitations();
    await handleRoomMessage(message(SPEAKER, "1. Run the tests", BOARD_ROOM), d);

    expect(answered).toEqual([]);
  });

  test("a deployment with no board wired up behaves exactly as before", async () => {
    // `elicitations` absent: the message is dropped as it always was, with nothing
    // thrown. This is the path every deployment without a board takes.
    await handleRoomMessage(message(OWNER_MXID, "hello", BOARD_ROOM), deps());
  });
});

describe("an inbound room message under the org plane, while the plane is unreachable", () => {
  // Design §5.7: resolving the sender (and its grant) is the one plane read on this path. A cold
  // cache during an outage is refused with a message that says so — never "I do not recognise you".
  function planeWith(over: Partial<PrincipalDirectory>) {
    const restores = [
      setOrgPlaneForTests(TEST_PLANE),
      setPrincipalDirectoryForTests({
        principal: async (id) =>
          id === AGENT_PRINCIPAL
            ? { id, kind: "agent", handle: "mx-inbound-it-agent", displayName: null, organizationId: null, suspended: false, grant: null }
            : null,
        identity: async (_s, ext) => (ext === OWNER_MXID ? { principalId: OWNER_PRINCIPAL, kind: "human", suspended: false } : null),
        identitiesOf: async () => null,
        list: async () => [],
        invalidate: () => {},
        ...over,
      }),
    ];
    return () => restores.reverse().forEach((r) => r());
  }

  test("a sender that cannot be resolved is told the account service is unreachable, and nothing is prompted", async () => {
    const restore = planeWith({
      identity: async () => {
        throw new OrgPlaneError(0, "unreachable");
      },
    });
    try {
      await handleRoomMessage(message(OWNER_MXID, "status?"), deps());
    } finally {
      restore();
    }
    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("cannot check who you are");
    expect(sent[0]!.body).not.toMatch(/do not recognise/i);
  });

  test("a grant that cannot be read is refused the same way, not read as 'no grant'", async () => {
    const restore = planeWith({
      principal: async (id) => {
        if (id === AGENT_PRINCIPAL) {
          return { id, kind: "agent", handle: "mx-inbound-it-agent", displayName: null, organizationId: null, suspended: false, grant: null };
        }
        throw new OrgPlaneError(503, "error");
      },
    });
    try {
      await handleRoomMessage(message(OWNER_MXID, "status?"), deps());
    } finally {
      restore();
    }
    expect(prompts).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("cannot check who you are");
  });

  test("a resolved sender with a covering grant still prompts", async () => {
    const restore = planeWith({
      principal: async (id) =>
        id === AGENT_PRINCIPAL
          ? { id, kind: "agent", handle: "mx-inbound-it-agent", displayName: null, organizationId: null, suspended: false, grant: null }
          : id === OWNER_PRINCIPAL
            ? { id, kind: "human", handle: "o", displayName: null, organizationId: null, suspended: false, grant: { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false, scopes: [] } }
            : null,
    });
    try {
      await handleRoomMessage(message(OWNER_MXID, "status?"), deps());
    } finally {
      restore();
    }
    expect(prompts).toHaveLength(1);
  });
});

/**
 * permission.v2 — AgentPod judging a harness permission answer (charter: "Strict decisions and
 * harness permissions bind their subject" §5–6). The request is recorded durably with its binding;
 * a permission.answer.v2 is checked for the session, the sequence, the digest, an offered option,
 * still pending and unexpired, and the answerer's grant, and who answered is recorded. A late or
 * stale answer — structured or typed — is refused in the room and never reaches the agent.
 */
describe("permission.v2 answers in a station room", () => {
  const SESSION = "acps_mx_inbound_perm";
  const SEQ = 11;
  const PROSE = "$permission-prose";
  const PAYLOAD = {
    toolCall: { toolCallId: "tc_1", title: "Run the tests", kind: "execute", rawInput: { command: "bun test" } },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  };
  const OPTIONS = PAYLOAD.options.map((o) => ({ optionId: o.optionId, name: o.name }));
  let customs: Array<{ type: string; content: Record<string, unknown> }> = [];
  let digest = "";

  function permDeps() {
    const base = depsWithPermissions();
    return {
      ...base,
      client: {
        ...base.client,
        sendCustomEvent: async (_u: string, roomId: string, type: string, content: Record<string, unknown>) => {
          if (type === "m.room.message") sent.push({ roomId, body: String(content.body) });
          else customs.push({ type, content });
          return "$custom";
        },
      },
      displayNameFor: async () => "Owner Person",
    };
  }

  async function project(over: { payload?: unknown; requestedAt?: Date } = {}) {
    const p = harnessPermission(SESSION, SEQ, over.payload ?? PAYLOAD, over.requestedAt ?? new Date());
    if (!p) throw new Error("the request should be carryable");
    expect(await recordPermissionRequest(ROOM, p)).toBe(true);
    await notePermissionEvent(p.requestId, PROSE);
    notePendingPermission(ROOM, { sessionId: SESSION, requestSeq: SEQ, options: OPTIONS });
    digest = p.subject.digest;
    return p;
  }

  function answerV2(over: Record<string, unknown> = {}) {
    return {
      type: "m.room.message",
      sender: OWNER_MXID,
      room_id: ROOM,
      event_id: `$${Math.random().toString(36).slice(2)}`,
      content: {
        msgtype: "m.text",
        body: "Allow once",
        suite_event_type: "dev.agentpod.permission.answer.v2",
        request_id: `${SESSION}:${SEQ}`,
        option_id: "allow_once",
        subject: { id: `${SESSION}:${SEQ}`, digest },
        "m.relates_to": { rel_type: "m.reference", event_id: PROSE },
        ...over,
      },
    };
  }

  const row = async (): Promise<Record<string, unknown>> =>
    (await rawSql`SELECT * FROM matrix_permission_requests WHERE request_id = ${`${SESSION}:${SEQ}`}`)[0] ?? {};

  beforeEach(async () => {
    customs = [];
    await rawSql`DELETE FROM matrix_permission_requests WHERE room_id = ${ROOM}`;
    await rawSql`
      INSERT INTO acp_sessions (id, tenant_id, station_id, user_id, mode, status, last_seq, created_at, last_event_at)
      VALUES (${SESSION}, (SELECT tenant_id FROM stations WHERE id = ${STATION}), ${STATION}, ${OWNER}, 'default', 'waiting', 0, now(), now())`;
    await rawSql`UPDATE matrix_rooms SET acp_session_id = ${SESSION} WHERE room_id = ${ROOM}`;
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [AGENT_PRINCIPAL], mayGrantReach: false });
  });

  afterAll(async () => {
    await rawSql`DELETE FROM matrix_permission_requests WHERE room_id = ${ROOM}`;
  });

  test("an offered option with the binding answers the agent, records who answered, and closes the card", async () => {
    await project();
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toEqual([{ userId: OWNER, sessionId: SESSION, requestSeq: SEQ, optionId: "allow_once" }]);
    expect(answeredBy.at(-1)).toEqual({ via: "room", principalId: OWNER_PRINCIPAL, mxid: OWNER_MXID });
    expect(prompts).toHaveLength(0);
    const r = await row();
    expect(r.status).toBe("answered");
    expect(r.option_id).toBe("allow_once");
    expect(r.answered_by_principal).toBe(OWNER_PRINCIPAL);
    expect(pendingPermissionFor(ROOM)).toBeUndefined();
    expect(customs).toEqual([
      {
        type: "dev.agentpod.permission.outcome.v1",
        content: {
          suite_event_type: "dev.agentpod.permission.outcome.v1",
          request_id: `${SESSION}:${SEQ}`,
          session_id: SESSION,
          request_seq: SEQ,
          outcome: "selected",
          option_id: "allow_once",
          decided_by: "Owner Person",
          "m.relates_to": { rel_type: "m.reference", event_id: PROSE },
        },
      },
    ]);
    expect(sent.at(-1)?.body).toBe("Allow once — answered by Owner Person.");
  });

  test("a reject goes through the same way", async () => {
    await project();
    await handleRoomMessage(answerV2({ option_id: "reject_once" }), permDeps());
    expect(answered.map((a) => a.optionId)).toEqual(["reject_once"]);
  });

  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a digest that is not the recorded one", { subject: { id: `${SESSION}:${SEQ}`, digest: "0".repeat(64) } }, /different request/],
    ["no binding", { subject: undefined }, /did not say which request/],
    ["an option the request did not offer", { option_id: "allow_everything" }, /not one of this request's options/],
    ["a request this room never asked", { request_id: `${SESSION}:999`, subject: { id: `${SESSION}:999`, digest: "x" } }, /not a permission request this room/],
  ];
  for (const [why, over, words] of refusals) {
    test(`refused, said in the room, never answered or prompted: ${why}`, async () => {
      await project();
      await handleRoomMessage(answerV2(over), permDeps());
      expect(answered).toEqual([]);
      expect(prompts).toHaveLength(0);
      expect(sent.at(-1)?.body).toMatch(words);
      expect((await row()).status).toBe("pending");
    });
  }

  test("an expired request refuses even an offered answer", async () => {
    await project({ requestedAt: new Date(Date.now() - 31 * 60_000) });
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toEqual([]);
    expect(sent.at(-1)?.body).toMatch(/expired/);
  });

  test("a request already settled refuses a second answer", async () => {
    await project();
    await handleRoomMessage(answerV2(), permDeps());
    await handleRoomMessage(answerV2({ option_id: "reject_once" }), permDeps());
    expect(answered.map((a) => a.optionId)).toEqual(["allow_once"]);
    expect(sent.at(-1)?.body).toMatch(/already answered here/);
  });

  test("an answer for an earlier session is stale", async () => {
    await project();
    await rawSql`UPDATE matrix_rooms SET acp_session_id = NULL WHERE room_id = ${ROOM}`;
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toEqual([]);
    expect(sent.at(-1)?.body).toMatch(/earlier session/);
  });

  test("an answer whose reference is not the request's message is refused silently", async () => {
    await project();
    await handleRoomMessage(answerV2({ "m.relates_to": { rel_type: "m.reference", event_id: "$elsewhere" } }), permDeps());
    expect(answered).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  test("on an incomplete preview an approval is refused and a reject still goes through", async () => {
    const terminal = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, content: [{ type: "terminal", terminalId: "t1" }] } };
    await project({ payload: terminal });
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toEqual([]);
    expect(sent.at(-1)?.body).toMatch(/console/);
    await handleRoomMessage(answerV2({ option_id: "reject_once" }), permDeps());
    expect(answered.map((a) => a.optionId)).toEqual(["reject_once"]);
  });

  test("someone whose grant does not cover the agent cannot answer, and nothing is recorded", async () => {
    await project();
    await setGrant(OWNER_PRINCIPAL, { mayDispatch: [OTHER_AGENT], mayGrantReach: false });
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toEqual([]);
    expect((await row()).status).toBe("pending");
  });

  test("a malformed permission answer is never a prompt", async () => {
    await project();
    clearPendingPermission(ROOM);
    await handleRoomMessage(answerV2({ option_id: 42, body: "1" }), permDeps());
    expect(answered).toEqual([]);
    expect(prompts).toHaveLength(0);
  });

  test("a typed number on a request that expired is refused and drops the stale request", async () => {
    await project({ requestedAt: new Date(Date.now() - 31 * 60_000) });
    await handleRoomMessage(message(OWNER_MXID, "1"), permDeps());
    expect(answered).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)?.body).toMatch(/expired/);
    expect(pendingPermissionFor(ROOM)).toBeUndefined();
  });

  test("a typed answer records who gave it and closes the record", async () => {
    await project();
    await handleRoomMessage(message(OWNER_MXID, "3"), permDeps());
    expect(answered.map((a) => a.optionId)).toEqual(["reject_once"]);
    expect(answeredBy.at(-1)).toEqual({ via: "room", principalId: OWNER_PRINCIPAL, mxid: OWNER_MXID });
    const r = await row();
    expect(r.status).toBe("answered");
    expect(r.answered_by_principal).toBe(OWNER_PRINCIPAL);
  });

  test("a late typed number after the request closed is refused, not prompted — until the person talks to the agent again", async () => {
    await project();
    await handleRoomMessage(message(OWNER_MXID, "1"), permDeps());
    expect(answered).toHaveLength(1);
    await handleRoomMessage(message(OWNER_MXID, "1"), permDeps());
    expect(answered).toHaveLength(1);
    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)?.body).toMatch(/already answered here/);

    await rawSql`
      INSERT INTO acp_events (session_id, tenant_id, seq, type, payload, created_at)
      VALUES (${SESSION}, (SELECT tenant_id FROM stations WHERE id = ${STATION}), ${SEQ + 5}, 'user-prompt', '{}'::jsonb, now())`;
    await handleRoomMessage(message(OWNER_MXID, "1"), permDeps());
    expect(prompts.at(-1)?.text).toBe("1");
  });

  test("a typed number cannot allow on an incomplete preview; a typed reject still goes through", async () => {
    // Review of #844: the typed path must keep the same checks as permission.answer.v2.
    const terminal = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, content: [{ type: "terminal", terminalId: "t1" }] } };
    await project({ payload: terminal });
    await handleRoomMessage(message(OWNER_MXID, "1"), permDeps());
    expect(answered).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)?.body).toMatch(/console/);
    expect((await row()).status).toBe("pending");
    await handleRoomMessage(message(OWNER_MXID, "3"), permDeps());
    expect(answered.map((a) => a.optionId)).toEqual(["reject_once"]);
  });

  test("a request the expiry sweep has claimed is not answered, and the answerer is never lost to it", async () => {
    await project();
    await rawSql`UPDATE matrix_permission_requests SET status = 'claimed' WHERE request_id = ${`${SESSION}:${SEQ}`}`;
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toEqual([]);
    expect(sent.at(-1)?.body).toMatch(/being answered right now/);
  });

  test("an answer that loses the row to the sweep after it was judged is not delivered", async () => {
    // The race: judged while pending, then claimed by the expiry sweep before the agent is answered.
    const p = await project();
    const snapshot = await permissionRecord(p.requestId);
    if (!snapshot) throw new Error("recorded");
    await rawSql`UPDATE matrix_permission_requests SET status = 'claimed' WHERE request_id = ${p.requestId}`;
    const delivered: string[] = [];
    const said: string[] = [];
    const out = await answerTypedPermission(snapshot, "reject_once", { roomId: ROOM, sessionId: SESSION, answerer: { principalId: OWNER_PRINCIPAL, mxid: OWNER_MXID } }, {
      answer: async (_s, _q, optionId) => void delivered.push(optionId),
      say: async (b) => said.push(b),
    });
    expect(out.status).toBe("refused");
    expect(delivered).toEqual([]);
    expect(said[0]).toMatch(/being answered right now/);
  });

  test("an answer the session refuses gives the claim back, so the request can still be answered", async () => {
    await project();
    answerFails = new Error("something went wrong");
    await handleRoomMessage(answerV2(), permDeps());
    expect((await row()).status).toBe("pending");
    answerFails = null;
    await handleRoomMessage(answerV2(), permDeps());
    expect((await row()).status).toBe("answered");
  });

  test("a replayed request does not re-point the record away from the card people saw", async () => {
    const p = await project();
    await notePermissionEvent(p.requestId, "$replayed-prose");
    expect((await row()).event_id).toBe(PROSE);
    await handleRoomMessage(answerV2(), permDeps());
    expect(answered).toHaveLength(1);
  });

  test("a request answered in the console closes the record and the card, and a late '1' says where it was answered", async () => {
    const p = await project();
    const said: string[] = [];
    const outcomes: Array<Record<string, unknown>> = [];
    await settleFromSessionEvent(SESSION, { requestSeq: SEQ, optionId: "allow_once", answeredBy: { via: "console", userId: OWNER_PRINCIPAL } }, {
      say: async (b) => said.push(b),
      sendOutcome: async (c) => outcomes.push(c),
      displayNameFor: async () => "Owner Person",
    });
    const r = await row();
    expect(r.status).toBe("answered");
    expect(r.answered_via).toBe("console");
    expect(r.answered_by_principal).toBe(OWNER_PRINCIPAL);
    expect(outcomes).toEqual([expect.objectContaining({ request_id: p.requestId, outcome: "selected", option_id: "allow_once", decided_by: "Owner Person" })]);
    expect(said).toEqual(["Allow once — answered by Owner Person."]);
    clearPendingPermission(ROOM);
    await handleRoomMessage(message(OWNER_MXID, "1"), permDeps());
    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)?.body).toMatch(/already answered in the console/);
  });

  test("a request released as its session ended closes as withdrawn, and a room answer's own event changes nothing", async () => {
    await project();
    await settleFromSessionEvent(SESSION, { requestSeq: SEQ, cancelled: true }, { say: async () => {}, sendOutcome: async () => {} });
    expect((await row()).status).toBe("cancelled");
    // A claimed row (a room answer in flight) is not touched by its own echo.
    await rawSql`UPDATE matrix_permission_requests SET status = 'claimed' WHERE request_id = ${`${SESSION}:${SEQ}`}`;
    await settleFromSessionEvent(SESSION, { requestSeq: SEQ, optionId: "allow_once" }, { say: async () => {}, sendOutcome: async () => {} });
    expect((await row()).status).toBe("claimed");
  });

  test("a request left pending by a restart refuses a matching reply rather than prompting", async () => {
    await project();
    clearPendingPermission(ROOM);
    await handleRoomMessage(message(OWNER_MXID, "Allow once"), permDeps());
    expect(answered).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(sent.at(-1)?.body).toMatch(/no longer waiting/);
    // An ordinary message is still a message.
    await handleRoomMessage(message(OWNER_MXID, "what are you doing?"), permDeps());
    expect(prompts.at(-1)?.text).toBe("what are you doing?");
  });
});
