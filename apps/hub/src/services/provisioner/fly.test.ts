/**
 * Unit tests: FlyMachinesProvisioner.
 *
 * No real Fly. fly-fake-substrate.ts implements the real routes in memory, and
 * every test passes `pacer: noPacer` so the suite does not spend a second per
 * call obeying a rate limit that does not exist in a fake.
 */

import { describe, it, expect } from "bun:test";
import { noPacer } from "./fly-api";
import {
  FlyMachinesProvisioner,
  formatFlyExternalId,
  parseFlyExternalId,
} from "./fly";
import type { FlyMachinesOptions } from "./fly";
import { createFlyFakeSubstrate } from "./fly-fake-substrate";
import type { ProvisionSpec } from "./types";

describe("FlyMachinesProvisioner — declarations", () => {
  const make = () =>
    new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      pacer: noPacer,
    });

  it("declares what was MEASURED on a real Fly account, not what the docs claim", () => {
    const m = make().manifest;

    // 2026-08-12: a sentinel written to / was GONE after stop→start; the same
    // sentinel on a mounted volume survived. persist_rootfs is not used — Fly's
    // own docs disclaim it for critical data.
    expect(m.workspaceStorage).toBe("volume");
    // The machine id and the volume both survived stop→start.
    expect(m.stopSemantics).toBe("resumable");
    // Fly destroys nothing for age.
    expect(m.maxLifetimeMs).toBeNull();
    // Unlike Cloudflare, config.image is per machine.
    expect(m.imageBinding).toBe("per-instance");
    // config.guest is per machine too, so all three tiers are real.
    expect(m.supportedTiers).toEqual(["small", "medium", "large"]);
    // 2026-08-12: 25 minutes idle with only outbound traffic, sampled every 5
    // minutes, `started` throughout. Autostop is Fly-Proxy-driven and only
    // touches machines with inbound `services`; this driver defines none.
    expect(m.idleBehaviour).toBe("hub-driven");
    expect(m.lifecycle).toEqual(expect.arrayContaining(["start", "stop", "status"]));
  });

  it("names itself so the registry gates it on ENABLE_FLY_PROVISIONING", () => {
    expect(make().provider).toBe("fly");
    expect(make().manifest.provider).toBe("fly");
  });

  it("REFUSES TO CONSTRUCT without a Fly token, naming the variable", () => {
    // A missing credential is a startup-time refusal to register, not a runtime
    // failure on a user's first provisioning attempt.
    expect(
      () => new FlyMachinesProvisioner({ credentials: { get: () => undefined }, pacer: noPacer })
    ).toThrow(/FLY_API_TOKEN/);
  });

  it("treats an empty token as missing", () => {
    // Deploy platforms surface an unset secret as "". Handing the driver a
    // blank token only moves the failure to the first API call, where it reads
    // as an auth problem rather than a configuration one.
    expect(
      () => new FlyMachinesProvisioner({ credentials: { get: () => "" }, pacer: noPacer })
    ).toThrow(/FLY_API_TOKEN/);
  });
});

describe("fly external ids", () => {
  it("carries both halves of the handle, because a machine id alone is not addressable", () => {
    // Every Fly route is /v1/apps/{app}/machines/{id}. The hub stores ONE
    // string, so it has to be both.
    expect(formatFlyExternalId("agentpod-rt-abc", "17811953b12345")).toBe(
      "agentpod-rt-abc/17811953b12345"
    );
    expect(parseFlyExternalId("agentpod-rt-abc/17811953b12345")).toEqual({
      app: "agentpod-rt-abc",
      machineId: "17811953b12345",
    });
  });

  it("refuses a malformed id rather than building a nonsense URL", () => {
    expect(() => parseFlyExternalId("no-slash-here")).toThrow(/malformed external id/);
    expect(() => parseFlyExternalId("/machine-only")).toThrow(/malformed external id/);
    expect(() => parseFlyExternalId("app-only/")).toThrow(/malformed external id/);
  });
});

const SPEC: ProvisionSpec = {
  runtimeId: "rt_abc123def456",
  name: "demo",
  resourceTier: "small",
  hubUrl: "https://hub.example",
  enrollToken: "enr_secret",
  image: "ghcr.io/example/agentpod-node-opencode:v0.1.22",
};

function flyDriver(overrides: Partial<FlyMachinesOptions> = {}) {
  const fake = createFlyFakeSubstrate();
  const driver = new FlyMachinesProvisioner({
    credentials: { get: () => "fly-token" },
    orgSlug: "acme",
    region: "sin",
    appPrefix: "agentpod",
    volumeSizeGb: 3,
    fetchImpl: fake.fetchImpl,
    pacer: noPacer,
    ...overrides,
  });
  return { driver, fake };
}

describe("FlyMachinesProvisioner — provision", () => {
  it("creates the app, THEN the volume, THEN the machine", async () => {
    // Not stylistic. A Fly volume is pinned to a physical host; a machine
    // created before its volume can land on a different host and fail to
    // attach.
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const writes = fake.calls
      .filter((c) => c.method === "POST")
      .map((c) => c.path);
    expect(writes).toEqual([
      "/v1/apps",
      "/v1/apps/agentpod-rt-abc123def456/volumes",
      "/v1/apps/agentpod-rt-abc123def456/machines",
    ]);
  });

  it("returns an external id carrying both the app and the machine", async () => {
    const { driver, fake } = flyDriver();
    const res = await driver.provision(SPEC);

    const app = fake.apps.get("agentpod-rt-abc123def456")!;
    const machineId = [...app.machines.keys()][0]!;
    expect(res.externalId).toBe(`agentpod-rt-abc123def456/${machineId}`);
    expect(res.runtime).toBe("fly-machine");
  });

  it("gives each runtime its own 6PN network", async () => {
    // A shared network would put every customer's station on one private
    // network, reachable from each other by internal DNS.
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path === "/v1/apps")!;
    expect(create.body).toEqual({
      app_name: "agentpod-rt-abc123def456",
      org_slug: "acme",
      network: "agentpod-rt-abc123def456",
    });
  });

  it("NEVER defines a services block", async () => {
    // This one line is the entire reason Fly does not reap a busy station.
    // Autostop is Fly-Proxy-driven and only touches machines with inbound
    // services configured; adding one here would recreate the Cloudflare
    // failure exactly — a station that dials out and receives nothing reads as
    // idle while it is busy.
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    const config = (create.body as { config: Record<string, unknown> }).config;
    expect(config).not.toHaveProperty("services");
    expect(JSON.stringify(create.body)).not.toContain("services");
  });

  it("never asks for persist_rootfs", async () => {
    // Fly's own docs disclaim it for critical data, and the 2026-08-12 probe
    // could not establish that it survives a full stop→start. The volume is
    // the answer; this is the trap next to it.
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    expect(JSON.stringify(create.body)).not.toContain("persist_rootfs");
  });

  it("restarts always, because the default leaves a cleanly-exited machine down", async () => {
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    const config = (create.body as { config: Record<string, unknown> }).config;
    expect(config.restart).toEqual({ policy: "always" });
  });

  it("mounts the volume it just created, at the path the image expects", async () => {
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const app = fake.apps.get("agentpod-rt-abc123def456")!;
    const volumeId = [...app.volumes.values()][0]!.id;

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    const config = (create.body as { config: Record<string, unknown> }).config;
    expect(config.mounts).toEqual([{ volume: volumeId, path: "/data" }]);
  });

  it("points HOME at the volume, so the node identity survives a stop", async () => {
    // agentpod-node stores nodeId/nodeSecret at os.UserConfigDir()/agentpod-node
    // /config.json — i.e. under HOME. On the rootfs that is wiped every stop.
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    const config = (create.body as { config: { env: Record<string, string> } }).config;
    expect(config.env.HOME).toBe("/data/home");
    expect(config.env.AGENTPOD_HUB_URL).toBe("https://hub.example");
    expect(config.env.AGENTPOD_ENROLL_TOKEN).toBe("enr_secret");
  });

  it("stamps the runtime id in machine metadata for reconciliation", async () => {
    const { driver, fake } = flyDriver();
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    const config = (create.body as { config: Record<string, unknown> }).config;
    expect(config.metadata).toEqual({
      agentpod_runtime_id: "rt_abc123def456",
      agentpod_managed: "true",
    });
  });

  it("HONOURS spec.image, which is what imageBinding per-instance promises", async () => {
    const { driver, fake } = flyDriver();
    await driver.provision({ ...SPEC, image: "ghcr.io/example/other:v9" });

    const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
    const config = (create.body as { config: Record<string, string> }).config;
    expect(config.image).toBe("ghcr.io/example/other:v9");
  });

  it("maps every declared tier to a real guest inside Fly's shared-CPU rules", async () => {
    // memory_mb must be a multiple of 256 and within [256×cpus, 2048×cpus].
    const expected = {
      small: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
      medium: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
      large: { cpu_kind: "shared", cpus: 4, memory_mb: 4096 },
    } as const;

    for (const tier of ["small", "medium", "large"] as const) {
      const { driver, fake } = flyDriver();
      await driver.provision({ ...SPEC, runtimeId: `rt_${tier}`, resourceTier: tier });
      const create = fake.calls.find((c) => c.path.endsWith("/machines"))!;
      const config = (create.body as { config: Record<string, unknown> }).config;
      expect(config.guest).toEqual(expected[tier]);
      expect(expected[tier].memory_mb % 256).toBe(0);
      expect(expected[tier].memory_mb).toBeLessThanOrEqual(2048 * expected[tier].cpus);
    }
  });

  it("creates the volume in the configured region at the configured size", async () => {
    const { driver, fake } = flyDriver({ region: "iad", volumeSizeGb: 10 });
    await driver.provision(SPEC);

    const create = fake.calls.find((c) => c.path.endsWith("/volumes"))!;
    expect(create.body).toEqual({ name: "agentpod_data", region: "iad", size_gb: 10 });
  });

  it("tolerates an app that already exists, so a retried provision is not wedged", async () => {
    const { driver } = flyDriver();
    await driver.provision(SPEC);
    // A second provision of the same runtime id: the app is already there,
    // which is the state ensureApp exists to produce.
    await expect(driver.provision(SPEC)).resolves.toMatchObject({
      runtime: "fly-machine",
    });
  });

  it("DELETES the app when the machine cannot be created", async () => {
    // provision() has not returned an externalId, so nothing will ever come
    // back for this app — and an orphaned app with a volume in it bills
    // monthly for a runtime the console never showed.
    const fake = createFlyFakeSubstrate({ failMachineCreate: true });
    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: fake.fetchImpl,
      pacer: noPacer,
    });

    await expect(driver.provision(SPEC)).rejects.toThrow(/fly/i);
    expect(fake.apps.has("agentpod-rt-abc123def456")).toBe(false);
  });

  it("EXPLAINS a region this account's plan refuses, and leaves no app behind", async () => {
    // Measured 2026-08-12: "bom" is refused with a sentence about a "legacy or
    // non-paid plan" that names no knob an operator could turn; "sin" works on
    // the same account. The refusal lands on the volume create, which is inside
    // provision's cleanup path — so this also pins that a provision failing for
    // a reason other than the machine create still takes its app with it.
    const { driver, fake } = flyDriver({ region: "bom" });

    const message = await driver
      .provision(SPEC)
      .then(() => "")
      .catch((e: Error) => e.message);

    expect(message).toMatch(/FLY_REGION/);
    expect(message).toMatch(/sin/);
    expect(fake.apps.has("agentpod-rt-abc123def456")).toBe(false);
  });

  it("rejects a response with no machine id rather than storing undefined", async () => {
    const impl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/machines")) {
        return new Response(JSON.stringify({ name: "no-id-here" }), { status: 200 });
      }
      if (path.endsWith("/volumes")) {
        return new Response(JSON.stringify({ id: "vol_1" }), { status: 201 });
      }
      return new Response("{}", { status: 201 });
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.provision(SPEC)).rejects.toThrow(/no machine id/i);
  });
});

describe("the Fly fake substrate is unfriendly where Fly is", () => {
  // The fake is what every later task's tests are checked against, so a
  // tolerant one would make all of them pass for free and prove nothing. These
  // assert the parts that push back, directly — a rule nobody can see fire is
  // a rule that can be deleted by accident.

  const call = (
    fake: ReturnType<typeof createFlyFakeSubstrate>,
    method: string,
    path: string,
    body?: unknown
  ) =>
    fake.fetchImpl(`https://api.machines.dev${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const newApp = async (fake: ReturnType<typeof createFlyFakeSubstrate>) => {
    await call(fake, "POST", "/v1/apps", { app_name: "a", org_slug: "o", network: "a" });
  };

  it("404s a machine that mounts a volume which does not exist", async () => {
    // The reason provision() creates the volume FIRST. A driver that reordered
    // the two calls would pass against a fake that shrugged at an unknown
    // volume id and fail on the first real provision.
    const fake = createFlyFakeSubstrate();
    await newApp(fake);
    const res = await call(fake, "POST", "/v1/apps/a/machines", {
      region: "sin",
      config: { mounts: [{ volume: "vol_nope", path: "/data" }] },
    });
    expect(res.status).toBe(404);
  });

  it("refuses a machine in a different region from its volume", async () => {
    // A Fly volume is pinned to one host, in one region. This is the same fact
    // as the ordering rule, one step further in: asking for the machine
    // somewhere else cannot work however carefully it is ordered.
    const fake = createFlyFakeSubstrate();
    await newApp(fake);
    const vol = (await (
      await call(fake, "POST", "/v1/apps/a/volumes", {
        name: "agentpod_data",
        region: "sin",
        size_gb: 3,
      })
    ).json()) as { id: string };

    const res = await call(fake, "POST", "/v1/apps/a/machines", {
      region: "iad",
      config: { mounts: [{ volume: vol.id, path: "/data" }] },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/region/);
  });

  it("409s an app that already exists, rather than quietly recreating it", async () => {
    // What makes ensureApp's tolerance a real branch instead of a comment.
    const fake = createFlyFakeSubstrate();
    await newApp(fake);
    expect((await call(fake, "POST", "/v1/apps", { app_name: "a" })).status).toBe(409);
  });

  it("refuses a region the plan does not cover, in Fly's own words", async () => {
    const fake = createFlyFakeSubstrate();
    await newApp(fake);
    const res = await call(fake, "POST", "/v1/apps/a/volumes", {
      name: "agentpod_data",
      region: "bom",
      size_gb: 3,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /legacy or non-paid plan/
    );
  });

  it("400s a wait for `stopped` that omits instance_id", async () => {
    // Real Fly requires it, and a fake that did not would let a driver ship a
    // stop whose wait 400s on the first live call.
    const fake = createFlyFakeSubstrate();
    await newApp(fake);
    const machine = (await (
      await call(fake, "POST", "/v1/apps/a/machines", { region: "sin", config: {} })
    ).json()) as { id: string };

    const without = await call(
      fake,
      "GET",
      `/v1/apps/a/machines/${machine.id}/wait?state=stopped`
    );
    expect(without.status).toBe(400);
  });

  it("404s everything about an app it has deleted", async () => {
    // Deleting the app takes the machine and the volume with it, and the 404
    // afterwards is what makes destroy idempotent rather than wedging a
    // half-destroyed runtime forever — the Docker bug, replayed.
    const fake = createFlyFakeSubstrate();
    await newApp(fake);
    const machine = (await (
      await call(fake, "POST", "/v1/apps/a/machines", { region: "sin", config: {} })
    ).json()) as { id: string };

    expect((await call(fake, "DELETE", "/v1/apps/a")).status).toBe(202);
    expect((await call(fake, "GET", `/v1/apps/a/machines/${machine.id}`)).status).toBe(404);
    expect((await call(fake, "DELETE", "/v1/apps/a")).status).toBe(404);
  });
});
