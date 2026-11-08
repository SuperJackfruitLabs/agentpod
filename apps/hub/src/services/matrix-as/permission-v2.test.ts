process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { rawSql } from "../../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUsers } from "../../../tests/helpers/database";
import { expirePermissions } from "./permission-answer";
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
  permissionV2Content,
} from "./permission-wire";
import { clearPendingPermission, notePendingPermission, pendingPermissionFor } from "./permissions";

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
