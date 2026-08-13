/**
 * A faithful in-memory Fly Machines API, for unit tests and the conformance
 * suite.
 *
 * NOT a *.test.ts file on purpose: bun would run its importer's tests twice if
 * one test file imported another. Both fly.test.ts and conformance.test.ts use
 * this.
 *
 * "Faithful" is load-bearing. A fake that tolerates everything makes every
 * behavioural rule in the conformance suite pass for free, which is the same as
 * not having them — and the Docker fake proved the opposite choice pays: it was
 * written including the unfriendly `Sandbox not found` throw, and that is what
 * surfaced a destroy that was not idempotent and left a runtime permanently
 * wedged.
 *
 * So this mirrors the behaviours the driver actually depends on, including the
 * ones that make the driver's job harder:
 *   - creating an app that exists answers 409, not 200
 *   - a machine mounting a volume that does not exist is a 404: volumes are
 *     pinned to a physical host, which is why the driver must create the volume
 *     BEFORE the machine
 *   - a machine created in a different region from its volume is refused, for
 *     the same reason — the pinning is to a host in that region
 *   - a region the account's plan does not cover is refused with Fly's own
 *     wording (measured 2026-08-12: "bom" refused, "sin" accepted)
 *   - `swap_size_mb` is honoured ONLY inside `config.init`, and SILENTLY
 *     DROPPED anywhere else — 200, a machine that boots, and no swap in it
 *   - `wait?state=` answers 408 when the machine is not in that state
 *   - waiting for `stopped` REQUIRES instance_id
 *   - a start gives the machine a NEW instance id, as a real restart does
 *   - deleting an app takes its volumes and machines with it
 *   - anything about a gone app or machine is a 404, distinguishable from a
 *     transport failure — the distinction destroy() and status() branch on
 *
 * What it deliberately does NOT model, and why:
 *   - **Rate limiting.** Fly allows 1 request/second per action, burst 3, but
 *     every test constructs its driver with `noPacer`; a fake that answered 429
 *     would fail every one of them, and pacing is already tested directly in
 *     fly-api.test.ts against a driven clock.
 *   - **Boot transients.** A real POST .../machines answers `created` and the
 *     machine reaches `started` a moment later. This fake has no clock, so it
 *     records `started` immediately; a test that needs a transient sets
 *     `machine.state` on the map directly, which is how the state mapping is
 *     exercised.
 *   - **Any answer of its own for a start on a machine already `started`, or a
 *     stop on one already `stopped`.** Docker answers HTTP 304 there ("the end
 *     state you asked for already holds"), and issue #284 is what that costs
 *     when a driver forwards it as a failure. Fly's answer was NOT among the
 *     2026-08-12/13 probes, and this file may not call the live API to settle
 *     it. So both verbs simply succeed here, and fly.ts maps nothing — an
 *     invented status code would put a guess exactly where a driver decides
 *     whether to report an error.
 *   - **Refusing to DELETE a running machine without `force`,** and **refusing
 *     a duplicate machine name in an app.** Both are real, neither was measured
 *     by the 2026-08-12 probes, and this file may not call the live API to
 *     settle them. Encoding an unverified status code here would put a guess
 *     where every later task reads a measurement. The driver deletes the APP,
 *     never a machine, so neither is on a path it takes today.
 */

export interface FakeMachine {
  id: string;
  instance_id: string;
  state: string;
  config: Record<string, unknown>;
  region: string;
}

export interface FakeApp {
  volumes: Map<string, { id: string; size_gb: number; region: string }>;
  machines: Map<string, FakeMachine>;
}

export interface FlyFakeOptions {
  /** Make POST .../machines fail, to exercise the driver's cleanup path. */
  failMachineCreate?: boolean;
  /**
   * Regions this account's plan does not cover.
   *
   * Defaults to the one that was actually refused on the account the probes ran
   * against: measured 2026-08-12, `bom` answers "not available to legacy or
   * non-paid plan accounts" while `sin` works. It defaults to refusing rather
   * than to accepting everything, because a fake where every region works is a
   * fake in which the driver's translation of that refusal is never exercised.
   */
  refusedRegions?: readonly string[];
}

export interface FlyFakeSubstrate {
  fetchImpl: typeof globalThis.fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
  apps: Map<string, FakeApp>;
}

/**
 * What Fly keeps of a machine config: everything, minus a `swap_size_mb` asked
 * for at the top level, which it accepts and discards. See the call site.
 */
function dropUnhonouredSwap(
  config: Record<string, unknown>
): Record<string, unknown> {
  if (!("swap_size_mb" in config)) return config;
  const { swap_size_mb: _dropped, ...kept } = config;
  return kept;
}

export function createFlyFakeSubstrate(
  options: FlyFakeOptions = {}
): FlyFakeSubstrate {
  const apps = new Map<string, FakeApp>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const refusedRegions = new Set(options.refusedRegions ?? ["bom"]);
  let nextId = 0;

  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  /** Fly's own wording for a region the account's plan does not cover. */
  const regionRefusal = (region: string) =>
    json(
      {
        error:
          `region ${region} is not available to legacy or non-paid plan accounts`,
      },
      422
    );

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });

    // ["v1", "apps", app?, "volumes"|"machines"?, id?, verb?]
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "apps") {
      return json({ error: "not found" }, 404);
    }

    const appName = parts[2];

    // POST /v1/apps
    if (!appName) {
      if (method !== "POST") return json({ error: "not found" }, 404);
      const name = (body as { app_name?: string })?.app_name;
      if (!name) return json({ error: "app_name is required" }, 400);
      if (apps.has(name)) return json({ error: "app already exists" }, 409);
      apps.set(name, { volumes: new Map(), machines: new Map() });
      return json({ id: name, name }, 201);
    }

    const app = apps.get(appName);

    // DELETE /v1/apps/{app}
    if (parts.length === 3) {
      if (method === "DELETE") {
        if (!app) return json({ error: "app not found" }, 404);
        // Deleting the app takes its volumes and machines with it — the whole
        // reason this driver uses one app per runtime.
        apps.delete(appName);
        return json(undefined, 202);
      }
      if (method === "GET") {
        return app ? json({ name: appName }) : json({ error: "app not found" }, 404);
      }
      return json({ error: "not found" }, 404);
    }

    if (!app) return json({ error: "app not found" }, 404);

    // POST /v1/apps/{app}/volumes
    if (parts[3] === "volumes" && parts.length === 4 && method === "POST") {
      const spec = (body ?? {}) as { size_gb?: number; region?: string; name?: string };
      const region = spec.region ?? "sin";
      if (refusedRegions.has(region)) return regionRefusal(region);
      const id = `vol_${++nextId}`;
      app.volumes.set(id, {
        id,
        size_gb: spec.size_gb ?? 1,
        region,
      });
      return json({ id, name: spec.name, region }, 201);
    }

    if (parts[3] !== "machines") return json({ error: "not found" }, 404);

    // POST /v1/apps/{app}/machines
    if (parts.length === 4 && method === "POST") {
      if (options.failMachineCreate) {
        return json({ error: "no capacity in region" }, 422);
      }
      const spec = (body ?? {}) as { region?: string; config?: Record<string, unknown> };
      const config = spec.config ?? {};
      const region = spec.region ?? "sin";
      if (refusedRegions.has(region)) return regionRefusal(region);

      const mounts = (config.mounts as Array<{ volume?: string }> | undefined) ?? [];
      for (const mount of mounts) {
        const volume = mount.volume ? app.volumes.get(mount.volume) : undefined;
        if (!volume) {
          return json({ error: `volume ${mount.volume} not found` }, 404);
        }
        // A volume lives on one physical host, in one region. A machine asked
        // for elsewhere cannot attach it — the reason the create order in
        // provision() is app → volume → machine and not something tidier.
        if (spec.region && volume.region !== spec.region) {
          return json(
            {
              error:
                `volume ${volume.id} is in region ${volume.region}, ` +
                `machine requested in ${spec.region}`,
            },
            422
          );
        }
      }

      const id = `machine${++nextId}`;
      app.machines.set(id, {
        id,
        instance_id: `inst${nextId}`,
        state: "started",
        // Measured 2026-08-13: `swap_size_mb` counts only inside `config.init`.
        // Asked for at the config top level, Fly answers 200, boots the
        // machine, and the guest reports `SwapTotal: 0 kB` — no error, at
        // create or at update. Asked for as a sibling of `config` it never
        // reaches the machine at all, which the `spec` destructure above
        // already models by reading nothing else. Storing the config verbatim
        // would make a
        // driver that guessed wrong indistinguishable from one that got it
        // right, which is #278's wedge waiting to be reintroduced.
        config: dropUnhonouredSwap(config),
        region,
      });
      return json({ id, instance_id: `inst${nextId}`, state: "started" }, 200);
    }

    const machineId = parts[4];
    const machine = machineId ? app.machines.get(machineId) : undefined;
    if (!machine) return json({ error: "machine not found" }, 404);
    const verb = parts[5];

    // GET /v1/apps/{app}/machines/{id}
    if (!verb && method === "GET") {
      return json({
        id: machine.id,
        instance_id: machine.instance_id,
        state: machine.state,
        region: machine.region,
        config: machine.config,
      });
    }

    // DELETE /v1/apps/{app}/machines/{id}
    if (!verb && method === "DELETE") {
      app.machines.delete(machine.id);
      return json({ ok: true }, 200);
    }

    if (verb === "start" && method === "POST") {
      machine.state = "started";
      // A restart is a new instance, exactly as on real Fly.
      machine.instance_id = `inst${++nextId}`;
      return json({ ok: true });
    }

    if (verb === "stop" && method === "POST") {
      machine.state = "stopped";
      return json({ ok: true });
    }

    // GET /v1/apps/{app}/machines/{id}/wait?state=…
    if (verb === "wait" && method === "GET") {
      const wanted = url.searchParams.get("state");
      if (wanted === "stopped" && !url.searchParams.get("instance_id")) {
        // Real Fly requires it. Without this the driver could omit instance_id
        // and nothing would ever notice until a live stop hung.
        return json({ error: "instance_id is required when waiting for stopped" }, 400);
      }
      if (machine.state === wanted) return json({ ok: true });
      return json({ error: "timeout reached waiting for machine state" }, 408);
    }

    return json({ error: "not found" }, 404);
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls, apps };
}
