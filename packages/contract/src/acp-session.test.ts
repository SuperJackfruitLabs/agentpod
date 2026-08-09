import { describe, it, expect } from "bun:test";
import {
  AcpSessionMode,
  AcpSessionStatus,
  AcpSessionRow,
  AcpEventType,
  AcpEvent,
  AcpClientMsg,
  AcpServerMsg,
} from "./acp-session";

it("AcpSessionRow round-trips a full row", () => {
  const row = {
    id: "acp_1", stationId: "station_1", userId: "user_1",
    mode: "ask", status: "idle", endedReason: null,
    createdAt: "2026-08-09T00:00:00.000Z", lastEventAt: "2026-08-09T00:00:01.000Z",
  };
  expect(AcpSessionRow.parse(row)).toEqual(row);
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
