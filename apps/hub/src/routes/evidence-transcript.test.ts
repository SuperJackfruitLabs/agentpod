/**
 * Route tests: a session's transcript as evidence (superwitness transcripts spec §3, §5).
 * Uses the local Docker test-postgres (localhost:5434).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EvidenceTranscriptItemResponse, EvidenceTranscriptResponse } from "@agentpod/contract";

import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { auth } from "../auth/drizzle-auth";
import { buildTokenPayload } from "../auth/jwt-claims";
import { signServiceToken } from "../auth/service-signing";
import { db, rawSql } from "../db/drizzle";
import { acpEvents, acpSessions } from "../db/schema/acp";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { setGrant } from "../services/grants";
import { createPrincipal } from "../services/principals";
import { createEvidenceRoutes } from "./evidence";

const RUN = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const STATION = `station_${crypto.randomUUID()}`;
const SESSION = `acps_${crypto.randomUUID()}`;
const EMPTY = `acps_${crypto.randomUUID()}`;
const LONG = `acps_${crypto.randomUUID()}`; // more rows than one fold batch
const STRADDLE = `acps_${crypto.randomUUID()}`; // a key across the 16 KiB cut
const app = createEvidenceRoutes();

/** Assembled at runtime so no literal credential sits in this file. */
const SECRET_HEAD = ["sk", "ant", "api03", "AAAAAAAAAA"].join("-");
const SECRET_TAIL = "BBBBBBBBBBBBBBBBBBBB";
const BEARER = `Authorization: Bearer ${"tok3n".repeat(4)}`;
const BIG = "x".repeat(20 * 1024); // over the 16 KiB page cut, under the 1 MiB item cap
const HUGE = "y".repeat(2 * 1024 * 1024); // over the 1 MiB item cap

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const EVENTS: Array<[string, unknown]> = [
  ["state", { status: "idle" }], //                                                   1
  ["user-prompt", { text: `Use ${BEARER} to call the API` }], //                     2
  ["state", { status: "working" }], //                                               3
  ["agent-update", chunk(`The key is ${SECRET_HEAD}`)], //                           4
  ["agent-update", chunk(`${SECRET_TAIL}, done.`)], //                               5
  ["agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", title: "cat log", kind: "read", status: "pending", rawInput: { path: "/srv/log" } }], // 6
  ["agent-update", chunk("Reading.")], //                                            7
  ["agent-update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { text: BIG } }], // 8
  ["agent-update", { sessionUpdate: "tool_call", toolCallId: "t2", title: "dump", status: "completed", rawOutput: { text: HUGE } }], // 9
  ["permission-request", { toolCall: { toolCallId: "t3", title: "edit a.ts" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }], // 10
  ["permission-answer", { requestSeq: 10, optionId: "allow" }], //                  11
  ["state", { status: "idle" }], //                                                 12
];

let both = "";
let evidenceOnly = "";
let transcriptsOnly = "";

const token = async (principalId: string) =>
  signServiceToken({ payload: await buildTokenPayload({ principalId }), subject: principalId, ttl: "5m" });
const get = (path: string, t?: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...headers } });
const page = (q = "", sid = SESSION) => `/api/evidence/sessions/${sid}/transcript${q}`;
const item = (seq: number | string, q = "") => `/api/evidence/sessions/${SESSION}/transcript/items/${seq}${q}`;

beforeAll(async () => {
  await ensurePgMigrations();
  const now = new Date();
  for (const id of [SESSION, EMPTY, LONG, STRADDLE]) {
    await db.insert(acpSessions).values({
      id, tenantId: BOOTSTRAP_TENANT_ID, stationId: STATION, userId: "transcript-it", mode: "full-auto",
      status: "idle", lastSeq: 0, createdAt: now, lastEventAt: now,
    });
  }
  await db.insert(acpEvents).values(
    EVENTS.map(([type, payload], i) => ({
      sessionId: SESSION, tenantId: BOOTSTRAP_TENANT_ID, seq: i + 1, type, payload: payload as object, createdAt: now,
    })),
  );
  // 2,500 single-chunk turns: each a prompt then a message, so 5,000 events and 5,000 items.
  const long = Array.from({ length: 5000 }, (_, i) => ({
    sessionId: LONG, tenantId: BOOTSTRAP_TENANT_ID, seq: i + 1, createdAt: now,
    ...(i % 2 === 0 ? { type: "user-prompt", payload: { text: `q${i}` } } : { type: "agent-update", payload: chunk(`a${i}`) }),
  }));
  for (let i = 0; i < long.length; i += 1000) await db.insert(acpEvents).values(long.slice(i, i + 1000));
  await db.insert(acpEvents).values({
    sessionId: STRADDLE, tenantId: BOOTSTRAP_TENANT_ID, seq: 1, type: "agent-update", createdAt: now,
    payload: chunk("p".repeat(16 * 1024 - 7) + " " + SECRET_HEAD + SECRET_TAIL),
  });
  both = await createPrincipal({ kind: "service", handle: `tx-both-${RUN}` });
  await setGrant(both, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read", "transcripts:read"] });
  evidenceOnly = await createPrincipal({ kind: "service", handle: `tx-ev-${RUN}` });
  await setGrant(evidenceOnly, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read"] });
  transcriptsOnly = await createPrincipal({ kind: "service", handle: `tx-only-${RUN}` });
  await setGrant(transcriptsOnly, { mayDispatch: [], mayGrantReach: false, scopes: ["transcripts:read"] });
});

afterAll(async () => {
  await rawSql`DELETE FROM station_audit WHERE station_key = ${STATION}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM principals WHERE handle LIKE ${`tx-%-${RUN}`}`;
});

describe("each route checks its own scope", () => {
  test("evidence:read alone is 403 on both transcript routes", async () => {
    const t = await token(evidenceOnly);
    for (const path of [page(), item(2, "?full=1")]) {
      const res = await get(path, t);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });

  test("transcripts:read alone is 403 on every existing evidence route", async () => {
    const t = await token(transcriptsOnly);
    for (const path of [
      "/api/evidence/runs/superpipeline/run_none",
      `/api/evidence/attempts/attempt_${crypto.randomUUID()}`,
      `/api/evidence/principals/${both}`,
    ]) {
      expect((await get(path, t)).status).toBe(403);
    }
  });

  test("transcripts:read alone reads a transcript; no token is 401", async () => {
    expect((await get(page(), await token(transcriptsOnly))).status).toBe(200);
    expect((await get(page())).status).toBe(401);
  });
});

describe("GET /api/evidence/sessions/:sessionId/transcript", () => {
  test("folds the whole session by default, in the response's shape", async () => {
    const body = (await (await get(page(), await token(both))).json()) as any;
    expect(EvidenceTranscriptResponse.safeParse(body).error).toBeUndefined();
    expect(body).toMatchObject({ session_id: SESSION, seq_from: 1, seq_to: 12, next_cursor: null });
    expect(body.items.map((i: any) => i.kind)).toEqual([
      "state", "prompt", "state", "message", "tool_call", "message", "tool_call", "permission", "state",
    ]);
  });

  test("redacts after folding: a key split across two chunks and an Authorization value", async () => {
    const body = (await (await get(page(), await token(both))).json()) as any;
    const message = body.items.find((i: any) => i.kind === "message");
    expect(message.text).toBe("The key is [redacted:anthropic-key], done.");
    expect(message.redactions).toBe(1);
    expect(body.items.find((i: any) => i.kind === "prompt").text).toBe("Use Authorization: [redacted:authorization]");
    expect(body.redactions).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(body)).not.toContain(SECRET_TAIL);
  });

  test("stored events keep the original text", async () => {
    const rows = await rawSql`SELECT payload FROM acp_events WHERE session_id = ${SESSION} AND seq = 5`;
    expect(JSON.stringify(rows[0]!.payload)).toContain(SECRET_TAIL);
  });

  test("another tenant's session, or no session, is 404", async () => {
    const { token: foreign } = await auth.api.signJWT({
      body: {
        payload: {
          iat: Math.floor(Date.now() / 1000), sub: both, principalKind: "service",
          tenant: "fleet_ffffffffffffffffffff", mayDispatch: [], mayGrantReach: false,
        },
      },
    });
    expect((await get(page(), foreign)).status).toBe(404);
    const res = await get(page("", `acps_${crypto.randomUUID()}`), await token(both));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("bad_range: reversed, outside the session, not an integer, or a cursor outside the range", async () => {
    const t = await token(both);
    for (const q of ["?seq_from=5&seq_to=4", "?seq_from=0", "?seq_to=13", "?seq_from=abc", "?seq_from=-1", "?cursor=nonsense", `?seq_from=3&cursor=${Buffer.from("s:2").toString("base64url")}`]) {
      const res = await get(page(q), t);
      expect(res.status, q).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_range" });
    }
    expect((await get(page("?seq_from=1"), t, {})).status).toBe(200);
    expect((await get(`/api/evidence/sessions/${EMPTY}/transcript?seq_from=1`, t)).status).toBe(400);
  });

  test("an empty session is an empty transcript", async () => {
    const body = (await (await get(page("", EMPTY), await token(both))).json()) as any;
    expect(body).toEqual({ session_id: EMPTY, seq_from: 0, seq_to: 0, items: [], next_cursor: null, redactions: 0, truncated_fields: 0 });
  });

  test("paging never splits an item: pages of 1 or 2 concatenate to the unpaged transcript", async () => {
    const t = await token(both);
    const whole = ((await (await get(page(), t)).json()) as any).items;
    // Pages of 2 start at seq 1, 3, 6, 9, 12; pages of 1 also start at seq 7, between t1's
    // call (6) and its update (8) — the boundary a fold from the cursor would split t1 across.
    for (const limit of [1, 2]) {
      const seen: any[] = [];
      let cursor: string | null = null;
      do {
        const body = (await (await get(page(`?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`), t)).json()) as any;
        expect(body.items.length).toBeLessThanOrEqual(limit);
        seen.push(...body.items);
        cursor = body.next_cursor;
      } while (cursor);
      expect(seen).toEqual(whole);
      expect(seen.filter((i) => i.id === "t1")).toHaveLength(1);
      expect(seen.find((i) => i.id === "t1").partial).toBeUndefined();
    }
  });

  test("limit is capped at 200", async () => {
    const res = await get(page("?limit=100000"), await token(both));
    expect(res.status).toBe(200);
  });

  test("a range starting mid-item yields partial items built from what is inside it", async () => {
    const body = (await (await get(page("?seq_from=8&seq_to=11"), await token(both))).json()) as any;
    expect(body.items[0]).toMatchObject({ kind: "tool_call", id: "t1", seq_from: 8, seq_to: 8, status: "completed", input: null, partial: true });
    const body2 = (await (await get(page("?seq_from=11&seq_to=11"), await token(both))).json()) as any;
    expect(body2.items).toEqual([
      { kind: "permission", seq: 10, answer_seq: 11, title: "Permission request", options: [], outcome: "selected:allow", partial: true, redactions: 0 },
    ]);
  });

  test("a field over 16 KiB is cut to a marker with its size and a redacted head", async () => {
    const body = (await (await get(page("?seq_from=6&seq_to=8"), await token(both))).json()) as any;
    const raw = body.items.find((i: any) => i.id === "t1").output.raw;
    expect(raw.truncated).toBe(true);
    expect(raw.bytes).toBe(JSON.stringify({ text: BIG }).length);
    expect(Buffer.byteLength(raw.head)).toBeLessThanOrEqual(16 * 1024);
    expect(raw.head.startsWith('{"text":"xxx')).toBe(true);
    expect(body.truncated_fields).toBe(1);
  });
});

describe("what a long or awkward session does", () => {
  test("a session longer than one fold batch pages to the end, every item once", async () => {
    const t = await token(both);
    let cursor: string | null = null;
    let count = 0;
    let last = 0;
    do {
      const body = (await (await get(page(cursor ? `?cursor=${cursor}` : "", LONG), t)).json()) as any;
      for (const it of body.items) {
        const first = it.seq_from ?? it.seq;
        expect(first).toBeGreaterThan(last);
        last = first;
      }
      count += body.items.length;
      cursor = body.next_cursor;
    } while (cursor);
    expect(count).toBe(5000);
  });

  test("a key straddling the 16 KiB cut is redacted before the cut: no prefix of it in the head", async () => {
    const body = (await (await get(page("", STRADDLE), await token(both))).json()) as any;
    const text = body.items[0].text;
    expect(text.truncated).toBe(true);
    expect(text.head.startsWith("p".repeat(16 * 1024 - 7) + " ")).toBe(true);
    // Cut first and redacted second, the head would end "…pppsk-ant": a prefix no rule matches.
    expect(text.head).not.toContain(["sk", "ant"].join("-"));
    expect(body.redactions).toBe(1);
  });
});

describe("GET /api/evidence/sessions/:sessionId/transcript/items/:seqFrom", () => {
  test("full=1 returns the item uncut", async () => {
    const res = await get(item(6, "?full=1"), await token(both));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(EvidenceTranscriptItemResponse.safeParse(body).error).toBeUndefined();
    expect(body.item.output.raw).toEqual({ text: BIG });
    expect(body).toEqual({ session_id: SESSION, item: body.item });
    expect(body.item.redactions).toBe(0);
  });

  test("without full=1 the item is cut as its page cut it", async () => {
    const body = (await (await get(item(6), await token(both))).json()) as any;
    expect(body.item.output.raw.truncated).toBe(true);
  });

  test("an item over 1 MiB serialised is 413 item_too_large", async () => {
    const res = await get(item(9, "?full=1"), await token(both));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "item_too_large" });
  });

  test("a seq that is not an item's first is 404", async () => {
    const t = await token(both);
    for (const seq of [5, 8, 11, 99, "x"]) expect((await get(item(seq, "?full=1"), t)).status).toBe(404);
  });

  test("the range decides where items start: seq 8 starts the partial t1 in 8..12", async () => {
    const res = await get(item(8, "?seq_from=8&full=1"), await token(both));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).item).toMatchObject({ id: "t1", partial: true });
  });
});

describe("audit", () => {
  test("each read writes one row naming the caller and on_behalf_of, and no content", async () => {
    const onBehalf = await createPrincipal({ kind: "human", handle: `tx-human-${RUN}` });
    await get(page("?seq_from=2&seq_to=5"), await token(both), { "X-On-Behalf-Of": onBehalf });
    const rows = await rawSql`SELECT user_id, verb, params_summary, result FROM station_audit
                              WHERE station_key = ${STATION} AND params_summary->>'on_behalf_of' = ${onBehalf}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: both, verb: "evidence.transcript.read", result: "ok" });
    expect(rows[0]!.params_summary).toEqual({
      sessionId: SESSION, seq_from: 2, seq_to: 5, items: 3, redactions: 2, full: false, on_behalf_of: onBehalf,
    });
    const text = JSON.stringify(rows);
    for (const content of ["The key is", "Use ", SECRET_HEAD, "redacted"]) expect(text).not.toContain(content);
  });

  test("an X-On-Behalf-Of that is not a principal id is not recorded", async () => {
    await get(page("?seq_from=12"), await token(both), { "X-On-Behalf-Of": "someone; DROP TABLE" });
    const rows = await rawSql`SELECT params_summary FROM station_audit
                              WHERE station_key = ${STATION} AND params_summary->>'seq_from' = '12'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params_summary.on_behalf_of).toBeUndefined();
  });

  test("an item read names the item it read", async () => {
    const onBehalf = await createPrincipal({ kind: "human", handle: `tx-item-${RUN}` });
    expect((await get(item(6, "?full=1"), await token(both), { "X-On-Behalf-Of": onBehalf })).status).toBe(200);
    const rows = await rawSql`SELECT params_summary FROM station_audit
                              WHERE station_key = ${STATION} AND params_summary->>'on_behalf_of' = ${onBehalf}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params_summary).toMatchObject({ item_seq: 6, items: 1, full: true });
  });

  test("a 413 is audited as an error, naming the item, still without content", async () => {
    const onBehalf = await createPrincipal({ kind: "human", handle: `tx-413-${RUN}` });
    expect((await get(item(9, "?full=1"), await token(both), { "X-On-Behalf-Of": onBehalf })).status).toBe(413);
    const rows = await rawSql`SELECT result, error, params_summary FROM station_audit
                              WHERE station_key = ${STATION} AND params_summary->>'on_behalf_of' = ${onBehalf}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ result: "error", error: "item_too_large" });
    expect(rows[0]!.params_summary).toMatchObject({ item_seq: 9, items: 0, full: true });
    expect(JSON.stringify(rows)).not.toContain("yyyy");
  });
});
