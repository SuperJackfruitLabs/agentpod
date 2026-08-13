import { describe, it, expect } from "bun:test";
import { ProvisionRequest, ProvisionedRuntime, RuntimeStatus } from "./runtime";
import { RuntimeHarness } from "./runtime";
import {
  HARNESS_MIN_MEMORY_MB,
  RuntimeProviderManifest,
  harnessTiersFor,
  tierFitsHarness,
  viableTiersForHarness,
} from "./runtime";

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

// ─── Harness-aware tiers (issue #279) ────────────────────────────────────────

describe("HARNESS_MIN_MEMORY_MB", () => {
  it("states a requirement for opencode that a 1 GB tier cannot meet", () => {
    // Measured on a Fly `small` (1024 MB, 962 usable) on 2026-08-13: idle
    // `opencode serve` was 321 MB RSS; ONE chat turn spawned a second opencode
    // process and the pair peaked at 855 MB, leaving 58 MB available. With the
    // node-agent and the OS beneath it that is the whole machine.
    expect(HARNESS_MIN_MEMORY_MB.opencode).toBeGreaterThan(1024);
  });

  it("asks nothing of a bare node", () => {
    // `none` is a node-agent with no harness — the case a 1 GB box does run.
    expect(HARNESS_MIN_MEMORY_MB.none).toBe(0);
  });

  it("has an entry for every harness the contract can provision", () => {
    // A harness added to RuntimeHarness without a number here would be silently
    // unconstrained, which is how this class of bug got shipped the first time.
    for (const harness of RuntimeHarness.options) {
      expect(typeof HARNESS_MIN_MEMORY_MB[harness]).toBe("number");
    }
  });
});

describe("tierFitsHarness", () => {
  it("refuses opencode on a tier smaller than its requirement", () => {
    expect(tierFitsHarness("opencode", 1024)).toBe(false);
  });

  it("allows opencode on a tier that meets it exactly", () => {
    expect(tierFitsHarness("opencode", HARNESS_MIN_MEMORY_MB.opencode)).toBe(true);
  });

  it("allows a harness with no requirement on the smallest tier", () => {
    expect(tierFitsHarness("none", 256)).toBe(true);
  });

  it("does not refuse when the driver declares no memory for the tier", () => {
    // Evidence-only, like every other claim in the manifest: a driver that has
    // not measured a tier must not have a number invented for it.
    expect(tierFitsHarness("opencode", undefined)).toBe(true);
  });

  it("does not refuse a harness it has never heard of", () => {
    expect(tierFitsHarness("some-future-harness", 256)).toBe(true);
  });
});

describe("viableTiersForHarness", () => {
  const TIERS = ["small", "medium", "large"] as const;
  const MEMORY = { small: 1024, medium: 2048, large: 4096 };

  it("drops the tiers opencode cannot run in", () => {
    expect(viableTiersForHarness("opencode", TIERS, MEMORY)).toEqual(["medium", "large"]);
  });

  it("keeps every tier for a harness with no requirement", () => {
    expect(viableTiersForHarness("none", TIERS, MEMORY)).toEqual(["small", "medium", "large"]);
  });

  it("can answer 'none of them' for a provider fixed at one small tier", () => {
    // Cloudflare fixes instance_type at deploy time. A worker deployed small
    // cannot run opencode at all, and saying so is more useful than offering it.
    expect(viableTiersForHarness("opencode", ["small"], { small: 1024 })).toEqual([]);
  });

  it("is the identity when the driver declares no memory at all", () => {
    expect(viableTiersForHarness("opencode", TIERS, undefined)).toEqual([
      "small",
      "medium",
      "large",
    ]);
  });
});

describe("harnessTiersFor", () => {
  it("answers for every harness, so the console filters rather than guesses", () => {
    const map = harnessTiersFor(["small", "medium", "large"], {
      small: 1024,
      medium: 2048,
      large: 4096,
    });
    expect(map.opencode).toEqual(["medium", "large"]);
    expect(map.none).toEqual(["small", "medium", "large"]);
    for (const harness of RuntimeHarness.options) {
      expect(Array.isArray(map[harness])).toBe(true);
    }
  });
});

describe("RuntimeProviderManifest", () => {
  const BASE = { provider: "fly", supportedTiers: ["small", "medium", "large"] };

  it("carries the memory each tier gives and the tiers each harness can use", () => {
    const parsed = RuntimeProviderManifest.parse({
      ...BASE,
      tierMemoryMb: { small: 1024, medium: 2048, large: 4096 },
      harnessTiers: {
        none: ["small", "medium", "large"],
        opencode: ["medium", "large"],
        pi: ["small", "medium", "large"],
      },
    });
    expect(parsed.tierMemoryMb?.small).toBe(1024);
    expect(parsed.harnessTiers?.opencode).toEqual(["medium", "large"]);
  });

  it("still parses a manifest from a hub too old to send the new fields", () => {
    // Hub and console deploy separately; an older hub must not blank the dialog.
    const parsed = RuntimeProviderManifest.parse(BASE);
    expect(parsed.harnessTiers).toBeUndefined();
    expect(parsed.supportedTiers).toEqual(["small", "medium", "large"]);
  });

  it("rejects a tier memory that is not a positive number", () => {
    expect(() =>
      RuntimeProviderManifest.parse({ ...BASE, tierMemoryMb: { small: 0 } })
    ).toThrow();
  });
});
