import { describe, it, expect } from "bun:test";
import {
  AcpSessionMode,
  AcpSessionStatus,
  AcpSessionRow,
  AcpEventType,
  AcpEvent,
  AcpClientMsg,
  AcpServerMsg,
  TurnError,
  TurnErrorPayload,
} from "./acp-session";

it("AcpSessionRow round-trips a full row", () => {
  const row = {
    id: "acp_1", stationId: "station_1", userId: "user_1",
    mode: "ask", status: "idle", endedReason: null,
    createdAt: "2026-08-09T00:00:00.000Z", lastEventAt: "2026-08-09T00:00:01.000Z",
  };
  expect(AcpSessionRow.parse(row)).toEqual(row);
});

describe("AcpSessionRow title + lastSeq (slice 4c) are cross-version tolerant", () => {
  const base = {
    id: "acp_1", stationId: "station_1", userId: "user_1",
    mode: "ask", status: "idle", endedReason: null,
    createdAt: "2026-08-09T00:00:00.000Z", lastEventAt: "2026-08-09T00:00:01.000Z",
  };

  it("parses a row WITH title and lastSeq", () => {
    const row = { ...base, title: "Fix the flaky gateway test", lastSeq: 42 };
    expect(AcpSessionRow.parse(row)).toEqual(row);
  });

  it("parses a row WITHOUT title or lastSeq (rows from an older hub)", () => {
    expect(AcpSessionRow.parse(base)).toEqual(base);
  });

  it("parses title: null (no prompt sent yet)", () => {
    const row = { ...base, title: null, lastSeq: 0 };
    expect(AcpSessionRow.parse(row)).toEqual(row);
  });

  it("rejects a non-integer lastSeq", () => {
    expect(() => AcpSessionRow.parse({ ...base, lastSeq: 1.5 })).toThrow();
    expect(() => AcpSessionRow.parse({ ...base, lastSeq: "7" })).toThrow();
  });
});

it("AcpSessionMode and AcpSessionStatus reject unknown values", () => {
  expect(() => AcpSessionMode.parse("yolo")).toThrow();
  expect(() => AcpSessionStatus.parse("bogus")).toThrow();
});

it("AcpEvent accepts an arbitrary payload shape", () => {
  const event = {
    sessionId: "acp_1", seq: 3, type: "agent-update",
    payload: { anything: { nested: [1, 2, 3] }, sessionUpdate: "foo" },
    createdAt: "2026-08-09T00:00:02.000Z",
  };
  expect(AcpEvent.parse(event)).toEqual(event);
});

it("AcpEventType covers the transcript event kinds", () => {
  for (const t of ["user-prompt", "agent-update", "permission-request", "permission-answer", "state", "error"]) {
    expect(AcpEventType.parse(t)).toBe(t);
  }
});

describe("AcpClientMsg round-trips each variant", () => {
  it("subscribe", () => {
    expect(AcpClientMsg.parse({ t: "subscribe", sinceSeq: 0 })).toEqual({ t: "subscribe", sinceSeq: 0 });
  });
  it("prompt", () => {
    expect(AcpClientMsg.parse({ t: "prompt", text: "hi" })).toEqual({ t: "prompt", text: "hi" });
    expect(() => AcpClientMsg.parse({ t: "prompt", text: "" })).toThrow();
  });
  it("cancel", () => {
    expect(AcpClientMsg.parse({ t: "cancel" })).toEqual({ t: "cancel" });
  });
  it("permission-answer", () => {
    expect(AcpClientMsg.parse({ t: "permission-answer", requestSeq: 2, optionId: "allow" }))
      .toEqual({ t: "permission-answer", requestSeq: 2, optionId: "allow" });
  });
  it("set-mode", () => {
    expect(AcpClientMsg.parse({ t: "set-mode", mode: "full-auto" }))
      .toEqual({ t: "set-mode", mode: "full-auto" });
  });
  it("rejects an unknown discriminant", () => {
    expect(() => AcpClientMsg.parse({ t: "nope" })).toThrow();
  });
});

describe("AcpServerMsg round-trips each variant", () => {
  it("event", () => {
    const event = { sessionId: "acp_1", seq: 0, type: "state", payload: {}, createdAt: "2026-08-09T00:00:00.000Z" };
    expect(AcpServerMsg.parse({ t: "event", event })).toEqual({ t: "event", event });
  });
  it("replay-done", () => {
    expect(AcpServerMsg.parse({ t: "replay-done", lastSeq: 5 })).toEqual({ t: "replay-done", lastSeq: 5 });
  });
  it("session", () => {
    const session = {
      id: "acp_1", stationId: "station_1", userId: "user_1",
      mode: "accept-edits", status: "working", endedReason: null,
      createdAt: "2026-08-09T00:00:00.000Z", lastEventAt: "2026-08-09T00:00:00.000Z",
    };
    expect(AcpServerMsg.parse({ t: "session", session })).toEqual({ t: "session", session });
  });
  it("bye", () => {
    expect(AcpServerMsg.parse({ t: "bye", reason: "session ended" })).toEqual({ t: "bye", reason: "session ended" });
  });
  it("rejects an unknown discriminant", () => {
    expect(() => AcpServerMsg.parse({ t: "nope" })).toThrow();
  });
});

describe("TurnError — one error shape, whichever harness failed", () => {
  const openclawQuota = {
    message: "You've reached your weekly (7-day) usage limit.",
    kind: "quota",
    harness: "openclaw",
    provider: "kimi-coding",
    model: "k2p6",
    retryable: false,
    source: "plugin",
    attempts: [
      { provider: "kimi-coding", model: "k2p6", kind: "quota", message: "403 weekly usage limit" },
      { provider: "opencode-go", model: "qwen3.7-plus", kind: "bad_request", message: "400 MissingSessionID" },
    ],
  };

  it("parses a full error, fallback chain included", () => {
    expect(TurnError.parse(openclawQuota)).toEqual(openclawQuota);
  });

  it("needs only message, kind, harness and source", () => {
    const bare = { message: "The agent completed without a reply.", kind: "unknown", harness: "pi", source: "acp-stop-reason" };
    expect(TurnError.parse(bare)).toEqual(bare);
  });

  it("an old error payload, message only, is still a valid error event payload", () => {
    // Every reader before this change reads `payload.message`. It must stay the
    // one field that is always there, at the top level.
    expect(TurnErrorPayload.safeParse({ message: "harness exited" }).success).toBe(true);
    expect(TurnErrorPayload.safeParse({ kind: "quota" }).success).toBe(false);
  });

  it("refuses a kind it does not know rather than guessing one", () => {
    expect(TurnError.safeParse({ ...openclawQuota, kind: "cosmic_rays" }).success).toBe(false);
  });
});
