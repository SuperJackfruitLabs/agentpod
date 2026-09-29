import { describe, expect, it } from "bun:test";
import { ApnsPushPayload, PushCategory } from "./push";

const plain = {
  aps: {
    alert: { title: "supermessage", body: "New message" },
    "mutable-content": 1,
    sound: "default",
    badge: 3,
    "thread-id": "!room:id.agentpod.dev",
  },
  room_id: "!room:id.agentpod.dev",
  event_id: "$ev",
  unread_count: 3,
};

describe("ApnsPushPayload — everything a push may carry, and nothing else", () => {
  it("accepts the plain push and a tagged one", () => {
    expect(ApnsPushPayload.parse(plain)).toEqual(plain);
    const tagged = { ...plain, aps: { ...plain.aps, category: "PERMISSION", "interruption-level": "time-sensitive" } };
    expect(ApnsPushPayload.parse(tagged)).toEqual(tagged);
  });

  it("refuses any field it does not list — a message's words have nowhere to go", () => {
    expect(ApnsPushPayload.safeParse({ ...plain, body: "hello" }).success).toBe(false);
    expect(ApnsPushPayload.safeParse({ ...plain, aps: { ...plain.aps, alert: { title: "supermessage", body: "hello" } } }).success).toBe(false);
    expect(ApnsPushPayload.safeParse({ ...plain, aps: { ...plain.aps, subtitle: "x" } }).success).toBe(false);
  });

  it("has exactly two categories", () => {
    expect(PushCategory.options).toEqual(["PERMISSION", "GATE"]);
  });
});

describe("ApnsPushPayload — a turn's outcome on the answer push", () => {
  it("carries counts, and only counts", () => {
    const withTurn = { ...plain, turn: { total: 7, failed: 1 } };
    expect(ApnsPushPayload.parse(withTurn)).toEqual(withTurn);
    expect(ApnsPushPayload.safeParse({ ...plain, turn: { total: 7, failed: 1, step: "Running the tests" } }).success).toBe(false);
    expect(ApnsPushPayload.safeParse({ ...plain, turn: { total: -1, failed: 0 } }).success).toBe(false);
  });
});
