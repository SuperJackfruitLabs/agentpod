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
  flyStateToRuntimeState,
  formatFlyExternalId,
  parseFlyExternalId,
} from "./fly";
import type { FlyMachinesOptions } from "./fly";
import { createFlyFakeSubstrate } from "./fly-fake-substrate";
import type { ProvisionSpec } from "./types";
import { config } from "../../config";

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
    // What each tier actually gives, from FLY_TIERS itself rather than a second
    // copy of the numbers. Issue #279: `small` was offered for opencode, whose
    // measured peak is 855 MB of harness on top of ~157 MB of OS and node-agent
    // — the whole of a 1 GB machine. The hub can only refuse that pair if the
    // driver says how big its tiers are.
    expect(m.tierMemoryMb).toEqual({ small: 1024, medium: 2048, large: 4096 });
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

/**
 * Where the driver's non-secret settings come from.
 *
 * config.ts is the hub's single source of truth for settings, and for these
 * four it was a source of nothing: `config.fly.orgSlug`, `.region`,
 * `.appPrefix` and `.volumeSizeGb` were read by validate-config and by no one
 * else, while the driver read FLY_ORG_SLUG / FLY_REGION / FLY_APP_PREFIX /
 * FLY_VOLUME_SIZE_GB out of the environment a second time. Two independent
 * reads of the same variable agree only by coincidence — and the coincidence
 * had a sharp edge: boot validation refuses a `volumeSizeGb < 1`, so the value
 * it VALIDATES has to be the value the driver USES, or the check guards
 * nothing. Changing a default in config.ts would silently change nothing at
 * all.
 *
 * The TOKEN is deliberately excluded and stays on requireCredentials — that is
 * the seam a per-org encrypted credential store replaces. Non-secret settings
 * are a different question and belong in config.
 */
describe("FlyMachinesProvisioner — settings come from config", () => {
  // config is `as const` for callers; these tests are the exception that has to
  // write to it, so they cast, and they restore in a finally.
  function overrideFlyConfig(overrides: Partial<typeof config.fly>): () => void {
    const target = config.fly as unknown as Record<string, unknown>;
    const saved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(overrides)) {
      saved[key] = target[key];
      target[key] = value;
    }
    return () => {
      for (const [key, value] of Object.entries(saved)) target[key] = value;
    };
  }

  it("provisions with the org, region, prefix and volume size config holds", async () => {
    const restore = overrideFlyConfig({
      orgSlug: "acme-org",
      region: "fra",
      appPrefix: "acme",
      volumeSizeGb: 11,
    });
    try {
      const fake = createFlyFakeSubstrate();
      // No settings passed: these are the defaults, and the defaults are the
      // whole point.
      const driver = new FlyMachinesProvisioner({
        credentials: { get: () => "fly-token" },
        fetchImpl: fake.fetchImpl,
        pacer: noPacer,
      });

      await driver.provision(SPEC);

      const appCreate = fake.calls.find((c) => c.path === "/v1/apps")!;
      expect(appCreate.body).toMatchObject({
        app_name: "acme-rt-abc123def456",
        org_slug: "acme-org",
      });
      const volumeCreate = fake.calls.find((c) =>
        c.path.endsWith("/volumes")
      )!;
      expect(volumeCreate.body).toMatchObject({ region: "fra", size_gb: 11 });
    } finally {
      restore();
    }
  });

  it("does not re-read the environment behind config's back", async () => {
    // config is evaluated once, at import, and boot validation runs against
    // that snapshot. A driver that read process.env again at construction time
    // could provision against a value nothing had validated.
    const saved = process.env.FLY_REGION;
    process.env.FLY_REGION = "iad";
    try {
      const fake = createFlyFakeSubstrate();
      const driver = new FlyMachinesProvisioner({
        credentials: { get: () => "fly-token" },
        fetchImpl: fake.fetchImpl,
        pacer: noPacer,
      });

      await driver.provision(SPEC);

      const volumeCreate = fake.calls.find((c) => c.path.endsWith("/volumes"))!;
      expect(volumeCreate.body).toMatchObject({ region: config.fly.region });
    } finally {
      if (saved === undefined) delete process.env.FLY_REGION;
      else process.env.FLY_REGION = saved;
    }
  });

  it("still lets a caller pass settings explicitly", async () => {
    // Every other test in this file constructs the driver with explicit
    // settings; config is the DEFAULT, not a replacement for the argument.
    const { driver, fake } = flyDriver({ region: "iad", volumeSizeGb: 10 });
    await driver.provision(SPEC);
    const volumeCreate = fake.calls.find((c) => c.path.endsWith("/volumes"))!;
    expect(volumeCreate.body).toMatchObject({ region: "iad", size_gb: 10 });
  });
});

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

describe("FlyMachinesProvisioner — start", () => {
  it("starts the machine and waits for it to be started", async () => {
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app, machineId } = parseFlyExternalId(externalId);

    // Put it down first so start has something to do.
    const machine = fake.apps.get(app)!.machines.get(machineId)!;
    machine.state = "stopped";

    fake.calls.length = 0;
    await driver.start(externalId);

    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /v1/apps/${app}/machines/${machineId}/start`,
      `GET /v1/apps/${app}/machines/${machineId}/wait`,
    ]);
    expect(machine.state).toBe("started");
  });

  it("does not throw when the wait times out", async () => {
    // 408 is Fly saying "not yet", not "it failed". startRuntime writes
    // `starting`, never `online`, and sweepStalledRuntimeStarts walks a machine
    // that never arrives to `error` after two minutes. Throwing here would turn
    // a slow image pull into a 500 in the operator's face while the machine was
    // in fact coming up fine.
    const impl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/wait")) {
        return new Response(JSON.stringify({ error: "timeout reached" }), { status: 408 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.start("app-x/machine-y")).resolves.toBeUndefined();
  });

  it("DOES throw when the start itself is refused", async () => {
    // A 404 or a 422 is Fly refusing, not waiting. Swallowing that would leave
    // the runtime `starting` until the sweeper gave up two minutes later with a
    // reason that named nothing.
    const impl = (async () =>
      new Response(JSON.stringify({ error: "machine not found" }), {
        status: 404,
      })) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.start("app-x/machine-y")).rejects.toThrow(/machine not found/);
  });

  it("propagates a wait failure that is NOT a 408, so a timeout stays distinguishable from a fault", async () => {
    // The 408 tolerance is a narrow exemption for Fly's own "not yet", not a
    // blanket "whatever the wait says, carry on". A driver that swallowed every
    // wait failure would report a confident outcome on no evidence at all —
    // exactly the class of bug that produced #261 (a `stopped` written because a
    // call returned, not because anything confirmed it). The only reason this
    // narrowing is expressible is FlyApiError.status.
    const impl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/wait")) {
        return new Response(JSON.stringify({ error: "internal server error" }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.start("app-x/machine-y")).rejects.toThrow(/internal server error/);
  });

  it("sends state and timeout on the wait request", async () => {
    const urls: string[] = [];
    const impl = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await driver.start("app-x/machine-y");

    const wait = urls.find((u) => u.includes("/wait"))!;
    expect(wait).toBe(
      "https://api.machines.dev/v1/apps/app-x/machines/machine-y/wait?state=started&timeout=60"
    );
  });
});

describe("FlyMachinesProvisioner — stop", () => {
  it("reads the instance id, stops, then waits for stopped", async () => {
    // Fly REQUIRES instance_id when waiting for `stopped`. Omitting it makes
    // the wait 400, which the driver would surface as a failed stop for a
    // machine that stopped perfectly well.
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app, machineId } = parseFlyExternalId(externalId);

    fake.calls.length = 0;
    await driver.stop(externalId);

    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/apps/${app}/machines/${machineId}`,
      `POST /v1/apps/${app}/machines/${machineId}/stop`,
      `GET /v1/apps/${app}/machines/${machineId}/wait`,
    ]);
    expect(fake.apps.get(app)!.machines.get(machineId)!.state).toBe("stopped");
  });

  it("passes instance_id on the wait, which Fly rejects the request without", async () => {
    const urls: string[] = [];
    const impl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      urls.push(String(url));
      if (path.endsWith("/machine-y")) {
        return new Response(
          JSON.stringify({ id: "machine-y", instance_id: "inst-42", state: "started" }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await driver.stop("app-x/machine-y");

    const wait = urls.find((u) => u.includes("/wait"))!;
    expect(wait).toBe(
      "https://api.machines.dev/v1/apps/app-x/machines/machine-y/wait" +
        "?state=stopped&timeout=60&instance_id=inst-42"
    );
  });

  it("does not throw when the stop wait times out", async () => {
    // The hub writes `stopping` and sweepStalledRuntimeStops confirms on a
    // later tick via status(). A throw here would be a 500 on a stop that was
    // in fact proceeding.
    const impl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/wait")) {
        return new Response(JSON.stringify({ error: "timeout reached" }), { status: 408 });
      }
      return new Response(
        JSON.stringify({ id: "machine-y", instance_id: "inst-42", state: "started" }),
        { status: 200 }
      );
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.stop("app-x/machine-y")).resolves.toBeUndefined();
  });

  it("PROPAGATES a stop wait that failed for any other reason", async () => {
    // The 408 tolerance is one status wide on the stop path too, and here that
    // narrowness is worth more than anywhere else: `stopped` is an evidence-only
    // write (#260/#261), so a stop() that resolved on a wait which had in fact
    // been REFUSED would hand stopRuntime a clean return for a machine nobody
    // ever confirmed went down — an operator reads that as "it stopped costing
    // me money". A bare `catch { return }` passes every other test in this
    // describe; it does not pass this one.
    //
    // 400 is not hypothetical: it is precisely what Fly answers a stop-wait that
    // is missing instance_id, so a regression in the line above lands here too.
    for (const status of [400, 500]) {
      const impl = (async (url: string | URL) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/wait")) {
          return new Response(JSON.stringify({ error: `wait refused (${status})` }), {
            status,
          });
        }
        return new Response(
          JSON.stringify({ id: "machine-y", instance_id: "inst-42", state: "started" }),
          { status: 200 }
        );
      }) as unknown as typeof globalThis.fetch;

      const driver = new FlyMachinesProvisioner({
        credentials: { get: () => "fly-token" },
        fetchImpl: impl,
        pacer: noPacer,
      });
      await expect(driver.stop("app-x/machine-y")).rejects.toThrow(
        new RegExp(`wait refused \\(${status}\\)`)
      );
    }
  });

  it("still stops when the machine read gives no instance id", async () => {
    // An older or unusual response shape must not make the stop unreachable —
    // a runtime that cannot be stopped is a runtime that keeps billing.
    const urls: string[] = [];
    const impl = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      urls.push(String(url));
      if (path.endsWith("/machine-y")) {
        return new Response(JSON.stringify({ id: "machine-y", state: "started" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await driver.stop("app-x/machine-y");

    expect(urls.some((u) => u.includes("/stop"))).toBe(true);
    expect(urls.find((u) => u.includes("/wait"))).not.toContain("instance_id");
  });
});

describe("FlyMachinesProvisioner — status", () => {
  it("reads the machine and reports what Fly says", async () => {
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app, machineId } = parseFlyExternalId(externalId);

    expect(await driver.status(externalId)).toBe("running");

    fake.apps.get(app)!.machines.get(machineId)!.state = "stopped";
    expect(await driver.status(externalId)).toBe("stopped");
  });

  it("reports a machine caught MID-STOP as unknown, not stopped", async () => {
    // The one that matters. #260/#261 shipped because `stopped` was written on a
    // call returning rather than on evidence; status() is the evidence, so a
    // status() that rounded `stopping` to `stopped` would reintroduce that bug
    // one layer down, where the hub's evidence check cannot see it.
    //
    // The fake's POST .../stop settles synchronously and so cannot produce this
    // transient (fly-fake-substrate.ts says as much); the state is set on the map
    // directly, which is that file's documented way to exercise one.
    //
    // This asserts the WIRING, not the mapping: a status() that inlined
    // `body.state === "stopped"` would pass every flyStateToRuntimeState test
    // below and still hand stopRuntime a confirmed stop for a machine that is
    // still shutting down.
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app, machineId } = parseFlyExternalId(externalId);

    fake.apps.get(app)!.machines.get(machineId)!.state = "stopping";
    expect(await driver.status(externalId)).toBe("unknown");
  });

  it("reports a machine Fly has forgotten as stopped", async () => {
    // A machine that does not exist is not running and cannot be billing —
    // the same answer the Docker driver gives for a container the daemon has no
    // record of. This is a real answer, not a guess.
    const { driver } = flyDriver();
    expect(await driver.status("agentpod-gone/machine-gone")).toBe("stopped");
  });

  it("throws when Fly cannot be reached at all", async () => {
    // Not "unknown": a driver that cannot reach its substrate must say so, and
    // the service layer degrades a throw to `unknown` itself rather than
    // letting a network failure be laundered into an answer here.
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.status("app-x/machine-y")).rejects.toThrow(/fetch failed/);
  });

  it("PROPAGATES every Fly failure that is not a 404", async () => {
    // 404 is the only status that is an answer, and this is what keeps the
    // tolerance one status wide — a bare `catch { return "stopped" }` passes the
    // 404 test above and fails only here.
    //
    // 401 is the case that would hurt most: an expired FLY_API_TOKEN would
    // otherwise report every Fly runtime in the fleet as stopped at once, and
    // the hub would believe it and write it. 429 is Fly's rate limit, which this
    // driver's own pacer exists because of, and 500 is Fly having a bad day.
    // None of the three is evidence that anything stopped.
    for (const status of [401, 429, 500]) {
      const impl = (async () =>
        new Response(JSON.stringify({ error: `fly said ${status}` }), {
          status,
        })) as unknown as typeof globalThis.fetch;

      const driver = new FlyMachinesProvisioner({
        credentials: { get: () => "fly-token" },
        fetchImpl: impl,
        pacer: noPacer,
      });
      await expect(driver.status("app-x/machine-y")).rejects.toThrow(
        new RegExp(`fly said ${status}`)
      );
    }
  });
});

describe("flyStateToRuntimeState", () => {
  it("treats anything holding compute as running", () => {
    // `starting` and `replacing` are billing. The one thing no driver may ever
    // do is guess `stopped`, because the hub turns that into a claim an
    // operator reads as "this has stopped costing me money".
    expect(flyStateToRuntimeState("started")).toBe("running");
    expect(flyStateToRuntimeState("starting")).toBe("running");
    expect(flyStateToRuntimeState("replacing")).toBe("running");
  });

  it("treats anything that has finished releasing compute as stopped", () => {
    expect(flyStateToRuntimeState("stopped")).toBe("stopped");
    // Suspended executes nothing: the guest is a memory snapshot on disk, woken
    // by the same POST .../start this driver already uses for a stopped machine.
    // The storage it holds is not the discriminator — a `stopped` Fly machine
    // holds a rootfs and this driver's 3 GB volume, which bill for as long as
    // the app exists. `stopped` on Fly has never meant "costing nothing";
    // destroy() is what means that. Compute is the axis, and on that axis a
    // suspended machine is down.
    expect(flyStateToRuntimeState("suspended")).toBe("stopped");
    expect(flyStateToRuntimeState("destroyed")).toBe("stopped");
  });

  it("refuses to round a transitional state to an answer", () => {
    // Mid-flight, and not an answer. A `stopping` machine HAS NOT STOPPED, and
    // saying it has is exactly the bug #260/#261 fixed. The sweeper asks again
    // on the next tick and only reports a problem if it is still unanswered five
    // minutes later, so `unknown` costs a tick and buys the truth.
    expect(flyStateToRuntimeState("stopping")).toBe("unknown");
    expect(flyStateToRuntimeState("suspending")).toBe("unknown");
    expect(flyStateToRuntimeState("destroying")).toBe("unknown");
    expect(flyStateToRuntimeState("restarting")).toBe("unknown");
    expect(flyStateToRuntimeState("updating")).toBe("unknown");
    // `created` means allocated but never run. This driver always starts what
    // it creates, so seeing it means something happened that we did not do —
    // which is exactly when a confident answer is worth least.
    expect(flyStateToRuntimeState("created")).toBe("unknown");
  });

  it("refuses to round a terminal state whose resource story is unclear", () => {
    // `failed` may or may not be about to be restarted — this driver sets
    // restart.policy "always", so a failed machine is one Fly has given up
    // restarting, and whether anything is still allocated for it is not
    // something the probes established. `replaced` and `migrated` mean this
    // machine's work moved elsewhere, which says nothing about whether the
    // elsewhere is running. Guessing on any of the three would be guessing
    // about money.
    expect(flyStateToRuntimeState("failed")).toBe("unknown");
    expect(flyStateToRuntimeState("replaced")).toBe("unknown");
    expect(flyStateToRuntimeState("migrated")).toBe("unknown");
  });

  it("says unknown for a state Fly adds later", () => {
    expect(flyStateToRuntimeState("hibernating")).toBe("unknown");
    expect(flyStateToRuntimeState(undefined)).toBe("unknown");
    expect(flyStateToRuntimeState(42)).toBe("unknown");
  });
});

describe("FlyMachinesProvisioner — destroy", () => {
  it("deletes the app, which takes the machine and the volume with it", async () => {
    // One call, not three. The app owns both, so deleting it is atomic from the
    // hub's point of view; three ordered deletes would be three places to fail
    // half-way and leave a volume behind. A leaked Fly volume bills every month
    // for a runtime the console no longer shows, and nothing ever comes back to
    // look for it — the hub forgets the external id the moment the row goes.
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app } = parseFlyExternalId(externalId);

    fake.calls.length = 0;
    await driver.destroy(externalId);

    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /v1/apps/${app}`,
    ]);
    // The fake cascades exactly as Fly does: no app, therefore no machine and
    // no volume. Asserting the app is gone is asserting all three.
    expect(fake.apps.has(app)).toBe(false);
  });

  it("IS IDEMPOTENT — a second destroy does not throw", async () => {
    // Conformance rule 6, and not theoretical: the Docker driver forwarded its
    // orchestrator's `Sandbox not found`, destroyRuntime turned that into a 502
    // and left the row un-destroyed, so a destroy that half-succeeded could
    // never be retried to completion and the runtime was wedged permanently.
    // The retry is the whole cleanup mechanism; it only works if arriving at an
    // already-destroyed app is a success.
    const { driver } = flyDriver();
    const { externalId } = await driver.provision(SPEC);

    await driver.destroy(externalId);
    await expect(driver.destroy(externalId)).resolves.toBeUndefined();
  });

  it("succeeds for an app it never created at all", async () => {
    // The same rule from the other end: a runtime row whose app was destroyed
    // out of band still has to be destroyable, or an operator cannot clear it
    // from the console without touching the database.
    const { driver, fake } = flyDriver();
    await expect(driver.destroy("agentpod-never-existed/machine-x")).resolves
      .toBeUndefined();
    // And it really did ask — a destroy that returned without calling Fly would
    // pass this assertion for the wrong reason.
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "DELETE /v1/apps/agentpod-never-existed",
    ]);
  });

  it("still throws when Fly cannot be reached", async () => {
    // Only "already gone" is forgiven. Reporting a successful destroy for an app
    // nobody could look at is the worse bug of the two: destroyRuntime deletes
    // the row on a driver returning, so the hub forgets the external id while
    // the machine and its volume keep billing, with nothing in the console left
    // to say they exist.
    const impl = (async () =>
      new Response(JSON.stringify({ error: "internal server error" }), {
        status: 500,
      })) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.destroy("app-x/machine-y")).rejects.toThrow(/500/);
  });

  it("PROPAGATES every Fly failure that is not a 404", async () => {
    // What keeps the tolerance exactly one status wide. A bare
    // `catch { return }` passes both idempotence tests above and fails only
    // here — which is the shape of the mistake worth guarding, because "make
    // destroy idempotent" reads like an instruction to swallow errors.
    //
    // 401 is the case that would hurt most: an expired FLY_API_TOKEN 401s on
    // every app at once, so a swallowing destroy would let an operator clear a
    // whole fleet out of the console while every machine and volume kept
    // billing. 403 is a token scoped to the wrong org, 429 is Fly's rate limit,
    // and 500 is Fly having a bad day. None of the four is evidence that
    // anything was deleted.
    for (const status of [401, 403, 429, 500]) {
      const impl = (async () =>
        new Response(JSON.stringify({ error: `fly said ${status}` }), {
          status,
        })) as unknown as typeof globalThis.fetch;

      const driver = new FlyMachinesProvisioner({
        credentials: { get: () => "fly-token" },
        fetchImpl: impl,
        pacer: noPacer,
      });
      await expect(driver.destroy("app-x/machine-y")).rejects.toThrow(
        new RegExp(`fly said ${status}`)
      );
    }
  });

  it("throws when the transport fails, which carries no status at all", async () => {
    // A DNS failure or a dropped connection produces a TypeError, not a
    // FlyApiError — so an `err.status !== 404` test written without the
    // instanceof guard would read `undefined !== 404` correctly, but one
    // written as `err.status === 404 ? return : throw` on a bare `any` would
    // still need this to prove it. Nothing was deleted; the destroy must fail.
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;

    const driver = new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      fetchImpl: impl,
      pacer: noPacer,
    });
    await expect(driver.destroy("app-x/machine-y")).rejects.toThrow(/fetch failed/);
  });

  it("REFUSES a malformed id instead of reading its 404 as already-gone", async () => {
    // Where the external-id codec's guard and destroy's 404 tolerance meet, and
    // the one place they could combine into a silent leak.
    //
    // An id missing its app half interpolates to `DELETE /v1/apps/`, which
    // addresses no app and answers 404 — and this method's whole job is to read
    // a 404 as "already gone" and return happily. destroyRuntime would then
    // delete the row for a machine and a 3 GB volume that were never touched.
    // parseFlyExternalId refusing FIRST is what makes the tolerance safe, so
    // this asserts both that it throws and that nothing was sent.
    for (const bad of ["no-slash-here", "/machine-only", "app-only/", ""]) {
      const { driver, fake } = flyDriver();
      await expect(driver.destroy(bad)).rejects.toThrow(/malformed external id/);
      expect(fake.calls).toEqual([]);
    }
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
