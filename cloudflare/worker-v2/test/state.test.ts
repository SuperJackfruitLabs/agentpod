import { describe, it, expect } from "vitest";
import { deriveState, handleStatus, STATE_KEY } from "../src/state";

describe("deriveState", () => {
  it("answers from the runtime's own view of the container", () => {
    // ctx.container.running is the substrate speaking, not our record of what
    // we last saw it do. Nothing beats it.
    expect(deriveState(true, undefined)).toBe("running");
    expect(deriveState(false, undefined)).toBe("stopped");
  });

  it("prefers the runtime over a stale lifecycle record", () => {
    // A record says what happened once; `running` says what is true now.
    expect(deriveState(true, { state: "stopped", at: "2026-08-12T00:00:00Z" })).toBe("running");
    expect(deriveState(false, { state: "running", at: "2026-08-12T00:00:00Z" })).toBe("stopped");
  });

  it("falls back to the recorded lifecycle when there is no container binding", () => {
    expect(deriveState(undefined, { state: "stopped", at: "x" })).toBe("stopped");
    expect(deriveState(undefined, { state: "running", at: "x" })).toBe("running");
  });

  it("says unknown rather than guessing when it has nothing to go on", () => {
    // The hub turns "stopped" into "this is no longer costing you money".
    // Never invent that: an honest unknown keeps it asking.
    expect(deriveState(undefined, undefined)).toBe("unknown");
    expect(deriveState(undefined, null)).toBe("unknown");
    expect(deriveState(undefined, { state: "banana" })).toBe("unknown");
    expect(deriveState(undefined, "stopped")).toBe("unknown");
  });
});

describe("handleStatus", () => {
  const read = async (res: Response) => (await res.json()) as Record<string, unknown>;

  it("reports the sandbox id and its container state", async () => {
    const res = await handleStatus("rt_abc", { state: async () => "running" });
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ sandboxId: "rt_abc", state: "running" });
  });

  it("reports a stopped container as stopped", async () => {
    const res = await handleStatus("rt_abc", { state: async () => "stopped" });
    expect(await read(res)).toMatchObject({ state: "stopped" });
  });

  it("keeps sandboxId, so the pre-existing response shape still holds", async () => {
    // The hub's older code and anything else reading this route must not break
    // just because the route learned to say more.
    const res = await handleStatus("rt_abc", { state: async () => "unknown" });
    expect(await read(res)).toEqual({ sandboxId: "rt_abc", state: "unknown" });
  });

  it("never emits a state outside the three the hub understands", async () => {
    const res = await handleStatus("rt_abc", { state: async () => "asleep" });
    expect(await read(res)).toMatchObject({ state: "unknown" });
  });

  it("says unknown instead of failing when the container cannot be asked", async () => {
    // A 500 here would be indistinguishable from a worker that has not been
    // redeployed. Unknown is an answer the hub knows how to handle.
    const res = await handleStatus("rt_abc", {
      state: async () => {
        throw new Error("durable object exploded");
      },
    });
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ state: "unknown" });
  });

  it("keys the lifecycle record under a stable name", () => {
    // Renaming this silently would make every existing sandbox report unknown.
    expect(STATE_KEY).toBe("lifecycleState");
  });
});
