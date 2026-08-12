import { describe, it, expect } from "bun:test";
import { ProvisionRequest, ProvisionedRuntime, RuntimeStatus } from "./runtime";
import { RuntimeHarness } from "./runtime";

describe("ProvisionRequest", () => {
  it("applies default resourceTier=small when omitted", () => {
    const result = ProvisionRequest.parse({ provider: "docker", name: "box1" });
    expect(result.resourceTier).toBe("small");
  });

  it("accepts any provider name — the registry decides what is valid, not the enum", () => {
    // A driver the contract has never heard of must be expressible on the wire:
    // adding Fly or Modal should touch the driver and nothing else. The enum
    // that used to live here made "add a provider" a three-package edit.
    const r = ProvisionRequest.parse({ provider: "fly", name: "x", resourceTier: "small" });
    expect(r.provider).toBe("fly");
  });

  it("still rejects an empty provider", () => {
    // Widening the wire format is not the same as accepting anything: the shape
    // is still checked here, and *which* names the hub will actually provision
    // is checked by the registry — see the 400 for an unregistered provider in
    // apps/hub/src/routes/runtimes.test.ts.
    expect(() => ProvisionRequest.parse({ provider: "", name: "x" })).toThrow();
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

describe("RuntimeStatus starting", () => {
  it("accepts starting", () => {
    // "the substrate accepted a start request" is not "a node is connected".
    // Without its own value the hub had to claim online on no evidence.
    expect(RuntimeStatus.parse("starting")).toBe("starting");
  });

  it("keeps online distinct", () => {
    // online is now a claim about a node actually being connected.
    expect(RuntimeStatus.parse("online")).toBe("online");
  });
});

describe("RuntimeStatus stopping", () => {
  it("accepts stopping", () => {
    // "the substrate accepted a stop request" is not "the container is down".
    // Without its own value the hub had to claim stopped on no evidence, and an
    // operator reads stopped as "billing has ended".
    expect(RuntimeStatus.parse("stopping")).toBe("stopping");
  });

  it("keeps stopped distinct", () => {
    // stopped is now a claim the substrate itself has confirmed.
    expect(RuntimeStatus.parse("stopped")).toBe("stopped");
  });
});

describe("ProvisionedRuntime.statusReason", () => {
  const BASE = {
    id: "rt_1", ownerId: "u_1", provider: "docker" as const, externalId: "abc",
    status: "error" as const, nodeId: null, name: "n",
    resourceTier: "small" as const, harness: "none" as const,
    createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z",
  };

  it("carries why a runtime failed", () => {
    const parsed = ProvisionedRuntime.parse({
      ...BASE,
      statusReason: "no node enrolled within 2m of the start request",
    });
    expect(parsed.statusReason).toContain("no node enrolled");
  });

  it("is absent when there is nothing to explain", () => {
    expect(ProvisionedRuntime.parse(BASE).statusReason).toBeUndefined();
    expect(ProvisionedRuntime.parse({ ...BASE, statusReason: null }).statusReason).toBeNull();
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
