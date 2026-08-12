import { describe, it, expect } from "bun:test";
import { ProvisionRequest, ProvisionedRuntime, RuntimeStatus } from "./runtime";
import { RuntimeHarness } from "./runtime";

describe("ProvisionRequest", () => {
  it("applies default resourceTier=small when omitted", () => {
    const result = ProvisionRequest.parse({ provider: "docker", name: "box1" });
    expect(result.resourceTier).toBe("small");
  });

  it("throws for an invalid provider", () => {
    expect(() => ProvisionRequest.parse({ provider: "bogus", name: "x" })).toThrow();
  });

  it("throws when name is empty string (min 1)", () => {
    expect(() => ProvisionRequest.parse({ provider: "docker", name: "" })).toThrow();
  });
});

describe("ProvisionRequest harness", () => {
  it("applies default harness=none when omitted", () => {
    const result = ProvisionRequest.parse({ provider: "docker", name: "x" });
    expect(result.harness).toBe("none");
  });

  it("accepts harness=opencode", () => {
    const result = ProvisionRequest.parse({ provider: "docker", name: "x", harness: "opencode" });
    expect(result.harness).toBe("opencode");
  });

  it("accepts pi as a provisionable harness", () => {
    // The value must be exactly "pi": the Go descriptor's Harness() returns
    // "pi" and auto-adoption matches it against a runtime's harness by string
    // equality, so any other spelling silently breaks adoption.
    expect(ProvisionRequest.parse({ provider: "docker", name: "x", resourceTier: "small", harness: "pi" }).harness).toBe("pi");
  });

  it("throws for an invalid harness value", () => {
    expect(() => ProvisionRequest.parse({ provider: "docker", name: "x", harness: "bogus" })).toThrow();
  });
});

describe("ProvisionedRuntime", () => {
  const valid = {
    id: "rt-1",
    ownerId: "user-1",
    provider: "docker",
    externalId: "container-abc",
    status: "provisioning",
    nodeId: "node-1",
    name: "box1",
    resourceTier: "small",
    harness: "opencode",
    createdAt: "2026-06-29T00:00:00.000Z",
    updatedAt: "2026-06-29T00:00:00.000Z",
  };

  it("round-trips a full valid object", () => {
    const result = ProvisionedRuntime.parse(valid);
    expect(result.id).toBe("rt-1");
    expect(result.provider).toBe("docker");
    expect(result.status).toBe("provisioning");
    expect(result.resourceTier).toBe("small");
    expect(result.harness).toBe("opencode");
  });

  it("accepts null for externalId and nodeId", () => {
    const result = ProvisionedRuntime.parse({ ...valid, externalId: null, nodeId: null });
    expect(result.externalId).toBeNull();
    expect(result.nodeId).toBeNull();
  });
});

// ─── container runtime ───────────────────────────────────────────────────────

describe("ProvisionedRuntime.runtime", () => {
  const BASE = {
    id: "rt_1", ownerId: "u_1", provider: "docker" as const, externalId: "abc",
    status: "online" as const, nodeId: null, name: "n",
    resourceTier: "small" as const, harness: "opencode" as const,
    createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z",
  };

  it("can report the container runtime it runs under", () => {
    expect(ProvisionedRuntime.parse({ ...BASE, runtime: "runsc" }).runtime).toBe("runsc");
  });

  it("is absent on rows that predate it and providers without the concept", () => {
    // Null rather than a guess: a Cloudflare sandbox has no container runtime,
    // and a row created before this field existed never had one recorded.
    expect(ProvisionedRuntime.parse(BASE).runtime).toBeUndefined();
    expect(ProvisionedRuntime.parse({ ...BASE, runtime: null }).runtime).toBeNull();
  });
});

describe("RuntimeStatus asleep", () => {
  it("accepts asleep", () => {
    // A slept container is not stopped and not broken. Without its own value the
    // console cannot tell an operator "this idled out" from "this failed".
    expect(RuntimeStatus.parse("asleep")).toBe("asleep");
  });

  it("keeps stopped distinct", () => {
    // `stopped` means an operator did it. Collapsing the two would lose the
    // difference between "I did that" and "it happened on its own".
    expect(RuntimeStatus.parse("stopped")).toBe("stopped");
  });
});
