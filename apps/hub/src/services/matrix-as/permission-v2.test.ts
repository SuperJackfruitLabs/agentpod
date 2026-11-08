process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PERMISSION_REQUEST_CONTENT_KEY } from "@agentpod/contract";

import { rawSql } from "../../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../../../tests/helpers/database";
import { permissionRequestContent } from "./activity";
import { expirePermissions, permissionRefusal } from "./permission-answer";
import { notePermissionEvent, permissionRecord, recordPermissionRequest } from "./permission-records";
import {
  HARNESS_PERMISSION_SCHEMA,
  PERMISSION_TTL_MS,
  PERMISSION_V2_SUITE_TYPE,
  canonicalJson,
  harnessPermission,
  parsePermissionAnswer,
  permissionOptionsV2,
  permissionPreview,
  permissionOutcomeContent,
  permissionV2Content,
} from "./permission-wire";
import { clearPendingPermission, notePendingPermission, pendingPermissionFor, permissionPrompt } from "./permissions";

/**
 * permission.v2 — a harness permission in AgentPod's own envelope (charter: "Strict decisions and
 * harness permissions bind their subject" §5): meanings and scopes from ACP's option kinds, a
 * `harness-permission/v1` subject whose digest covers the full request and whose preview shows the
 * tool, its command, its diffs and its locations, and an expiry 30 minutes after it was asked.
 */

const SESSION = "acps_perm_v2";
const AT = new Date("2026-11-07T10:00:00.000Z");
const PAYLOAD = {
  toolCall: {
    toolCallId: "tc_9",
    title: "Edit src/app.ts",
    kind: "edit",
    rawInput: { path: "src/app.ts" },
    content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "export const answer = 42;\n" }],
    locations: [{ path: "src/app.ts", line: 3 }],
  },
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    { optionId: "reject_always", name: "Never allow", kind: "reject_always" },
  ],
};

function must<T>(v: T | null): T {
  if (v === null) throw new Error("expected a value");
  return v;
}

describe("permission.v2 — the wire", () => {
  test("options take their meaning and scope from ACP's kinds; an unknown kind is a neutral choice", () => {
    expect(permissionOptionsV2([...PAYLOAD.options, { optionId: "later", name: "Ask later", kind: "defer_please" }])).toEqual([
      { id: "allow_once", label: "Allow once", meaning: "approve", scope: "once" },
      { id: "allow_always", label: "Always allow", meaning: "approve", scope: "always" },
      { id: "reject_once", label: "Reject", meaning: "reject", scope: "once" },
      { id: "reject_always", label: "Never allow", meaning: "reject", scope: "always" },
      { id: "later", label: "Ask later", meaning: "choose" },
    ]);
  });

  test("the digest is sha256 of the canonical {session_id, request_seq, tool_call, options}, over the full request", () => {
    const p = harnessPermission(SESSION, 4, PAYLOAD, AT);
    const expected = createHash("sha256")
      .update(canonicalJson({ session_id: SESSION, request_seq: 4, tool_call: PAYLOAD.toolCall, options: PAYLOAD.options }))
      .digest("hex");
    expect(p?.subject.digest).toBe(expected);
    // Key order does not matter; any change to what was asked does.
    const reordered = { options: PAYLOAD.options, toolCall: { ...PAYLOAD.toolCall } };
    expect(harnessPermission(SESSION, 4, reordered, AT)?.subject.digest).toBe(expected);
    const changed = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, rawInput: { path: "src/other.ts" } } };
    expect(harnessPermission(SESSION, 4, changed, AT)?.subject.digest).not.toBe(expected);
    expect(harnessPermission(SESSION, 5, PAYLOAD, AT)?.subject.digest).not.toBe(expected);
  });

  test("canonical JSON sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: [2, { d: 1, c: null }], a: "x" })).toBe('{"a":"x","b":[2,{"c":null,"d":1}]}');
  });

  test("the subject: id, schema, revision 1, expiry 30 minutes after the request, and the preview", () => {
    const p = harnessPermission(SESSION, 4, PAYLOAD, AT);
    expect(p?.subject).toMatchObject({
      id: `${SESSION}:4`,
      schema: HARNESS_PERMISSION_SCHEMA,
      revision: 1,
      expires_at: new Date(AT.getTime() + PERMISSION_TTL_MS).toISOString(),
      preview_complete: true,
    });
    expect(p?.subject.preview).toEqual([
      { type: "field", label: "Tool", value: "Edit src/app.ts" },
      { type: "field", label: "Kind", value: "edit" },
      { type: "text", label: "Input", text: '{\n  "path": "src/app.ts"\n}' },
      { type: "text", label: "src/app.ts", text: "export const answer = 42;\n" },
      { type: "field", label: "Location", value: "src/app.ts:3" },
    ]);
  });

  test("a command is shown as a command, an argv joined", () => {
    expect(permissionPreview({ title: "t", rawInput: { command: ["git", "push"] } }).blocks).toContainEqual({
      type: "text",
      label: "Command",
      text: "git push",
    });
  });

  test("the preview is incomplete when something was cut or cannot be drawn", () => {
    const long = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, content: [{ type: "diff", path: "a", newText: "x".repeat(5000) }] } };
    expect(harnessPermission(SESSION, 4, long, AT)?.subject.preview_complete).toBe(false);
    const terminal = { ...PAYLOAD, toolCall: { ...PAYLOAD.toolCall, content: [{ type: "terminal", terminalId: "t" }] } };
    expect(harnessPermission(SESSION, 4, terminal, AT)?.subject.preview_complete).toBe(false);
  });

  test("the content carries the marker, the request id, the options and the subject", () => {
    const p = must(harnessPermission(SESSION, 4, PAYLOAD, AT));
    expect(permissionV2Content(p)).toEqual({
      suite_event_type: PERMISSION_V2_SUITE_TYPE,
      schema_version: 1,
      request_id: `${SESSION}:4`,
      session_id: SESSION,
      request_seq: 4,
      title: "Edit src/app.ts",
      tool_kind: "edit",
      options: permissionOptionsV2(PAYLOAD.options),
      subject: p.subject,
    });
  });

  test("an answer is read with its binding and reference; a quoted reply is no reference", () => {
    const content = {
      suite_event_type: "dev.agentpod.permission.answer.v2",
      request_id: `${SESSION}:4`,
      option_id: "allow_once",
      subject: { id: `${SESSION}:4`, digest: "abc" },
      "m.relates_to": { rel_type: "m.reference", event_id: "$p" },
    };
    expect(parsePermissionAnswer(content)).toEqual({
      requestId: `${SESSION}:4`,
      optionId: "allow_once",
      subject: { id: `${SESSION}:4`, digest: "abc" },
      referencedEventId: "$p",
    });
    expect(parsePermissionAnswer({ ...content, "m.relates_to": { "m.in_reply_to": { event_id: "$p" } } })?.referencedEventId).toBeNull();
    expect(parsePermissionAnswer({ ...content, suite_event_type: "dev.agentpod.permission.v2" })).toBeNull();
    expect(parsePermissionAnswer({ ...content, option_id: "" })).toBeNull();
  });
});

function rig() {
  const cancelled: string[] = [];
  const said: string[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  return {
    cancelled,
    said,
    outcomes,
    deps: {
      cancel: async (r: { requestId: string }) => (cancelled.push(r.requestId), true),
      say: async (_room: string, body: string) => said.push(body),
      sendOutcome: async (_room: string, c: Record<string, unknown>) => outcomes.push(c),
    },
  };
}

describe("permission.v2 — expiry", () => {
  const ROOM = "!perm-expiry:id.test";
  const STATION = "station_perm_expiry";
  const NODE = "node_perm_expiry";
  const OWNER = "test-user-perm-expiry";

  beforeAll(async () => {
    await ensurePgMigrations();
    await rawSql`DELETE FROM matrix_permission_requests WHERE room_id = ${ROOM}`;
    await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await createTestUser({ id: OWNER, email: "perm-expiry@example.com", name: "Owner" });
    await rawSql`
      INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
      VALUES (${NODE}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, 'perm-expiry-box', 'perm-expiry-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${STATION}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, ${NODE}, 'openclaw', 'openclaw:perm', 'leaf', 'perm', '["acp"]'::jsonb, now(), now())`;
    await rawSql`
      INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
      VALUES (${ROOM}, ${BOOTSTRAP_TENANT_ID}, ${STATION}, '#perm-expiry:id.test', now())`;
  });

  beforeEach(async () => {
    await rawSql`DELETE FROM matrix_permission_requests WHERE room_id = ${ROOM}`;
    clearPendingPermission(ROOM);
  });

  afterAll(async () => {
    await rawSql`DELETE FROM matrix_permission_requests WHERE room_id = ${ROOM}`;
    await rawSql`DELETE FROM matrix_rooms WHERE room_id = ${ROOM}`;
    await rawSql`DELETE FROM stations WHERE id = ${STATION}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await deleteTestUsers([OWNER]);
  });


  test("a request past its 30 minutes is answered cancelled, closed, and its card closed — once", async () => {
    const p = must(harnessPermission(SESSION, 21, PAYLOAD, new Date(Date.now() - PERMISSION_TTL_MS - 1000)));
    await recordPermissionRequest(ROOM, p);
    await notePermissionEvent(p.requestId, "$perm-prose");
    notePendingPermission(ROOM, { sessionId: SESSION, requestSeq: 21, options: [] });
    const { deps, cancelled, said, outcomes } = rig();

    expect(await expirePermissions(deps)).toBe(1);
    expect(cancelled).toEqual([p.requestId]);
    expect((await permissionRecord(p.requestId))?.status).toBe("expired");
    expect(pendingPermissionFor(ROOM)).toBeUndefined();
    expect(said[0]).toMatch(/expired unanswered/);
    expect(outcomes).toEqual([
      {
        suite_event_type: "dev.agentpod.permission.outcome.v1",
        request_id: p.requestId,
        session_id: SESSION,
        request_seq: 21,
        outcome: "expired",
        option_id: null,
        decided_by: null,
        "m.relates_to": { rel_type: "m.reference", event_id: "$perm-prose" },
      },
    ]);
    expect(await expirePermissions(deps)).toBe(0);
  });

  test("a request with nothing parked is closed as withdrawn, never posted as expired", async () => {
    const p = must(harnessPermission(SESSION, 24, PAYLOAD, new Date(Date.now() - PERMISSION_TTL_MS - 1000)));
    await recordPermissionRequest(ROOM, p);
    await notePermissionEvent(p.requestId, "$perm-prose-24");
    const { deps, said, outcomes } = rig();
    expect(await expirePermissions({ ...deps, cancel: async () => false })).toBe(0);
    expect((await permissionRecord(p.requestId))?.status).toBe("cancelled");
    expect(outcomes).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
    expect(said.join(" ")).not.toMatch(/expired/);
  });

  test("a request an answer has claimed is not swept", async () => {
    const p = must(harnessPermission(SESSION, 25, PAYLOAD, new Date(Date.now() - PERMISSION_TTL_MS - 1000)));
    await recordPermissionRequest(ROOM, p);
    await rawSql`UPDATE matrix_permission_requests SET status = 'claimed' WHERE request_id = ${p.requestId}`;
    const { deps, cancelled } = rig();
    expect(await expirePermissions(deps)).toBe(0);
    expect(cancelled).toEqual([]);
    expect((await permissionRecord(p.requestId))?.status).toBe("claimed");
  });

  test("a request still within its time is left alone", async () => {
    const p = must(harnessPermission(SESSION, 22, PAYLOAD, new Date()));
    await recordPermissionRequest(ROOM, p);
    const { deps, cancelled } = rig();
    expect(await expirePermissions(deps)).toBe(0);
    expect(cancelled).toEqual([]);
    expect((await permissionRecord(p.requestId))?.status).toBe("pending");
  });

  test("a room this hub does not know records nothing", async () => {
    const p = must(harnessPermission(SESSION, 23, PAYLOAD, new Date()));
    expect(await recordPermissionRequest("!unknown:id.test", p)).toBe(false);
    expect(await permissionRecord(p.requestId)).toBeNull();
  });
});

// ── The shared corpus (fixture version 5) ────────────────────────────────────

interface CorpusEvent {
  suiteEventType: string;
  accept: Array<{ why: string; content: Record<string, unknown> }>;
  reject: Array<{ why: string; content: Record<string, unknown> }>;
}

function corpusEvent(suiteEventType: string): CorpusEvent | undefined {
  const corpus: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../../../fixtures/ecosystem-identity/matrix_gate_events.json"), "utf8"),
  );
  const list: CorpusEvent[] =
    typeof corpus === "object" && corpus !== null && "events" in corpus && Array.isArray(corpus.events) ? corpus.events : [];
  return list.find((e) => e.suiteEventType === suiteEventType);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function wellFormedPermission(c: Record<string, unknown>): boolean {
  if (c.suite_event_type !== PERMISSION_V2_SUITE_TYPE || typeof c.request_id !== "string" || typeof c.body !== "string") return false;
  if (!isObj(c.subject) || c.subject.schema !== HARNESS_PERMISSION_SCHEMA || c.subject.id !== c.request_id) return false;
  if (!isObj(c[PERMISSION_REQUEST_CONTENT_KEY])) return false;
  return Array.isArray(c.options) && c.options.every((o) => isObj(o) && typeof o.id === "string" && typeof o.meaning === "string");
}

function wellFormedOutcome(c: Record<string, unknown>): boolean {
  const rel = c["m.relates_to"];
  return (
    c.suite_event_type === "dev.agentpod.permission.outcome.v1" &&
    ["selected", "expired", "cancelled"].includes(String(c.outcome)) &&
    isObj(rel) &&
    rel.rel_type === "m.reference" &&
    typeof rel.event_id === "string"
  );
}

describe("permission.v2 against the shared corpus", () => {
  const FIXTURE_PAYLOAD = {
    toolCall: { toolCallId: "tc_7", title: "Run the test suite", kind: "execute", rawInput: { command: "bun test" }, locations: [{ path: "apps/hub" }] },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      { optionId: "reject_always", name: "Never allow", kind: "reject_always" },
    ],
  };
  const p = must(harnessPermission("acps_3f0c", 12, FIXTURE_PAYLOAD, new Date("2026-11-07T10:00:00.000Z")));
  const named = FIXTURE_PAYLOAD.options.map((o) => ({ optionId: o.optionId, name: o.name }));

  test("the hub's permission prose message is exactly what the corpus accepts", () => {
    const event = corpusEvent(PERMISSION_V2_SUITE_TYPE);
    expect(event?.accept).toHaveLength(1);
    const ours: Record<string, unknown> = {
      msgtype: "m.text",
      body: permissionPrompt(p.title, named),
      ...permissionV2Content(p),
      [PERMISSION_REQUEST_CONTENT_KEY]: permissionRequestContent("acps_3f0c", 12, p.title, named),
    };
    expect(ours).toEqual(event?.accept[0]?.content ?? {});
    for (const { content } of event?.accept ?? []) expect(wellFormedPermission(content)).toBe(true);
    for (const { why, content } of event?.reject ?? []) expect(wellFormedPermission(content), why).toBe(false);
  });

  test("every answer the corpus accepts passes the hub's judgement; every one it rejects is refused", () => {
    const event = corpusEvent("dev.agentpod.permission.answer.v2");
    const record = {
      requestId: p.requestId,
      tenantId: BOOTSTRAP_TENANT_ID,
      roomId: "!room",
      sessionId: "acps_3f0c",
      requestSeq: 12,
      eventId: "$permissionEventId",
      digest: p.subject.digest,
      previewComplete: p.subject.preview_complete,
      options: p.options,
      expiresAt: new Date(Date.now() + 60_000),
      status: "pending" as const,
      optionId: null,
      answeredByPrincipal: null,
      answeredVia: null,
      closedAt: null,
    };
    const ctx = { roomId: "!room", sessionId: "acps_3f0c" };
    expect(event?.accept.length).toBeGreaterThanOrEqual(2);
    for (const { why, content } of event?.accept ?? []) {
      expect(permissionRefusal(must(parsePermissionAnswer(content)), record, ctx, new Date()), why).toBeNull();
    }
    // The same request recorded for another room is not this room's to answer.
    const accepted = event?.accept[0]?.content ?? {};
    expect(permissionRefusal(must(parsePermissionAnswer(accepted)), { ...record, roomId: "!elsewhere" }, ctx, new Date())).toBe("unknown-request");
    expect(event?.reject.length).toBeGreaterThanOrEqual(3);
    for (const { why, content } of event?.reject ?? []) {
      const parsed = parsePermissionAnswer(content);
      expect(parsed === null || permissionRefusal(parsed, record, ctx, new Date()) !== null, why).toBe(true);
    }
  });

  test("the hub's outcomes are exactly what the corpus accepts", () => {
    const event = corpusEvent("dev.agentpod.permission.outcome.v1");
    const ref = { requestId: p.requestId, sessionId: "acps_3f0c", requestSeq: 12, eventId: "$permissionEventId" };
    expect(event?.accept.map((a) => a.content)).toEqual([
      permissionOutcomeContent(ref, "selected", "allow_once", "fixture-person"),
      permissionOutcomeContent(ref, "expired", null, null),
    ]);
    for (const { why, content } of event?.reject ?? []) expect(wellFormedOutcome(content), why).toBe(false);
  });
});
