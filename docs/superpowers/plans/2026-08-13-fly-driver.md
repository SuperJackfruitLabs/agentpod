# Fly Machines Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `fly` runtime provisioner that creates a Fly Machine per runtime with its workspace anchored on a mounted Fly Volume, so a station survives stop→start with its files and its node identity intact.

**Architecture:** One Fly **app per runtime** (its own 6PN `network`, so runtimes cannot reach each other), containing one **volume** and one **machine**. Creation order is app → volume → machine, because a Fly volume is pinned to a physical host and a machine created before its volume can land elsewhere. The machine declares **no `services` block**, which is what makes Fly's autostop mechanism inapplicable — the hub drives stop/start itself, as it already does for Cloudflare. `destroy` deletes the app, which takes the machine and the volume with it in one idempotent call.

**Tech Stack:** Bun + TypeScript (hub), the Fly Machines REST API at `https://api.machines.dev`, Docker (the runtime image), `flyctl` (verification only).

**Spec:** `docs/superpowers/specs/2026-08-12-provisioner-registry-design.md` — read the four-substrate table before starting. **Groundwork:** `docs/superpowers/plans/2026-08-12-provisioner-registry.md`, fully shipped.

## Global Constraints

**Money.** Fly's free tier no longer exists. Every machine, volume and IP created by the live-verification task (Task 13) bills a real card. The amounts are small (a `shared-cpu-1x` machine with 3 GB of volume for under an hour is cents), but **a leaked app bills forever** — Task 13 ends by destroying everything it made and proving with `flyctl apps list` that nothing is left. No other task may touch the real Fly API except Task 1's two-request auth probe.

**These are measured facts from probes run on a real Fly account on 2026-08-12. They override the documentation, which is wrong about several of them.**

- **The rootfs is wiped across stop/start.** A sentinel written to `/` was `GONE` after stop→start; the same sentinel on a mounted volume was still there. The machine id and the volume both survived. Therefore `workspaceStorage: "volume"`, and the workspace MUST live on the mount.
- **Do not use `persist_rootfs`.** Fly's own docs disclaim it as unreliable for critical data, and whether it survives a full stop→start is undocumented. It appears nowhere in this plan and must appear nowhere in the code.
- **A machine with no `services` block is never auto-stopped.** Measured: 25 minutes idle with only outbound traffic, sampled every 5 minutes, `started` throughout — well past the 15 minutes at which Cloudflare killed a station. Therefore `idleBehaviour: "hub-driven"`. **The driver must never define `services`**, and Task 4 pins that with a test.
- **Region `bom` is refused on a non-paid plan** ("legacy or non-paid plan"); `sin` works. The region is configurable and that refusal must be legible.
- **Create the volume before the machine.** Volumes are pinned to a host; a machine created first can land on a different one and fail to attach.
- Rate limits are low: **1 request/second per action, burst 3.** Every call goes through the pacer from Task 2.

**Engineering rules.**

- TDD: failing test first, every time. Prove each guard is non-vacuous by breaking the code and watching the test fail.
- **Unit tests use a fake `fetch` implementing the real Fly routes**, exactly as `cloudflare-sandbox.test.ts` does. Nothing in CI may reach `api.machines.dev`.
- **Tests must pass `pacer: noPacer`.** The real pacer sleeps a second per call past the burst; `assertConforms` provisions five times, so a paced conformance test would add half a minute to every CI run.
- The enrolment token goes into the machine's env and is **never logged**. Do not add a log statement that references `spec.enrollToken`.
- Never weaken an existing test to make a new one pass.
- Run the full hub suite **after the last edit**:
  `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`
  It needs a **pgvector** Postgres on `:5434` and the explicit `DATABASE_URL` override (bun auto-loads `apps/hub/.env`). See root `CLAUDE.md` / `TESTING.md`.
- `bun run typecheck` in `apps/hub` is **known red** on pre-existing errors in the stations files. Do not fix those in passing; just confirm you added no new ones.

**What this plan deliberately does not touch, because the groundwork made it unnecessary:**

- `packages/contract` — `provider` is already `z.string()`; the registry decides validity.
- `apps/hub/src/services/provisioner/registry.ts` — `providerEnvFlag("fly")` already derives `ENABLE_FLY_PROVISIONING`.
- `apps/console` — the New Runtime dialog already builds its provider and tier lists from `providerManifests()`.

If you find yourself editing any of those three, stop: something is wrong with the approach, not with the groundwork.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/hub/src/services/provisioner/fly-api.ts` | **new** — low-level Fly HTTP: auth header, rate pacing, error mapping. Knows nothing about runtimes. |
| `apps/hub/src/services/provisioner/fly-api.test.ts` | **new** — unit tests for the above. |
| `apps/hub/src/services/provisioner/fly.ts` | **new** — the `FlyMachinesProvisioner` driver: manifest, provision/start/stop/status/destroy. |
| `apps/hub/src/services/provisioner/fly.test.ts` | **new** — driver unit tests against a fake substrate. |
| `apps/hub/src/services/provisioner/fly-fake-substrate.ts` | **new** — a faithful in-memory Fly API, shared by `fly.test.ts` and `conformance.test.ts`. Not a `*.test.ts` file, so `bun test` does not run it twice. |
| `apps/hub/src/services/provisioner/conformance.test.ts` | modify — hold the real Fly driver to its manifest. |
| `apps/hub/src/services/provisioner/bootstrap.ts` | modify — register the driver when the flag is on. |
| `apps/hub/src/config.ts` | modify — a `fly` section. |
| `apps/hub/src/utils/validate-config.ts` | modify — refuse to boot on a misconfigured Fly deployment. |
| `fly/node-image/Dockerfile` | **new** — the runtime image (node-agent + OpenCode), built from the repo root. |
| `fly/node-image/volume-workspace.sh` | **new** — wrapper that points `/workspace` and `HOME` at the mounted volume. |
| `fly/node-image/test-volume-workspace.sh` | **new** — POSIX test for the wrapper, run in CI. |
| `fly/node-image/README.md` | **new** — how to build and push the image. |
| `.github/workflows/ci.yml` | modify — run the wrapper test in the `node-agent` job. |
| `docs/DEPLOYMENT.md`, `docs/OPERATING.md` | modify — the new env vars and the operator runbook. |

---

### Task 1: Confirm the Fly auth header, and build the client that uses it

Fly's documentation gives two different auth schemes on two different pages — `FlyV1 <token>` and `Bearer <token>`. **Do not guess.** This task settles it with two real requests and records the answer where the next reader cannot miss it.

**Files:**
- Create: `apps/hub/src/services/provisioner/fly-api.ts`
- Test: `apps/hub/src/services/provisioner/fly-api.test.ts`

**Interfaces:**
- Produces: `FLY_AUTH_SCHEME: string`, `class FlyApiError extends Error` (with `.status: number` and `.path: string`), `type FlyRequest = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>`, `createFlyClient(opts: FlyClientOptions): FlyRequest`.

- [ ] **Step 1: Probe the real API with both header forms**

You need a Fly API token. `flyctl auth token` prints one for the logged-in account (`brew install flyctl && flyctl auth login` if you have neither).

```bash
export FLY_API_TOKEN="$(flyctl auth token)"
export FLY_ORG_SLUG=personal   # or your org slug

echo "--- Bearer ---"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  "https://api.machines.dev/v1/apps?org_slug=${FLY_ORG_SLUG}"

echo "--- FlyV1 ---"
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: FlyV1 ${FLY_API_TOKEN}" \
  "https://api.machines.dev/v1/apps?org_slug=${FLY_ORG_SLUG}"
```

These are two read-only `GET`s. They create nothing and cost nothing.

Decision rule, applied literally:
- Exactly one returns `200` → that is `FLY_AUTH_SCHEME`.
- **Both** return `200` → use `"Bearer"`, and record in the comment that both were accepted on this date.
- **Neither** returns `200` → the token is wrong or expired, not the scheme. Re-run `flyctl auth token` and try again; do not proceed to Step 2 with a guess.

Write down both status codes — they go into the code comment in Step 4.

- [ ] **Step 2: Write the failing test**

Create `apps/hub/src/services/provisioner/fly-api.test.ts`. Replace `"Bearer"` below with whatever Step 1 measured, in **both** places.

```ts
/**
 * Unit tests: the low-level Fly Machines HTTP client.
 *
 * No real Fly. A fake fetch captures requests and returns controlled responses,
 * including the failure bodies whose wording an operator has to act on.
 */

import { describe, it, expect } from "bun:test";
import { createFlyClient, FlyApiError, FLY_AUTH_SCHEME, noPacer } from "./fly-api";

function fakeFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(response === undefined ? "" : JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const make = (impl: typeof globalThis.fetch) =>
  createFlyClient({ token: "tok", fetchImpl: impl, pacer: noPacer });

describe("createFlyClient", () => {
  it("authenticates with the scheme measured against the real API", async () => {
    // Fly documents BOTH "FlyV1 <token>" and "Bearer <token>". This value was
    // settled by probing the live API, not by reading a page — see fly-api.ts.
    expect(FLY_AUTH_SCHEME).toBe("Bearer");

    const { impl, calls } = fakeFetch({ ok: true });
    await make(impl)("GET", "/v1/apps/demo");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("hits the machines API host and the path it was given", async () => {
    const { impl, calls } = fakeFetch({ ok: true });
    await make(impl)("GET", "/v1/apps/demo");
    expect(calls[0]!.url).toBe("https://api.machines.dev/v1/apps/demo");
  });

  it("serialises a body only when one is given", async () => {
    const withBody = fakeFetch({ id: "m1" });
    await make(withBody.impl)("POST", "/v1/apps", { app_name: "demo" });
    expect(JSON.parse(String(withBody.calls[0]!.init.body))).toEqual({ app_name: "demo" });

    const without = fakeFetch({ ok: true });
    await make(without.impl)("POST", "/v1/apps/demo/machines/m1/start");
    expect(without.calls[0]!.init.body).toBeUndefined();
  });

  it("throws a FlyApiError carrying the status, so callers can tell 408 from 500", async () => {
    const { impl } = fakeFetch({ error: "timeout reached waiting for machine state" }, 408);
    const err = (await make(impl)("GET", "/v1/apps/demo/machines/m1/wait")
      .then(() => null)
      .catch((e) => e)) as FlyApiError;
    expect(err).toBeInstanceOf(FlyApiError);
    expect(err.status).toBe(408);
    expect(err.path).toBe("/v1/apps/demo/machines/m1/wait");
  });

  it("puts Fly's own error text in the message", async () => {
    const { impl } = fakeFetch({ error: "volume not found" }, 404);
    await expect(make(impl)("GET", "/v1/apps/demo/volumes/vol_x")).rejects.toThrow(
      /volume not found/
    );
  });

  it("EXPLAINS the plan-gated region refusal instead of echoing it", async () => {
    // Measured 2026-08-12: region "bom" is refused on a non-paid plan and the
    // raw text ("legacy or non-paid plan") tells an operator nothing about
    // which knob to turn. "sin" was measured to work.
    const { impl } = fakeFetch(
      { error: "region bom is not available to legacy or non-paid plan accounts" },
      422
    );
    const message = await make(impl)("POST", "/v1/apps/demo/machines")
      .then(() => "")
      .catch((e: Error) => e.message);
    expect(message).toMatch(/FLY_REGION/);
    expect(message).toMatch(/sin/);
  });

  it("tolerates an empty body — Fly answers some verbs with no content", async () => {
    const { impl } = fakeFetch(undefined, 202);
    const res = await make(impl)("DELETE", "/v1/apps/demo");
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
  });

  it("does not crash on a non-JSON error page", async () => {
    const impl = (async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(
      createFlyClient({ token: "tok", fetchImpl: impl, pacer: noPacer })("GET", "/v1/apps/demo")
    ).rejects.toThrow(/502/);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly-api.test.ts`
Expected: FAIL — `Cannot find module './fly-api'`.

- [ ] **Step 4: Write the client**

Create `apps/hub/src/services/provisioner/fly-api.ts`. Substitute the scheme and the two status codes you measured in Step 1 into `FLY_AUTH_SCHEME` and its comment. `noPacer` is defined here now and given its real sibling in Task 2 — the client already accepts a `pacer`, so Task 2 changes only the default.

```ts
/**
 * Low-level HTTP client for the Fly Machines API.
 *
 * Deliberately knows nothing about runtimes, manifests or the hub: it does auth,
 * rate pacing and turning a Fly failure into an error an operator can act on.
 * The driver in fly.ts owns everything above that.
 */

/**
 * The Authorization scheme Fly actually accepts.
 *
 * Fly's documentation gives BOTH "FlyV1 <token>" and "Bearer <token>", on
 * different pages, with no indication that either is deprecated. Guessing would
 * have produced a driver that 401s on its first live call with an error that
 * reads like a bad token. Settled by probing the real API on 2026-08-13:
 * "Bearer" → 200, "FlyV1" → 200. Both are accepted; "Bearer" is used because it
 * is the standard scheme and works with every HTTP tool without explanation.
 */
export const FLY_AUTH_SCHEME = "Bearer";

/** Default API host. Overridable so tests never depend on the constant. */
const FLY_API_BASE = "https://api.machines.dev";

/**
 * A Fly API failure, carrying the status so callers can branch on it.
 *
 * The status is not decoration. `wait?state=` answers 408 for "not yet", which
 * is a normal outcome the driver must swallow; a 404 on a machine means it is
 * already gone, which is what makes destroy idempotent. Without the status on
 * the error, both would be indistinguishable from a 500.
 */
export class FlyApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "FlyApiError";
  }
}

/** Something that must be awaited before each API call. See createFlyPacer. */
export interface Pacer {
  take(): Promise<void>;
}

/**
 * A pacer that never waits.
 *
 * For tests ONLY. Fly allows one request per second per action, so the real
 * pacer sleeps — and assertConforms provisions five times, which would put half
 * a minute of sleeping into every CI run for no signal at all.
 */
export const noPacer: Pacer = { take: async () => {} };

export type FlyRequest = (
  method: string,
  path: string,
  body?: unknown
) => Promise<{ status: number; body: Record<string, unknown> }>;

export interface FlyClientOptions {
  /** Fly API token. Never logged. */
  token: string;
  baseUrl?: string;
  /** Injectable fetch — used to inject a fake in unit tests. */
  fetchImpl?: typeof globalThis.fetch;
  pacer?: Pacer;
}

/**
 * Turn a Fly failure into something an operator can act on.
 *
 * The region case is the one that has already cost time: Fly refuses a region
 * the account's plan does not cover with a sentence about "legacy or non-paid
 * plan" and no mention of the knob. Measured 2026-08-12: "bom" refused, "sin"
 * accepted, on the same account.
 */
function describeFlyFailure(
  status: number,
  path: string,
  parsed: Record<string, unknown>,
  raw: string
): string {
  const detail =
    typeof parsed.error === "string" && parsed.error
      ? parsed.error
      : raw || "(no response body)";

  if (/legacy or non-paid plan/i.test(detail)) {
    return (
      `fly: ${status} for ${path}: ${detail} — this region is not available on ` +
      `this account's plan. Set FLY_REGION to a region the plan allows ("sin" ` +
      `was measured to work on a non-paid account) or upgrade the Fly ` +
      `organisation.`
    );
  }

  return `fly: ${status} for ${path}: ${detail}`;
}

export function createFlyClient({
  token,
  baseUrl = FLY_API_BASE,
  fetchImpl = globalThis.fetch,
  pacer = noPacer,
}: FlyClientOptions): FlyRequest {
  const base = baseUrl.replace(/\/$/, "");

  return async function flyRequest(method, path, body) {
    await pacer.take();

    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `${FLY_AUTH_SCHEME} ${token}`,
      },
      // NOTE: `body` carries the enrolment token on machine creation and is
      // never logged from this module. Do not add a log statement here.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // Read as text first: Fly answers some verbs with no content at all, and a
    // gateway in front of it can answer with HTML. Neither is a reason to throw
    // a parse error over the real status.
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (!res.ok) {
      throw new FlyApiError(
        res.status,
        path,
        describeFlyFailure(res.status, path, parsed, raw)
      );
    }

    return { status: res.status, body: parsed };
  };
}
```

- [ ] **Step 5: Run the test**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly-api.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/provisioner/fly-api.ts apps/hub/src/services/provisioner/fly-api.test.ts
git commit -m "feat(provisioner): Fly Machines HTTP client, auth scheme confirmed against the live API"
```

---

### Task 2: Pace every call, because Fly's limit is one per second

**Files:**
- Modify: `apps/hub/src/services/provisioner/fly-api.ts`
- Test: `apps/hub/src/services/provisioner/fly-api.test.ts`

**Interfaces:**
- Consumes: `createFlyClient`, `Pacer`, `noPacer` from Task 1.
- Produces: `createFlyPacer(opts?: { capacity?: number; refillMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Pacer`. It becomes `createFlyClient`'s default pacer.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/fly-api.test.ts`, and add `createFlyPacer` to the import at the top of the file.

```ts
describe("createFlyPacer", () => {
  /** A clock the test drives: sleeping advances it, so nothing waits for real. */
  function fakeClock() {
    let t = 0;
    const slept: number[] = [];
    return {
      slept,
      now: () => t,
      sleep: async (ms: number) => {
        slept.push(ms);
        t += ms;
      },
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it("lets a burst of three through immediately", async () => {
    // Fly's documented allowance: 1 request/second per action, burst 3. A
    // provision is four calls, so without a burst every runtime creation would
    // take four seconds of pure waiting.
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take();
    await pacer.take();
    await pacer.take();

    expect(clock.slept).toEqual([]);
  });

  it("then paces at one per second", async () => {
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take();
    await pacer.take();
    await pacer.take();
    await pacer.take();
    expect(clock.slept).toEqual([1000]);

    await pacer.take();
    expect(clock.slept).toEqual([1000, 1000]);
  });

  it("refills over idle time, so an idle hub never waits", async () => {
    // Without refill this would be a leaky bucket that punishes a hub for
    // having provisioned something five minutes ago.
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await pacer.take();
    await pacer.take();
    await pacer.take();
    clock.advance(5000);

    await pacer.take();
    await pacer.take();
    await pacer.take();
    expect(clock.slept).toEqual([]);
  });

  it("serialises concurrent callers instead of letting them all through", async () => {
    // Two runtimes provisioned at once must not each believe they own the
    // burst. take() is chained, so the fourth caller waits whoever asked.
    const clock = fakeClock();
    const pacer = createFlyPacer({ now: clock.now, sleep: clock.sleep });

    await Promise.all([
      pacer.take(),
      pacer.take(),
      pacer.take(),
      pacer.take(),
      pacer.take(),
    ]);

    expect(clock.slept).toEqual([1000, 1000]);
  });

  it("is the client's default, so no call site can forget it", async () => {
    const client = createFlyClient({
      token: "tok",
      fetchImpl: (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    // Four calls with the real pacer: the fourth must actually have waited.
    const started = Date.now();
    await client("GET", "/v1/apps/a");
    await client("GET", "/v1/apps/a");
    await client("GET", "/v1/apps/a");
    await client("GET", "/v1/apps/a");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly-api.test.ts`
Expected: FAIL — `createFlyPacer is not a function`.

- [ ] **Step 3: Implement the pacer**

In `fly-api.ts`, add this immediately after the `noPacer` declaration:

```ts
/**
 * Token bucket over Fly's published limit: 1 request/second per action, burst 3.
 *
 * A bucket rather than a fixed delay because the shape of our traffic is bursty
 * and then idle: a provision is four calls back to back and then nothing for
 * hours. A fixed 1s gap would make every provision four seconds slower for no
 * reason, and a naive "sleep 1s between calls" would still stampede when two
 * runtimes are created at once — hence the chain, which serialises every
 * caller through one queue.
 *
 * `now` and `sleep` are injected so the tests can drive a clock instead of
 * spending real seconds.
 */
export function createFlyPacer({
  capacity = 3,
  refillMs = 1000,
  now = () => Date.now(),
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  capacity?: number;
  refillMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Pacer {
  let tokens = capacity;
  let last = now();
  let chain: Promise<void> = Promise.resolve();

  const acquire = async (): Promise<void> => {
    const t = now();
    const refilled = Math.floor((t - last) / refillMs);
    if (refilled > 0) {
      tokens = Math.min(capacity, tokens + refilled);
      last += refilled * refillMs;
    }

    if (tokens > 0) {
      tokens -= 1;
      return;
    }

    await sleep(refillMs - (now() - last));
    last += refillMs;
    tokens = Math.min(capacity, tokens + 1) - 1;
  };

  // Chained so concurrent callers queue rather than each reading a stale token
  // count. `acquire` never rejects, but the second argument keeps one caller's
  // hypothetical failure from wedging the queue for everyone after it.
  return { take: () => (chain = chain.then(acquire, acquire)) };
}
```

Then change the client's default so no call site can forget it:

```ts
  pacer = createFlyPacer(),
```

replacing `pacer = noPacer,` in `createFlyClient`'s destructured options.

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly-api.test.ts`
Expected: PASS (13 tests). The Task 1 tests still pass because they all pass `pacer: noPacer` explicitly.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/fly-api.ts apps/hub/src/services/provisioner/fly-api.test.ts
git commit -m "feat(provisioner): pace Fly API calls to its 1/s burst-3 limit"
```

---

### Task 3: The driver skeleton — manifest, credentials, external ids

`credentials.ts` has been dead code since it shipped. This is its first real caller.

**Files:**
- Create: `apps/hub/src/services/provisioner/fly.ts`
- Test: `apps/hub/src/services/provisioner/fly.test.ts`

**Interfaces:**
- Consumes: `createFlyClient`, `FlyRequest`, `FlyApiError`, `Pacer` (Task 1/2); `requireCredentials`, `envCredentialResolver`, `CredentialResolver` from `./credentials`; `DriverManifest`, `ProvisionSpec`, `ResourceTier`, `RuntimeProvisioner`, `RuntimeState` from `./types`.
- Produces: `class FlyMachinesProvisioner implements RuntimeProvisioner`, `interface FlyMachinesOptions`, `formatFlyExternalId(app: string, machineId: string): string`, `parseFlyExternalId(externalId: string): { app: string; machineId: string }`, and the constants `FLY_VOLUME_MOUNT = "/data"` and `FLY_VOLUME_NAME = "agentpod_data"`.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/src/services/provisioner/fly.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: FAIL — `Cannot find module './fly'`.

- [ ] **Step 3: Write the skeleton**

Create `apps/hub/src/services/provisioner/fly.ts`. `provision`, `start`, `stop`, `status` and `destroy` throw for now; Tasks 4–8 replace them one at a time. They throw rather than returning something plausible so that a half-finished driver cannot be mistaken for a working one.

```ts
/**
 * Fly Machines provisioner driver.
 *
 * One Fly APP PER RUNTIME, holding one volume and one machine:
 *
 *   - Its own `network`, so one runtime's machine cannot reach another's over
 *     6PN. A shared app would put every customer's station on one private
 *     network.
 *   - destroy() is then a single DELETE of the app, which takes the machine and
 *     the volume with it. A shared app would need three ordered deletes, each a
 *     new way to leak a volume that bills monthly.
 *
 * Creating an app requires an ORG-scoped token; Fly's app-scoped deploy tokens
 * can do everything else but not that. See docs/DEPLOYMENT.md.
 *
 * SECURITY: the enrolment token is sent in the machine's env and is never
 * logged by this module. Do not add log statements that reference
 * spec.enrollToken.
 */

import type {
  DriverManifest,
  ProvisionSpec,
  ResourceTier,
  RuntimeProvisioner,
  RuntimeState,
} from "./types";
import type { CredentialResolver } from "./credentials";
import { envCredentialResolver, requireCredentials } from "./credentials";
import type { FlyRequest, Pacer } from "./fly-api";
import { createFlyClient, FlyApiError } from "./fly-api";

// ─── Substrate constants ──────────────────────────────────────────────────────

/**
 * Where the volume is mounted inside the machine.
 *
 * The image's wrapper (fly/node-image/volume-workspace.sh) symlinks /workspace
 * here and points HOME here, because the rootfs is wiped on every stop→start
 * and /workspace is hardcoded in the fleet's OpenCode entrypoint.
 */
export const FLY_VOLUME_MOUNT = "/data";

/**
 * The volume's name. Fly requires lowercase alphanumerics and underscores — no
 * hyphens — so this cannot simply be the app name. It is a constant because
 * each runtime has an app to itself, so there is nothing to disambiguate.
 */
export const FLY_VOLUME_NAME = "agentpod_data";

/**
 * Shared-CPU sizings, mirroring the Docker driver's tiers (1g/2g/4g).
 *
 * Fly's constraint on shared CPUs: memory_mb must be a multiple of 256 and
 * between 256×cpus and 2048×cpus. Every row below is inside that.
 */
const FLY_TIERS: Record<
  ResourceTier,
  { cpu_kind: string; cpus: number; memory_mb: number }
> = {
  small: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
  medium: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 },
  large: { cpu_kind: "shared", cpus: 4, memory_mb: 4096 },
};

/** Seconds to give Fly's `wait?state=` endpoint before it answers 408. */
const WAIT_TIMEOUT_S = 60;

// ─── External id ──────────────────────────────────────────────────────────────

/**
 * The hub stores exactly one string per runtime, and every Fly route needs both
 * the app and the machine: /v1/apps/{app}/machines/{id}. So the handle is both.
 */
export function formatFlyExternalId(app: string, machineId: string): string {
  return `${app}/${machineId}`;
}

export function parseFlyExternalId(externalId: string): {
  app: string;
  machineId: string;
} {
  const slash = externalId.indexOf("/");
  if (slash <= 0 || slash === externalId.length - 1) {
    throw new Error(
      `fly: malformed external id "${externalId}" — expected "<app>/<machineId>"`
    );
  }
  return {
    app: externalId.slice(0, slash),
    machineId: externalId.slice(slash + 1),
  };
}

/**
 * Fly app names are DNS labels: lowercase alphanumerics and hyphens only. A
 * runtime id is `rt_<20 hex>`, whose underscore Fly rejects.
 */
export function flyAppNameFor(prefix: string, runtimeId: string): string {
  const slug = runtimeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}-${slug}`;
}

// ─── Driver ───────────────────────────────────────────────────────────────────

export interface FlyMachinesOptions {
  /** Where FLY_API_TOKEN comes from. Injected in tests; env in production. */
  credentials?: CredentialResolver;
  orgSlug?: string;
  region?: string;
  appPrefix?: string;
  volumeSizeGb?: number;
  baseUrl?: string;
  /** Injectable fetch — used to inject a fake in unit tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Pass `noPacer` in tests; production gets the real 1/s bucket. */
  pacer?: Pacer;
}

export class FlyMachinesProvisioner implements RuntimeProvisioner {
  readonly provider = "fly" as const;

  readonly supportedTiers: ResourceTier[] = ["small", "medium", "large"];

  /**
   * Every value here was measured on a real Fly account on 2026-08-12, not read
   * off a documentation page. See fly.test.ts, which records what each probe
   * saw.
   */
  readonly manifest: DriverManifest = {
    provider: "fly",
    // The rootfs is wiped across stop/start; the mounted volume is not. The
    // workspace lives on the volume, and the image's wrapper is what puts it
    // there.
    workspaceStorage: "volume",
    // Machine id AND volume both survive a stop. This is a Docker-shaped
    // substrate in that one respect, and the only one.
    stopSemantics: "resumable",
    // Fly destroys nothing for age.
    maxLifetimeMs: null,
    // config.image is per machine — the input Cloudflare had to refuse.
    imageBinding: "per-instance",
    // config.guest is per machine too, so all three tiers map to real sizes.
    supportedTiers: ["small", "medium", "large"],
    // Fly's autostop is Fly-Proxy-driven and only touches machines with inbound
    // `services` configured. This driver defines none, so the trap that ruled
    // out Fly Sprites and bit Cloudflare cannot arise. The hub drives stop and
    // start itself, which it already does.
    idleBehaviour: "hub-driven",
    lifecycle: ["start", "stop", "status"],
  };

  private readonly request: FlyRequest;
  private readonly orgSlug: string;
  private readonly region: string;
  private readonly appPrefix: string;
  private readonly volumeSizeGb: number;

  constructor({
    credentials = envCredentialResolver(),
    orgSlug = process.env.FLY_ORG_SLUG || "personal",
    // Measured 2026-08-12: "bom" is refused on a non-paid plan, "sin" works.
    region = process.env.FLY_REGION || "sin",
    appPrefix = process.env.FLY_APP_PREFIX || "agentpod",
    volumeSizeGb = Number(process.env.FLY_VOLUME_SIZE_GB || 3),
    baseUrl,
    fetchImpl,
    pacer,
  }: FlyMachinesOptions = {}) {
    // The first real caller of credentials.ts. A missing key refuses to
    // construct, so a misconfigured deployment fails at boot with the variable
    // name in the message rather than on a user's first provision.
    const { FLY_API_TOKEN } = requireCredentials(
      "fly",
      ["FLY_API_TOKEN"],
      credentials
    );

    this.orgSlug = orgSlug;
    this.region = region;
    this.appPrefix = appPrefix;
    this.volumeSizeGb = volumeSizeGb;
    this.request = createFlyClient({
      token: FLY_API_TOKEN,
      baseUrl,
      fetchImpl,
      pacer,
    });
  }

  async provision(
    _spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    throw new Error("fly: provision() is not implemented yet");
  }

  async destroy(_externalId: string): Promise<void> {
    throw new Error("fly: destroy() is not implemented yet");
  }

  async start(_externalId: string): Promise<void> {
    throw new Error("fly: start() is not implemented yet");
  }

  async stop(_externalId: string): Promise<void> {
    throw new Error("fly: stop() is not implemented yet");
  }

  async status(_externalId: string): Promise<RuntimeState> {
    throw new Error("fly: status() is not implemented yet");
  }
}
```

Note: `createFlyClient` accepts `baseUrl: undefined` and `pacer: undefined` and falls back to its own defaults, so no conditional spreading is needed. `FlyApiError`, `FLY_TIERS`, `FLY_VOLUME_MOUNT`, `FLY_VOLUME_NAME`, `WAIT_TIMEOUT_S` and `flyAppNameFor` are unused until the next tasks; leave them, they land within two commits.

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/fly.ts apps/hub/src/services/provisioner/fly.test.ts
git commit -m "feat(provisioner): Fly driver skeleton, manifest and credential wiring"
```

---

### Task 4: provision() — app, then volume, then machine

Order matters and is not stylistic: a Fly volume is pinned to a physical host, so a machine created before its volume can land on a different host and fail to attach.

**Files:**
- Create: `apps/hub/src/services/provisioner/fly-fake-substrate.ts`
- Modify: `apps/hub/src/services/provisioner/fly.ts`
- Test: `apps/hub/src/services/provisioner/fly.test.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: a working `provision()`; and from the fake substrate module, `createFlyFakeSubstrate(opts?: FlyFakeOptions): FlyFakeSubstrate` where `FlyFakeSubstrate` is `{ fetchImpl: typeof globalThis.fetch; calls: Array<{ method: string; path: string; body: unknown }>; apps: Map<string, FakeApp> }`, `FakeApp` is `{ volumes: Map<string, { id: string; size_gb: number; region: string }>; machines: Map<string, { id: string; instance_id: string; state: string; config: Record<string, unknown> }> }`, and `FlyFakeOptions` is `{ failMachineCreate?: boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/fly.test.ts`, and add these imports at the top:

```ts
import { createFlyFakeSubstrate } from "./fly-fake-substrate";
import type { ProvisionSpec } from "./types";
```

```ts
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
```

Add `FlyMachinesOptions` to the `./fly` import at the top of the test file (as a `import type`).

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: FAIL — `Cannot find module './fly-fake-substrate'`.

- [ ] **Step 3: Write the fake substrate**

Create `apps/hub/src/services/provisioner/fly-fake-substrate.ts`. **It must be faithful**, including the unfriendly parts: a fake that tolerates everything makes every behavioural rule in the conformance suite pass for free, which is the same as not having them.

```ts
/**
 * A faithful in-memory Fly Machines API, for unit tests and the conformance
 * suite.
 *
 * NOT a *.test.ts file on purpose: bun would run its importer's tests twice if
 * one test file imported another. Both fly.test.ts and conformance.test.ts use
 * this.
 *
 * "Faithful" is load-bearing. This mirrors the behaviours the driver actually
 * depends on:
 *   - creating an app that exists answers 409, not 200
 *   - `wait?state=` answers 408 when the machine is not in that state
 *   - waiting for `stopped` REQUIRES instance_id
 *   - deleting an app takes its volumes and machines with it
 *   - anything about a gone app or machine is a 404
 * A lenient fake would let a driver that never checks any of that pass.
 */

export interface FakeMachine {
  id: string;
  instance_id: string;
  state: string;
  config: Record<string, unknown>;
}

export interface FakeApp {
  volumes: Map<string, { id: string; size_gb: number; region: string }>;
  machines: Map<string, FakeMachine>;
}

export interface FlyFakeOptions {
  /** Make POST .../machines fail, to exercise the driver's cleanup path. */
  failMachineCreate?: boolean;
}

export interface FlyFakeSubstrate {
  fetchImpl: typeof globalThis.fetch;
  calls: Array<{ method: string; path: string; body: unknown }>;
  apps: Map<string, FakeApp>;
}

export function createFlyFakeSubstrate(
  options: FlyFakeOptions = {}
): FlyFakeSubstrate {
  const apps = new Map<string, FakeApp>();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let nextId = 0;

  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

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
      const id = `vol_${++nextId}`;
      const spec = body as { size_gb?: number; region?: string };
      app.volumes.set(id, {
        id,
        size_gb: spec?.size_gb ?? 1,
        region: spec?.region ?? "sin",
      });
      return json({ id, name: (body as { name?: string })?.name }, 201);
    }

    if (parts[3] !== "machines") return json({ error: "not found" }, 404);

    // POST /v1/apps/{app}/machines
    if (parts.length === 4 && method === "POST") {
      if (options.failMachineCreate) {
        return json({ error: "no capacity in region" }, 422);
      }
      const config = (body as { config?: Record<string, unknown> })?.config ?? {};
      const mounts = (config.mounts as Array<{ volume?: string }> | undefined) ?? [];
      for (const mount of mounts) {
        if (!mount.volume || !app.volumes.has(mount.volume)) {
          return json({ error: `volume ${mount.volume} not found` }, 404);
        }
      }
      const id = `machine${++nextId}`;
      app.machines.set(id, {
        id,
        instance_id: `inst${nextId}`,
        state: "started",
        config,
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
```

- [ ] **Step 4: Implement provision()**

In `fly.ts`, replace the throwing `provision` with this, and add the private helpers below it (still inside the class):

```ts
  /**
   * Create a Fly app, a volume in it, and a machine mounting that volume.
   *
   * The order is not stylistic. A Fly volume is pinned to a physical host, so a
   * machine created before its volume can be placed on a different host and
   * fail to attach.
   */
  async provision(
    spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    const app = flyAppNameFor(this.appPrefix, spec.runtimeId);
    const guest = FLY_TIERS[spec.resourceTier];
    if (!guest) {
      throw new Error(
        `fly: cannot provision resource tier "${spec.resourceTier}"`
      );
    }

    await this.ensureApp(app);

    let machineId: string;
    try {
      const volumeId = await this.createVolume(app);
      machineId = await this.createMachine(app, volumeId, guest, spec);
    } catch (err) {
      // provision() is about to throw, so the hub will never learn this app's
      // name — nothing will ever come back to destroy it. An orphaned app with
      // a volume in it bills monthly for a runtime the console never showed.
      await this.deleteAppQuietly(app);
      throw err;
    }

    return {
      externalId: formatFlyExternalId(app, machineId),
      runtime: "fly-machine",
    };
  }

  /**
   * Create the app, tolerating one that is already there.
   *
   * A retried provision — or a destroy that failed after the app was made —
   * finds it existing. That is the state this method exists to produce, so it
   * is not an error.
   */
  private async ensureApp(app: string): Promise<void> {
    try {
      await this.request("POST", "/v1/apps", {
        app_name: app,
        org_slug: this.orgSlug,
        // Its own 6PN network. A shared network would put every customer's
        // station on one private network, reachable by internal DNS.
        network: app,
      });
    } catch (err) {
      if (
        err instanceof FlyApiError &&
        (err.status === 409 || /already\s+(exists|been taken)/i.test(err.message))
      ) {
        return;
      }
      throw err;
    }
  }

  private async createVolume(app: string): Promise<string> {
    const { body } = await this.request("POST", `/v1/apps/${app}/volumes`, {
      name: FLY_VOLUME_NAME,
      region: this.region,
      size_gb: this.volumeSizeGb,
    });
    const id = body.id;
    if (typeof id !== "string" || !id) {
      throw new Error(
        `fly: unexpected response from POST /v1/apps/${app}/volumes (no volume id)`
      );
    }
    return id;
  }

  private async createMachine(
    app: string,
    volumeId: string,
    guest: { cpu_kind: string; cpus: number; memory_mb: number },
    spec: ProvisionSpec
  ): Promise<string> {
    const { body } = await this.request("POST", `/v1/apps/${app}/machines`, {
      name: app,
      region: this.region,
      config: {
        // Honoured per machine — the input Cloudflare had to refuse.
        image: spec.image,
        guest,
        env: {
          AGENTPOD_HUB_URL: spec.hubUrl,
          // NOTE: never logged from this module. Do not add a log statement
          // that references spec.enrollToken.
          AGENTPOD_ENROLL_TOKEN: spec.enrollToken,
          // agentpod-node stores nodeId/nodeSecret under os.UserConfigDir(),
          // i.e. under HOME, and opencode keeps its session state under
          // $HOME/.local/share/opencode. On the rootfs both are wiped by every
          // stop→start; on the volume neither is.
          HOME: `${FLY_VOLUME_MOUNT}/home`,
        },
        mounts: [{ volume: volumeId, path: FLY_VOLUME_MOUNT }],
        // The default, on-failure, leaves a machine `stopped` after a clean
        // exit — a station that quietly never comes back.
        restart: { policy: "always" },
        metadata: {
          agentpod_runtime_id: spec.runtimeId,
          agentpod_managed: "true",
        },
        // DELIBERATELY NO `services`. Fly's autostop is Fly-Proxy-driven and
        // only touches machines with inbound services configured. Measured
        // 2026-08-12: 25 minutes idle with only outbound traffic, `started`
        // throughout. Adding a services block here would recreate Cloudflare's
        // failure exactly — a node-agent dials out and receives nothing, so a
        // busy station reads as idle and gets reaped mid-session.
        //
        // And deliberately no `persist_rootfs`: Fly's own docs disclaim it for
        // critical data. The volume above is the answer.
      },
    });

    const id = body.id;
    if (typeof id !== "string" || !id) {
      throw new Error(
        `fly: unexpected response from POST /v1/apps/${app}/machines (no machine id)`
      );
    }
    return id;
  }

  /**
   * Best effort cleanup of a half-built runtime. Never throws: the caller is
   * already throwing the real failure, and replacing it with a cleanup error
   * would hide why provisioning failed.
   */
  private async deleteAppQuietly(app: string): Promise<void> {
    try {
      await this.request("DELETE", `/v1/apps/${app}`);
    } catch {
      // Swallowed on purpose — see above.
    }
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: PASS (21 tests).

- [ ] **Step 6: Prove the `services` guard is not vacuous**

Temporarily add `services: [{ ports: [{ port: 443 }], protocol: "tcp", internal_port: 8080 }],` inside the machine `config` in `createMachine`, re-run the test file, and confirm **"NEVER defines a services block"** FAILS. Then remove it.

This is the one line standing between this driver and the incident that ruled out Fly Sprites. Verify the guard actually guards.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/services/provisioner/fly.ts apps/hub/src/services/provisioner/fly.test.ts apps/hub/src/services/provisioner/fly-fake-substrate.ts
git commit -m "feat(provisioner): Fly provision — app, then volume, then machine"
```

---

### Task 5: start(), and the wait helper

**Files:**
- Modify: `apps/hub/src/services/provisioner/fly.ts`
- Test: `apps/hub/src/services/provisioner/fly.test.ts`

**Interfaces:**
- Produces: a working `start(externalId: string): Promise<void>`, and a private `waitFor(app, machineId, state: "started" | "stopped", instanceId?: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/fly.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: FAIL — `fly: start() is not implemented yet`.

- [ ] **Step 3: Implement start() and waitFor()**

In `fly.ts`, replace the throwing `start` and add `waitFor` next to it:

```ts
  /**
   * Start a stopped machine and give Fly a chance to confirm it.
   *
   * The wait is not the source of truth — startRuntime writes `starting`, never
   * `online`, and only an enrolment writes `online`. This just means an
   * ordinary start has usually already happened by the time the API call
   * returns, instead of leaving the console spinning for a sweeper tick.
   */
  async start(externalId: string): Promise<void> {
    const { app, machineId } = parseFlyExternalId(externalId);
    await this.request("POST", `/v1/apps/${app}/machines/${machineId}/start`);
    await this.waitFor(app, machineId, "started");
  }

  /**
   * Block on Fly's `wait?state=` until the machine reaches a state, or until
   * Fly gives up.
   *
   * A 408 is swallowed on purpose: it is Fly saying "not yet", not "it failed".
   * The hub already has the machinery for a machine that is slow or never
   * arrives — `starting`/`stopping` plus sweepStalledRuntimeStarts and
   * sweepStalledRuntimeStops — and a driver that threw here would turn a slow
   * image pull into an error in the operator's face for a machine that was
   * coming up fine. Every other status still throws: a 404 or a 422 is a
   * refusal, and swallowing that would hide the reason for two whole minutes.
   */
  private async waitFor(
    app: string,
    machineId: string,
    state: "started" | "stopped",
    instanceId?: string
  ): Promise<void> {
    const query = new URLSearchParams({ state, timeout: String(WAIT_TIMEOUT_S) });
    // Fly REQUIRES instance_id when waiting for `stopped`, and ignores it
    // otherwise.
    if (instanceId) query.set("instance_id", instanceId);

    try {
      await this.request(
        "GET",
        `/v1/apps/${app}/machines/${machineId}/wait?${query.toString()}`
      );
    } catch (err) {
      if (err instanceof FlyApiError && err.status === 408) return;
      throw err;
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: PASS (25 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/fly.ts apps/hub/src/services/provisioner/fly.test.ts
git commit -m "feat(provisioner): Fly start() with a state wait that tolerates 408"
```

---

### Task 6: stop(), which needs the instance id

**Files:**
- Modify: `apps/hub/src/services/provisioner/fly.ts`
- Test: `apps/hub/src/services/provisioner/fly.test.ts`

**Interfaces:**
- Consumes: `waitFor` from Task 5.
- Produces: a working `stop(externalId: string): Promise<void>`, and a private `instanceIdOf(app, machineId): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/fly.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: FAIL — `fly: stop() is not implemented yet`.

- [ ] **Step 3: Implement stop()**

In `fly.ts`, replace the throwing `stop`:

```ts
  /**
   * Stop a running machine, and wait for Fly to confirm it went down.
   *
   * The instance id is read FIRST because Fly requires it when waiting for
   * `stopped` — a restart gives a machine a new instance id, so "which run of
   * this machine" is a real question and the wait refuses to guess. Read after
   * the stop it would be racing the very transition being waited on.
   *
   * The hub still asks status() afterwards: stopRuntime writes `stopping` and
   * only ever writes `stopped` on the evidence status() returns. This wait just
   * means the ordinary case resolves before the operator can look away.
   */
  async stop(externalId: string): Promise<void> {
    const { app, machineId } = parseFlyExternalId(externalId);
    const instanceId = await this.instanceIdOf(app, machineId);
    await this.request("POST", `/v1/apps/${app}/machines/${machineId}/stop`);
    await this.waitFor(app, machineId, "stopped", instanceId);
  }

  /**
   * The current instance id, or undefined if Fly did not report one.
   *
   * Undefined rather than a throw: a wait without instance_id is worse than a
   * stop that cannot be waited on, and a runtime that cannot be stopped is a
   * runtime that keeps billing.
   */
  private async instanceIdOf(
    app: string,
    machineId: string
  ): Promise<string | undefined> {
    const { body } = await this.request(
      "GET",
      `/v1/apps/${app}/machines/${machineId}`
    );
    return typeof body.instance_id === "string" && body.instance_id
      ? body.instance_id
      : undefined;
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: PASS (29 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/fly.ts apps/hub/src/services/provisioner/fly.test.ts
git commit -m "feat(provisioner): Fly stop() with the instance id its wait requires"
```

---

### Task 7: status() — the only evidence the hub has for writing `stopped`

**Files:**
- Modify: `apps/hub/src/services/provisioner/fly.ts`
- Test: `apps/hub/src/services/provisioner/fly.test.ts`

**Interfaces:**
- Produces: a working `status(externalId: string): Promise<RuntimeState>` and an exported `flyStateToRuntimeState(state: unknown): RuntimeState`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/fly.test.ts`, and add `flyStateToRuntimeState` to the `./fly` import.

```ts
describe("FlyMachinesProvisioner — status", () => {
  it("reads the machine and reports what Fly says", async () => {
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app, machineId } = parseFlyExternalId(externalId);

    expect(await driver.status(externalId)).toBe("running");

    fake.apps.get(app)!.machines.get(machineId)!.state = "stopped";
    expect(await driver.status(externalId)).toBe("stopped");
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
    // Suspended keeps a memory snapshot but runs nothing, so it is not
    // billing compute — which is the question the hub is really asking.
    expect(flyStateToRuntimeState("suspended")).toBe("stopped");
    expect(flyStateToRuntimeState("destroyed")).toBe("stopped");
  });

  it("refuses to round a transitional state to an answer", () => {
    // Mid-flight, and not an answer. The sweeper asks again on the next tick
    // and only reports a problem if it is still unanswered five minutes later.
    expect(flyStateToRuntimeState("stopping")).toBe("unknown");
    expect(flyStateToRuntimeState("destroying")).toBe("unknown");
    // `created` means allocated but never run. This driver always starts what
    // it creates, so seeing it means something happened that we did not do —
    // which is exactly when a confident answer is worth least.
    expect(flyStateToRuntimeState("created")).toBe("unknown");
  });

  it("says unknown for a state Fly adds later", () => {
    expect(flyStateToRuntimeState("hibernating")).toBe("unknown");
    expect(flyStateToRuntimeState(undefined)).toBe("unknown");
    expect(flyStateToRuntimeState(42)).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: FAIL — `fly: status() is not implemented yet`.

- [ ] **Step 3: Implement status()**

In `fly.ts`, add this exported function after `flyAppNameFor`:

```ts
/**
 * Fly's machine states, mapped to the three answers the hub understands.
 *
 * The hub turns `stopped` into a claim an operator reads as "it has stopped
 * costing me money", so the mapping is drawn on whether the machine is holding
 * compute — not on whether the word sounds final:
 *
 *   - started/starting/replacing → running. All three hold resources.
 *   - stopped/suspended/destroyed → stopped. None runs anything. Suspended
 *     keeps a memory snapshot but executes nothing, and Fly's suspend is an
 *     optimisation of start rather than a state this driver ever asks for.
 *   - everything else → unknown. `stopping` and `destroying` are mid-flight;
 *     `created` means allocated but never run, which this driver never leaves a
 *     machine as, so seeing it means something we did not do. A state Fly adds
 *     next year lands here too, which is the safe place for it: the sweeper
 *     asks again, and only calls it a problem after five minutes.
 */
export function flyStateToRuntimeState(state: unknown): RuntimeState {
  switch (state) {
    case "started":
    case "starting":
    case "replacing":
      return "running";
    case "stopped":
    case "suspended":
    case "destroyed":
      return "stopped";
    default:
      return "unknown";
  }
}
```

Then replace the throwing `status` in the class:

```ts
  /**
   * Ask Fly whether this machine is actually running.
   *
   * The evidence behind a `stopped` runtime on this substrate: stopRuntime
   * writes `stopping` and only confirms `stopped` on what this returns.
   *
   * A 404 is reported `stopped` — a machine Fly has no record of is not running
   * and cannot be billing, the same answer the Docker driver gives for a
   * container the daemon forgot. Anything else throws, and the service layer
   * degrades that to `unknown` rather than letting an unreachable API read as
   * confirmation of a stop.
   */
  async status(externalId: string): Promise<RuntimeState> {
    const { app, machineId } = parseFlyExternalId(externalId);
    try {
      const { body } = await this.request(
        "GET",
        `/v1/apps/${app}/machines/${machineId}`
      );
      return flyStateToRuntimeState(body.state);
    } catch (err) {
      if (err instanceof FlyApiError && err.status === 404) return "stopped";
      throw err;
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: PASS (36 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/fly.ts apps/hub/src/services/provisioner/fly.test.ts
git commit -m "feat(provisioner): Fly status() mapping every machine state to evidence"
```

---

### Task 8: destroy(), idempotent

Conformance rule 6 requires it, and it is not theoretical: the Docker driver's non-idempotent destroy was a real bug fixed on 2026-08-12. `destroyRuntime` turns a driver throw into a 502 and leaves the row un-destroyed, so a destroy that cannot be retried wedges the runtime permanently.

**Files:**
- Modify: `apps/hub/src/services/provisioner/fly.ts`
- Test: `apps/hub/src/services/provisioner/fly.test.ts`

**Interfaces:**
- Produces: a working `destroy(externalId: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/fly.test.ts`:

```ts
describe("FlyMachinesProvisioner — destroy", () => {
  it("deletes the app, which takes the machine and the volume with it", async () => {
    // One call, not three. Three ordered deletes would be three ways to leak a
    // volume, and a leaked Fly volume bills every month for a runtime the
    // console no longer shows.
    const { driver, fake } = flyDriver();
    const { externalId } = await driver.provision(SPEC);
    const { app } = parseFlyExternalId(externalId);

    fake.calls.length = 0;
    await driver.destroy(externalId);

    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `DELETE /v1/apps/${app}`,
    ]);
    expect(fake.apps.has(app)).toBe(false);
  });

  it("IS IDEMPOTENT — a second destroy does not throw", async () => {
    // destroyRuntime turns a driver throw into a 502 and leaves the row
    // un-destroyed, so a destroy that half-succeeded could never be retried to
    // completion. Docker had exactly this bug.
    const { driver } = flyDriver();
    const { externalId } = await driver.provision(SPEC);

    await driver.destroy(externalId);
    await expect(driver.destroy(externalId)).resolves.toBeUndefined();
  });

  it("still throws when Fly cannot be reached", async () => {
    // Only "already gone" is forgiven. Reporting a successful destroy for an
    // app nobody could look at is the worse bug: it is a runtime that keeps
    // billing with nothing in the console to say so.
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
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: FAIL — `fly: destroy() is not implemented yet`.

- [ ] **Step 3: Implement destroy()**

In `fly.ts`, replace the throwing `destroy`:

```ts
  /**
   * Permanently destroy the runtime by deleting its app.
   *
   * One call rather than three, because the app owns the machine and the volume:
   * deleting it takes both. Three ordered deletes would be three chances to
   * leak a volume, and a leaked Fly volume bills every month for a runtime the
   * console no longer shows.
   *
   * Idempotent (conformance rule 6): an app Fly has no record of is already in
   * the state destroy is asked to produce, so a 404 returns rather than throws.
   * It has to — destroyRuntime turns a driver throw into a 502 and leaves the
   * row un-destroyed, so before Docker's destroy tolerated this a half-finished
   * destroy wedged the runtime permanently.
   *
   * Only that one condition is forgiven. A 500, a timeout or an auth failure
   * still throws: reporting a successful destroy for an app nobody could look
   * at would be the worse bug.
   */
  async destroy(externalId: string): Promise<void> {
    const { app } = parseFlyExternalId(externalId);
    try {
      await this.request("DELETE", `/v1/apps/${app}`);
    } catch (err) {
      if (err instanceof FlyApiError && err.status === 404) return;
      throw err;
    }
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/fly.test.ts`
Expected: PASS (39 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/fly.ts apps/hub/src/services/provisioner/fly.test.ts
git commit -m "feat(provisioner): Fly destroy() deletes the app, idempotently"
```

---

### Task 9: Hold the Fly driver to its manifest

The conformance suite is the gate the groundwork built. This is what it was built for.

**Files:**
- Modify: `apps/hub/src/services/provisioner/conformance.test.ts`

**Interfaces:**
- Consumes: `assertConforms` from `./conformance`, `FlyMachinesProvisioner` from `./fly`, `createFlyFakeSubstrate` from `./fly-fake-substrate`, `noPacer` from `./fly-api`.

- [ ] **Step 1: Write the failing test**

Add these imports to the top of `apps/hub/src/services/provisioner/conformance.test.ts`:

```ts
import { FlyMachinesProvisioner } from "./fly";
import { createFlyFakeSubstrate } from "./fly-fake-substrate";
import { noPacer } from "./fly-api";
```

Then append, inside the existing `describe("assertConforms — the real drivers", …)` block:

```ts
  /**
   * The Fly driver against a faithful in-memory Fly API.
   *
   * `noPacer` is not an optimisation: the real pacer allows one request per
   * second past a burst of three, assertConforms provisions five times, and a
   * provision is four calls. Paced, this one test would add roughly twenty
   * seconds to every CI run and prove nothing about the driver.
   */
  const flyDriver = () =>
    new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      orgSlug: "conformance",
      region: "sin",
      fetchImpl: createFlyFakeSubstrate().fetchImpl,
      pacer: noPacer,
    });

  it("holds the real Fly driver to every declaration", async () => {
    // No probe.image: the manifest declares imageBinding "per-instance", so
    // the suite builds its own spec and the driver must honour it — the
    // opposite of Cloudflare, which needs its deployed image passed in.
    await expect(assertConforms(flyDriver())).resolves.toBeUndefined();
  });

  it("would catch a Fly driver whose destroy stopped being idempotent", async () => {
    // The suite is only worth having if it fails when the behaviour regresses.
    // Docker's destroy was non-idempotent for real, and fixing it was a
    // 2026-08-12 bug fix — this pins that the same regression on Fly is caught.
    const driver = flyDriver();
    const strict: RuntimeProvisioner = {
      ...driver,
      manifest: driver.manifest,
      provision: (spec) => driver.provision(spec),
      start: (id) => driver.start(id),
      stop: (id) => driver.stop(id),
      status: (id) => driver.status(id),
      destroy: async (id: string) => {
        const state = await driver.status(id);
        if (state === "stopped") {
          throw new Error(`fly: no such app for ${id}`);
        }
        await driver.destroy(id);
      },
    };
    await expect(assertConforms(strict)).rejects.toThrow(/destroy/i);
  });
```

- [ ] **Step 2: Run it and confirm the first test's failure mode is real**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/conformance.test.ts`
Expected: PASS — both. If "holds the real Fly driver to every declaration" fails, **suspect the driver first**: it is the newest thing here, and every rule the suite checks is a declaration this driver made in Task 3.

- [ ] **Step 3: Prove the gate is not vacuous**

Temporarily change `imageBinding` in `fly.ts`'s manifest from `"per-instance"` to `"fixed"`, re-run the file, and confirm "holds the real Fly driver to every declaration" FAILS with a message naming `imageBinding`. Then change it back and re-run to confirm PASS.

A conformance test that would pass whatever the driver declared is not a gate.

- [ ] **Step 4: Commit**

```bash
git add apps/hub/src/services/provisioner/conformance.test.ts
git commit -m "test(provisioner): hold the Fly driver to its manifest in the conformance suite"
```

---

### Task 10: Register it, and refuse to boot a misconfigured Fly deployment

The registry itself needs no edit — `providerEnvFlag("fly")` already derives `ENABLE_FLY_PROVISIONING`. This wires the instance in and makes a missing token a boot-time failure with a message rather than a 502 on someone's first provision.

**Files:**
- Modify: `apps/hub/src/services/provisioner/bootstrap.ts`
- Modify: `apps/hub/src/config.ts`
- Modify: `apps/hub/src/utils/validate-config.ts`
- Test: `apps/hub/src/utils/validate-config.test.ts`
- Test: `apps/hub/src/services/provisioner/registry.test.ts`

**Interfaces:**
- Consumes: `FlyMachinesProvisioner` (Task 3), `registerProvisioner` / `isProviderEnabled` from `./registry`, `collectConfigErrors` from `../utils/validate-config`.
- Produces: `config.fly = { enabled: boolean; apiToken: string; orgSlug: string; region: string; appPrefix: string; volumeSizeGb: number }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/hub/src/utils/validate-config.test.ts` (mirror the file's existing style for building a config object — it clones `config` and overrides fields):

```ts
describe("fly provisioning config", () => {
  const withFly = (fly: Partial<typeof config.fly>) =>
    ({ ...config, fly: { ...config.fly, ...fly } }) as typeof config;

  it("REFUSES to boot with Fly enabled and no token", () => {
    // A missing credential is a startup-time refusal, not a runtime failure on
    // a user's first provisioning attempt. Without this the hub boots happily
    // and the driver throws inside createRuntime, where the operator sees a 502
    // and no mention of a variable.
    const errors = collectConfigErrors(
      withFly({ enabled: true, apiToken: "" }),
      () => {}
    );
    expect(errors.map((e) => e.field)).toContain("FLY_API_TOKEN");
  });

  it("says nothing about Fly when Fly is off", () => {
    // A Docker-only hub must not be stopped from booting by a variable for a
    // substrate it never talks to.
    const errors = collectConfigErrors(
      withFly({ enabled: false, apiToken: "" }),
      () => {}
    );
    expect(errors.map((e) => e.field)).not.toContain("FLY_API_TOKEN");
  });

  it("refuses a volume size Fly cannot create", () => {
    // Fly's minimum is 1 GB. A zero here produces a machine with a mount that
    // does not exist — i.e. a workspace on the rootfs, which is wiped on every
    // stop. That is the exact data loss this substrate was chosen to avoid.
    const errors = collectConfigErrors(
      withFly({ enabled: true, apiToken: "fly-token", volumeSizeGb: 0 }),
      () => {}
    );
    expect(errors.map((e) => e.field)).toContain("FLY_VOLUME_SIZE_GB");
  });

  it("accepts a complete Fly configuration", () => {
    const errors = collectConfigErrors(
      withFly({ enabled: true, apiToken: "fly-token", volumeSizeGb: 3 }),
      () => {}
    );
    expect(errors.map((e) => e.field)).not.toContain("FLY_API_TOKEN");
    expect(errors.map((e) => e.field)).not.toContain("FLY_VOLUME_SIZE_GB");
  });
});
```

Append to `apps/hub/src/services/provisioner/registry.test.ts`:

```ts
describe("fly provider gating", () => {
  it("derives ENABLE_FLY_PROVISIONING without any edit to the registry", () => {
    // The whole point of the groundwork: a driver named "fly" gets its flag
    // from the rule. If this ever needs a line in LEGACY_ENV_FLAGS, the
    // registry has stopped being open.
    expect(providerEnvFlag("fly")).toBe("ENABLE_FLY_PROVISIONING");
  });
});
```

(`providerEnvFlag` is already exported from `./registry`; add it to the file's import if it is not there.)

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/utils/validate-config.test.ts src/services/provisioner/registry.test.ts`
Expected: FAIL — `config.fly` is undefined, so `withFly` throws. The registry test may already pass; that is fine and is the point of it.

- [ ] **Step 3: Add the config section**

In `apps/hub/src/config.ts`, add after the `cloudflare` block:

```ts
  fly: {
    enabled: getEnvBool('ENABLE_FLY_PROVISIONING', false),
    // Read here ONLY so validate-config can refuse the boot with a message
    // naming the variable. The DRIVER resolves this through
    // requireCredentials(), which is the seam the per-org encrypted store
    // (Horizon 3) replaces — do not make the driver read config.fly.apiToken.
    apiToken: getEnv('FLY_API_TOKEN', ''),
    // App creation requires an ORG-scoped token; Fly's app-scoped deploy tokens
    // can do everything else but not that.
    orgSlug: getEnv('FLY_ORG_SLUG', 'personal'),
    // Measured 2026-08-12: "bom" is refused on a non-paid plan ("legacy or
    // non-paid plan"), "sin" works.
    region: getEnv('FLY_REGION', 'sin'),
    appPrefix: getEnv('FLY_APP_PREFIX', 'agentpod'),
    // The workspace lives here, because the Fly rootfs is wiped on every
    // stop→start.
    volumeSizeGb: getEnvInt('FLY_VOLUME_SIZE_GB', 3),
  },
```

- [ ] **Step 4: Add the validation rules**

In `apps/hub/src/utils/validate-config.ts`, add before `return errors;` in `collectConfigErrors`:

```ts
  // Conditional for the same reason as CLOUDFLARE_SANDBOX_IMAGE above: required
  // only where the Fly driver is actually registered.
  if (cfg.fly.enabled && !cfg.fly.apiToken) {
    errors.push({
      field: "FLY_API_TOKEN",
      message:
        "Required when ENABLE_FLY_PROVISIONING=true. Generate with `flyctl tokens create org <org>` " +
        "(app-scoped deploy tokens cannot CREATE apps, and this driver creates one per runtime). " +
        "Set the expiry explicitly — Fly defaults it to twenty years.",
    });
  }

  // Fly's minimum volume is 1 GB, and the volume is where the workspace lives:
  // this substrate wipes the rootfs on every stop→start, so a machine whose
  // mount failed loses a user's work exactly the way Cloudflare did.
  if (cfg.fly.enabled && cfg.fly.volumeSizeGb < 1) {
    errors.push({
      field: "FLY_VOLUME_SIZE_GB",
      message:
        `Must be at least 1 (got ${cfg.fly.volumeSizeGb}). The workspace lives on this volume ` +
        "because the Fly rootfs does not survive a stop.",
    });
  }
```

- [ ] **Step 5: Register the driver**

In `apps/hub/src/services/provisioner/bootstrap.ts`, add the import and the registration:

```ts
import { FlyMachinesProvisioner } from "./fly";
```

and, at the end of `registerEnabledProvisioners()`:

```ts
  if (isProviderEnabled("fly")) {
    // Constructing it resolves FLY_API_TOKEN through requireCredentials, which
    // throws if it is missing — a startup-time refusal to register, by design.
    // validate-config has already refused the boot with a better message by
    // this point, so this throw is the backstop rather than the front line.
    //
    // No activity toucher, unlike Cloudflare: a Fly machine with no `services`
    // block is never reaped for idleness, so there is no deadline to push out.
    registerProvisioner(new FlyMachinesProvisioner());
  }
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/utils/validate-config.test.ts src/services/provisioner/`
Expected: PASS.

- [ ] **Step 7: Run the whole hub suite**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`
Expected: PASS. `config.ts` is imported widely, so this is where a bad addition to it surfaces.

- [ ] **Step 8: Commit**

```bash
git add apps/hub/src/services/provisioner/bootstrap.ts apps/hub/src/config.ts apps/hub/src/utils/validate-config.ts apps/hub/src/utils/validate-config.test.ts apps/hub/src/services/provisioner/registry.test.ts
git commit -m "feat(hub): register the Fly provisioner and validate its configuration at boot"
```

---

### Task 11: The runtime image, with the workspace on the volume

The image is where the measured fact becomes an engineering decision. `/workspace` is hardcoded in the fleet's OpenCode entrypoint (and in `internal/descriptor/opencode.go`), and `HOME` is where `agentpod-node` keeps `nodeId`/`nodeSecret`. Both sit on the rootfs, which Fly wipes. A wrapper points both at the mount before the entrypoint runs.

The wrapper is a WRAPPER, not an edit to the entrypoint, for the reason the Cloudflare one gives: the entrypoint is subtle (double-fork supervision, a stop sentinel, a zombie that once froze the health check) and Docker runtimes need none of this.

**Files:**
- Create: `fly/node-image/volume-workspace.sh`
- Create: `fly/node-image/test-volume-workspace.sh`
- Create: `fly/node-image/Dockerfile`
- Create: `fly/node-image/README.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: an image whose `ENTRYPOINT` is `["/volume-workspace.sh", "/node-opencode-entrypoint.sh"]`, mounting its volume at `/data` (matching `FLY_VOLUME_MOUNT` from Task 3) and reading `HOME=/data/home` (matching what `createMachine` sets in Task 4).

- [ ] **Step 1: Write the failing test**

Create `fly/node-image/test-volume-workspace.sh`:

```sh
#!/bin/sh
# Tests for volume-workspace.sh.
#
# POSIX sh with no framework, because it runs in the node-agent CI job next to
# `go test` and must not need a package manager. Exits non-zero on the first
# failure.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/volume-workspace.sh"
FAILURES=0

fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "ok: $1"
}

# ── It refuses to run without the mount ──────────────────────────────────────
# A machine whose volume did not mount would otherwise write the user's work to
# a rootfs Fly wipes on the next stop — the exact loss this substrate was chosen
# to avoid. A crash loop with a legible log is the better failure.
TMP="$(mktemp -d)"
if AGENTPOD_VOLUME_PATH="$TMP/definitely-not-mounted" sh "$WRAPPER" /bin/true 2>"$TMP/err"; then
  fail "ran without a mounted volume"
else
  if grep -q "not mounted" "$TMP/err"; then
    pass "refuses to run without the mounted volume, and says so"
  else
    fail "refused without the mount but the message did not say why: $(cat "$TMP/err")"
  fi
fi
rm -rf "$TMP"

# ── It points /workspace and HOME at the mount, then execs ───────────────────
TMP="$(mktemp -d)"
mkdir -p "$TMP/mount"
cat >"$TMP/inner.sh" <<'INNER'
#!/bin/sh
echo "HOME=$HOME"
echo "PWD_TARGET=$(cd /workspace 2>/dev/null && pwd -P || echo MISSING)"
echo "ARGS=$*"
INNER
chmod +x "$TMP/inner.sh"

# /workspace is an absolute path the fleet entrypoint hardcodes, so this part
# of the test needs root or a container. Skip cleanly rather than fail when the
# runner cannot write to /.
if [ -w / ]; then
  OUT="$(AGENTPOD_VOLUME_PATH="$TMP/mount" sh "$WRAPPER" "$TMP/inner.sh" hello 2>&1)"

  echo "$OUT" | grep -q "HOME=$TMP/mount/home" \
    && pass "HOME points at the volume" \
    || fail "HOME not on the volume: $OUT"

  echo "$OUT" | grep -q "PWD_TARGET=$TMP/mount/workspace" \
    && pass "/workspace resolves onto the volume" \
    || fail "/workspace not on the volume: $OUT"

  echo "$OUT" | grep -q "ARGS=hello" \
    && pass "passes the inner command its arguments" \
    || fail "arguments lost: $OUT"

  [ -d "$TMP/mount/home" ] \
    && pass "creates the home directory on the volume" \
    || fail "home directory not created"

  rm -f /workspace
else
  echo "skip: / is not writable, cannot test the /workspace symlink here"
fi
rm -rf "$TMP"

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES failure(s)"
  exit 1
fi
echo "all volume-workspace tests passed"
```

```bash
chmod +x fly/node-image/test-volume-workspace.sh
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `sh fly/node-image/test-volume-workspace.sh`
Expected: FAIL — `volume-workspace.sh` does not exist (`sh: ...: No such file or directory`).

- [ ] **Step 3: Write the wrapper**

Create `fly/node-image/volume-workspace.sh`:

```sh
#!/bin/sh
# Workspace and identity persistence for the Fly Machines substrate.
#
# MEASURED 2026-08-12 on a real Fly account: a sentinel written to / was GONE
# after a stop→start; the same sentinel on a mounted volume survived, and the
# machine id and volume were both preserved. So everything that must outlive a
# stop has to be on the mount.
#
# Two things must:
#   /workspace                 — the user's files. Hardcoded in the fleet's
#                                OpenCode entrypoint and in the node-agent's
#                                opencode descriptor, so it is a symlink here
#                                rather than a configurable path.
#   $HOME                      — agentpod-node keeps nodeId/nodeSecret at
#                                os.UserConfigDir()/agentpod-node/config.json,
#                                and opencode keeps its session state at
#                                $HOME/.local/share/opencode. Without both, a
#                                woken station has neither its files nor any
#                                memory of the conversation that produced them.
#
# This is a WRAPPER, not an edit to the entrypoint. The entrypoint is subtle
# (double-fork supervision, a stop sentinel, a zombie that once froze the health
# check) and is shared byte-for-byte with the Docker fleet, whose disk persists
# and which needs none of this. The logic belongs to the substrate that lacks it.
#
# Fly's `persist_rootfs` is deliberately NOT used: Fly's own docs disclaim it
# for critical data, and whether it survives a full stop→start is undocumented.
#
# Usage: volume-workspace.sh <inner-entrypoint> [args...]
set -e

MOUNT="${AGENTPOD_VOLUME_PATH:-/data}"

# A machine whose volume failed to mount would write the user's work to a rootfs
# Fly wipes on the next stop — silently, and looking exactly like a working
# station until the moment the work is gone. Fly's restart policy is `always`,
# so this exit produces a visible crash loop with a legible log instead. That is
# the better failure by a wide margin.
if [ ! -d "$MOUNT" ]; then
  echo "[fly] FATAL: $MOUNT is not mounted." >&2
  echo "[fly] The Fly rootfs is wiped on every stop, so without the volume this" >&2
  echo "[fly] station would lose the user's workspace and its node identity." >&2
  echo "[fly] Check the machine's config.mounts and that the volume exists." >&2
  exit 1
fi

mkdir -p "$MOUNT/workspace" "$MOUNT/home"

# The rootfs is fresh on every boot, so /workspace is either absent or a stale
# real directory from the image. Either way it is replaced by the symlink.
if [ -e /workspace ] && [ ! -L /workspace ]; then
  rm -rf /workspace
fi
ln -sfn "$MOUNT/workspace" /workspace

HOME="$MOUNT/home"
export HOME

echo "[fly] workspace and home anchored on $MOUNT"

exec "$@"
```

```bash
chmod +x fly/node-image/volume-workspace.sh
```

- [ ] **Step 4: Run the test**

Run: `sh fly/node-image/test-volume-workspace.sh`
Expected: PASS — "all volume-workspace tests passed". On a machine where `/` is not writable the symlink assertions print `skip:`; that is fine locally, and CI runs as a user who can write to `/`.

- [ ] **Step 5: Write the Dockerfile**

Create `fly/node-image/Dockerfile`. Unlike the Cloudflare image, this one is built from the **repository root**, so it copies the fleet entrypoint directly instead of keeping a byte-identical duplicate that needs a parity test to police.

```dockerfile
# syntax=docker/dockerfile:1

# Fly Machines runtime image: node-agent + the OpenCode harness.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker buildx build --platform linux/amd64 \
#     -f fly/node-image/Dockerfile \
#     -t ghcr.io/<owner>/agentpod-node-opencode-fly:<version> --push .
#
# That is the one difference from cloudflare/worker-v2/Dockerfile worth knowing:
# wrangler pins its build context to its own directory, which forced that image
# to keep a byte-identical COPY of the fleet entrypoint and a parity test to stop
# the two drifting. Building from the root here means the fleet entrypoint is
# copied from where it lives, so there is nothing to drift.
#
# The binary comes from a RELEASE rather than being compiled, so a Fly station
# runs exactly the binary the rest of the fleet runs, verified against SHA256SUMS
# the same way install.sh and self-update do.

FROM oven/bun:1-slim

ARG AGENTPOD_VERSION=v0.1.22

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git procps \
    && rm -rf /var/lib/apt/lists/*
# procps provides `pgrep`, used by the OpenCode descriptor's running-process
# health check; without it the station Health panel shows "process check
# unavailable".
#
# `sqlite3` is deliberately NOT installed — see apps/node-agent/deploy/
# Dockerfile.opencode: omitting it forces the descriptor onto its
# directory-enumeration project-discovery fallback, so opencode's self-managed
# db schema stays irrelevant to detection.

# Pinned to the fleet version, which ships the `acp` subcommand the node-agent's
# ACPCommand spawns.
RUN bun add -g opencode-ai@1.18.15

# Installed at /agentpod-node so the fleet entrypoint works unmodified.
RUN set -eux; \
    base="https://github.com/rakeshgangwar/agentpod/releases/download/${AGENTPOD_VERSION}"; \
    curl -fsSL -o /agentpod-node "${base}/agentpod-node-linux-amd64"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    cp /agentpod-node /tmp/agentpod-node-linux-amd64; \
    (cd /tmp && grep ' agentpod-node-linux-amd64$' SHA256SUMS | sha256sum -c -); \
    rm -f /tmp/agentpod-node-linux-amd64 /tmp/SHA256SUMS; \
    chmod +x /agentpod-node; \
    /agentpod-node version

# The fleet's own entrypoint, copied from where it lives.
COPY apps/node-agent/deploy/node-opencode-entrypoint.sh /node-opencode-entrypoint.sh
RUN chmod +x /node-opencode-entrypoint.sh

# Workspace and identity persistence: the Fly rootfs is wiped on every
# stop→start (measured), so the wrapper points /workspace and HOME at the
# mounted volume before handing off. It execs the entrypoint rather than
# supervising it — unlike Cloudflare's snapshot wrapper there is nothing to do
# on the way out, because the volume is already the durable copy.
COPY fly/node-image/volume-workspace.sh /volume-workspace.sh
RUN chmod +x /volume-workspace.sh

ENTRYPOINT ["/volume-workspace.sh", "/node-opencode-entrypoint.sh"]
```

- [ ] **Step 6: Build the image and prove the wrapper works inside it**

```bash
cd "$(git rev-parse --show-toplevel)"
docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile \
  -t agentpod-node-opencode-fly:local --load .

# The mount is present: the wrapper anchors and hands off. Enrolment then fails
# on an unreachable hub, which is the expected end of this check.
docker run --rm -v "$(mktemp -d)":/data \
  -e AGENTPOD_HUB_URL=http://127.0.0.1:1 \
  -e AGENTPOD_ENROLL_TOKEN=not-a-real-token \
  agentpod-node-opencode-fly:local 2>&1 | head -20
# EXPECT: "[fly] workspace and home anchored on /data" before anything else.

# The mount is absent: it must refuse rather than write to the rootfs.
docker run --rm agentpod-node-opencode-fly:local 2>&1 | head -5
# EXPECT: "[fly] FATAL: /data is not mounted." and a non-zero exit.
```

- [ ] **Step 7: Push the image**

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <your-github-username> --password-stdin
docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile \
  -t ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22 --push .
```

Make the package **public** in the GitHub UI (Packages → the package → Package settings → Change visibility). Fly pulls anonymously; a private package fails the machine create with an authentication error that reads like a Fly problem.

- [ ] **Step 8: Write the image README**

Create `fly/node-image/README.md`:

```markdown
# Fly Machines runtime image

The image a `fly` provisioned runtime boots: the released `agentpod-node` binary
plus the OpenCode harness, with its workspace anchored on a mounted Fly Volume.

## Why the wrapper exists

Measured on a real Fly account on 2026-08-12: a sentinel written to `/` was gone
after a stop→start; the same sentinel on a mounted volume survived. The machine
id and the volume were both preserved.

So `volume-workspace.sh` runs before the fleet entrypoint and points the two
things that must outlive a stop at the mount:

| Path | Why it must persist |
|---|---|
| `/workspace` | the user's files. Hardcoded in the fleet OpenCode entrypoint and in `internal/descriptor/opencode.go`, so it is symlinked rather than configured. |
| `$HOME` | `agentpod-node` keeps `nodeId`/`nodeSecret` under `os.UserConfigDir()`, and opencode keeps session state at `$HOME/.local/share/opencode`. |

`persist_rootfs` is deliberately not used: Fly's own docs disclaim it for
critical data.

If the volume is not mounted the wrapper **exits non-zero** rather than running.
With Fly's `restart.policy = "always"` that is a visible crash loop, which is a
far better failure than a station that looks fine until the work disappears.

## Build and push

Build context is the **repository root**:

```bash
docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile \
  -t ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22 --push .
```

`--platform linux/amd64` is required: Fly Machines are amd64, and an arm64 image
built on an Apple laptop fails at boot with an exec format error.

The package must be **public** — Fly pulls anonymously.

`AGENTPOD_VERSION` selects which released binary is baked in; it defaults to the
fleet version in the Dockerfile and is verified against `SHA256SUMS`.

## Pointing the hub at it

`imageForHarness()` resolves the image for every provider, so the tag goes in
the hub's env:

```
NODE_AGENT_OPENCODE_IMAGE=ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22
```

A registry-qualified tag works for Docker provisioning too (the daemon pulls
it), which is what lets one hub run both providers. A bare local tag such as
`agentpod-node-opencode:local` cannot work on Fly — there is no such image in
any registry, and the machine create fails on the pull.

## Tests

`sh fly/node-image/test-volume-workspace.sh` — runs in CI in the `node-agent`
job.
```

- [ ] **Step 9: Wire the test into CI**

In `.github/workflows/ci.yml`, in the `node-agent` job, add a step after the `Test` step:

```yaml
      - name: Test the Fly image workspace wrapper
        run: sh fly/node-image/test-volume-workspace.sh
```

It lives in the `node-agent` job because it is about the node-agent's runtime
layout, and because that job is a required check — a new job would not gate.

- [ ] **Step 10: Commit**

```bash
git add fly/node-image .github/workflows/ci.yml
git commit -m "feat(fly): runtime image with the workspace anchored on the mounted volume"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/OPERATING.md`

- [ ] **Step 1: Add the env vars to the deployment runbook**

In `docs/DEPLOYMENT.md`, in the `── Provisioning ──` block of `/etc/agentpod/hub.env` (after the Cloudflare lines, before the closing `EOF`), add:

```
# Fly Machines provisioner: leave off unless you have a Fly account with a
# payment method — Fly's free tier no longer exists.
# ENABLE_FLY_PROVISIONING=false
# FLY_API_TOKEN=<flyctl tokens create org <org>>
# FLY_ORG_SLUG=personal
# FLY_REGION=sin
# FLY_APP_PREFIX=agentpod
# FLY_VOLUME_SIZE_GB=3
```

Then add to the **Key constraints** blockquote below it:

```
> - `FLY_API_TOKEN`: required whenever `ENABLE_FLY_PROVISIONING=true`, and it must be **org-scoped** (`flyctl tokens create org <org>`). The driver creates one Fly app per runtime, and Fly's app-scoped deploy tokens can do everything except create an app. Set the expiry explicitly — Fly defaults it to twenty years. Boot validation fails without it.
> - `FLY_REGION`: measured 2026-08-12 — `bom` is refused on a non-paid plan ("legacy or non-paid plan"); `sin` works. A refusal surfaces with the variable named.
> - `FLY_VOLUME_SIZE_GB`: the workspace lives on this volume, because the Fly rootfs is wiped on every stop→start. Minimum 1; boot validation fails below that.
> - `NODE_AGENT_OPENCODE_IMAGE` **must be registry-qualified** when Fly is enabled (e.g. `ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22`). `imageForHarness()` resolves one image per harness for every provider, and Fly pulls from a registry — a bare `agentpod-node-opencode:local` tag exists only on the Docker host and the machine create fails on the pull. A registry tag works for Docker too, which is what lets one hub run both. See `fly/node-image/README.md`.
```

- [ ] **Step 2: Add the operator section**

In `docs/OPERATING.md`, after the `### Cloudflare provisioner` subsection, add:

```markdown
### Fly Machines provisioner

Available in the UI if `ENABLE_FLY_PROVISIONING=true` is set in the hub env,
alongside `FLY_API_TOKEN` (org-scoped). All three resource tiers are offered,
and the harness image is honoured per machine — unlike Cloudflare, which fixes
both at deploy time.

**What the hub creates per runtime:** one Fly app (with its own 6PN network),
one volume in it, and one machine mounting that volume. Destroy deletes the app,
which takes the machine and the volume with it.

**Cost:** Fly has no free tier. A stopped machine bills nothing for compute, but
its **volume bills continuously** — so a runtime you are finished with should be
destroyed, not just stopped.

**Why a Fly station is not reaped while idle:** the machine is created with no
`services` block. Fly's autostop is driven by its proxy and only touches
machines with inbound services configured, so a station that dials out and
receives nothing is never read as idle. Measured 2026-08-12: 25 minutes idle,
`started` throughout. The hub drives stop and start itself.

**Why the workspace survives a stop:** it does not live on the rootfs, which Fly
wipes on every stop→start. `/workspace` and `$HOME` are symlinked onto the
mounted volume by the image's wrapper, so a restarted station comes back with
its files, its opencode session history and its node identity. See
`fly/node-image/README.md`.

**Cross-checking against Fly directly:**

```bash
flyctl apps list                              # one app per runtime, prefixed agentpod-
flyctl machines list -a agentpod-rt-<id>      # state, region, image
flyctl volumes list -a agentpod-rt-<id>       # the volume that holds the workspace
flyctl logs -a agentpod-rt-<id>               # the machine's console
```
```

Then add to `## 8. Troubleshooting`:

```markdown
**A Fly runtime never comes online:**
- `flyctl logs -a agentpod-rt-<id>`. `[fly] FATAL: /data is not mounted.` means the volume did not attach — check `flyctl volumes list -a <app>`; the wrapper refuses to run rather than write the workspace to a rootfs Fly wipes.
- An `exec format error` means an arm64 image: rebuild with `--platform linux/amd64`.
- A pull failure means `NODE_AGENT_OPENCODE_IMAGE` is a bare local tag, or the GHCR package is private. Fly pulls anonymously from a registry.

**Provisioning fails with "legacy or non-paid plan":**
- `FLY_REGION` names a region this account's plan does not cover. `sin` was measured to work on a non-paid account; `bom` was refused.

**Provisioning fails with an app-creation error:**
- The token is app-scoped. This driver creates one app per runtime, which needs an org-scoped token: `flyctl tokens create org <org>`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOYMENT.md docs/OPERATING.md
git commit -m "docs: Fly Machines provisioner deployment and operations"
```

---

### Task 13: Live verification against a real Fly account

Features touching the live fleet get verified against the real deployment before their issue closes. This one also spends money, so it ends by destroying everything it made and proving it.

**Preconditions:** the image from Task 11 pushed and public; a Fly account with a payment method; `flyctl` logged in; a hub you can restart (local is fine — the machine must be able to reach it, so `PROVISIONING_HUB_URL` must be a public URL, not `127.0.0.1`).

- [ ] **Step 1: Configure and boot the hub**

```bash
export ENABLE_FLY_PROVISIONING=true
export FLY_API_TOKEN="$(flyctl tokens create org personal --name agentpod-verify --expiry 24h)"
export FLY_ORG_SLUG=personal
export FLY_REGION=sin
export FLY_VOLUME_SIZE_GB=3
export NODE_AGENT_OPENCODE_IMAGE=ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22
export PROVISIONING_HUB_URL=https://hub.agentpod.dev   # must be reachable FROM Fly
cd apps/hub && bun run dev
```

Confirm in the log: `Provisioners registered: docker, fly` (or whatever set you enabled — `fly` must be in it).

Then deliberately break it once: restart with `FLY_API_TOKEN=""` and confirm the boot fails with `❌ CONFIGURATION VALIDATION FAILED` naming `FLY_API_TOKEN`. Restore the token.

- [ ] **Step 2: Provision, and watch it adopt**

In the console: **New runtime** → provider **Fly** → harness **OpenCode** → tier **small** → Create.

```bash
flyctl apps list | grep agentpod-           # the app exists
APP=agentpod-rt-<the id from the console>
flyctl volumes list -a "$APP"               # one volume, 3GB, in sin
flyctl machines list -a "$APP"              # one machine, state started
flyctl logs -a "$APP" | head -30            # "[fly] workspace and home anchored on /data"
```

Confirm in the console, within a minute or so: the runtime goes `provisioning` → `online`, a node appears, and a station is auto-adopted. **Record the node id** — Step 4 checks it is the same one.

- [ ] **Step 3: Write a sentinel into the workspace**

Open the station's terminal in the console and run:

```bash
date -u +%FT%TZ | tee /workspace/FLY-SENTINEL.txt
ls -la /workspace          # a symlink target under /data
readlink /workspace        # /data/workspace
echo "$HOME"               # /data/home
ls -la "$HOME/.config/agentpod-node/config.json"
```

All four must be as shown. If `/workspace` is a real directory rather than a symlink, stop — the wrapper did not run and the next step will destroy the file.

- [ ] **Step 4: Stop, start, and confirm the workspace and the identity survived**

This is the measurement the whole plan is built on. Cloudflare failed exactly here.

In the console: **Stop** the runtime. Confirm it goes `stopping` → `stopped` (the sweeper confirms within about 15 seconds), and:

```bash
flyctl machines list -a "$APP"      # state: stopped
```

Then **Start** it. Confirm:

```bash
flyctl machines list -a "$APP"      # state: started, SAME machine id
flyctl volumes list -a "$APP"       # SAME volume id
```

And in the station terminal, once it is back online:

```bash
cat /workspace/FLY-SENTINEL.txt     # the timestamp from Step 3 — NOT empty, NOT missing
```

Confirm in the console that the runtime is `online` again and the **node id is the one recorded in Step 2** — the config on the volume kept the identity, so the station did not come back as a stranger.

If the sentinel is missing, **stop and do not proceed**: `workspaceStorage: "volume"` is not being honoured, and shipping that repeats the incident this substrate was chosen to avoid.

- [ ] **Step 5: Confirm nothing reaps it while idle**

Leave the station online and untouched for **20 minutes** — no terminal, no console interaction. Then:

```bash
flyctl machines list -a "$APP"      # still `started`
```

Cloudflare killed a station at 15 minutes. A `started` machine here confirms the no-`services` decision holds in the deployed shape, not only in the probe.

- [ ] **Step 6: Destroy, and prove nothing is left billing**

In the console: **Destroy** the runtime. Then:

```bash
flyctl apps list | grep "$APP" || echo "app gone"
flyctl volumes list -a "$APP" 2>&1 | head -3   # expect an error: the app no longer exists
```

Then destroy it a second time from the console (or re-issue the destroy) and confirm the hub does **not** 502 — that is conformance rule 6 in the real world.

Finally, the money check:

```bash
flyctl apps list
```

**Nothing prefixed `agentpod-` may remain.** A leaked app with a volume bills every month. If anything is left: `flyctl apps destroy <app> --yes`.

Revoke the verification token: `flyctl tokens list` then `flyctl tokens revoke <id>`.

- [ ] **Step 7: Run every suite one last time**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd ../node-agent && go test -race ./...
sh ../../fly/node-image/test-volume-workspace.sh
cd ../console && pnpm check && pnpm test && PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build
```

Console tests need **Node 22**, not 26 (jsdom 25 leaves `window.localStorage` undefined → 125 unrelated failures).

- [ ] **Step 8: Record the verification**

Append the observed values — machine id preserved across stop/start, sentinel contents recovered, node id unchanged, idle duration survived, `flyctl apps list` empty afterwards — to the PR description. The manifest claims these; this is the evidence.

- [ ] **Step 9: Commit anything the verification changed**

```bash
git add -A
git commit -m "fix(provisioner): <whatever the live run turned up>"
```

If nothing changed, skip this step rather than making an empty commit.

---

## Self-Review

**1. Spec coverage.** Checked against `docs/superpowers/specs/2026-08-12-provisioner-registry-design.md` §"Sequencing" step 2, which is what this plan implements:

| Spec requirement | Task |
|---|---|
| Volume-anchored workspace | 4 (mounts + HOME), 11 (the wrapper that uses them), 13 Step 4 (proof) |
| No `services` block | 4 Step 1 (test), 4 Step 6 (non-vacuity), 13 Step 5 (live) |
| Hub-driven stop/start | 3 (`idleBehaviour: "hub-driven"`), 5, 6 |
| `status` via `wait?state=` plus a confirming read | 5 (wait), 6 (wait), 7 (the confirming read) |
| Fly honours image and tier per instance | 3 (manifest), 4 (guest map + image passthrough) |
| Do not bet a workspace on `persist_rootfs` | Global Constraints, 4 Step 1 (test), 11 (README) |
| App-scoped tokens, expiry set explicitly | 12 (both docs) |
| Credentials behind `CredentialResolver`, missing key refuses registration | 3 (`requireCredentials`), 10 (boot validation) |
| Conformance suite gates the driver | 9 |
| Empirical probes settle `workspaceStorage` and `idleBehaviour` | Global Constraints carries the measurements; 13 re-confirms both in the deployed shape |

Two things the plan adds beyond the spec, both because the shipped code demanded them: the rate pacer (Task 2 — the spec notes the limit but nothing was built for it) and the app-per-runtime cleanup on a failed machine create (Task 4 — an orphan bills).

Gaps accepted deliberately: **no Modal driver** (a separate plan, per the spec's sequencing) and **no harness other than OpenCode** in the image (the Docker fleet's `pi` image has no Fly equivalent yet; adding one is a Dockerfile, not a design question, and it is out of this plan's scope).

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no test described without its code. The two deliberately-throwing stubs in Task 3 (`provision`/`destroy`/`start`/`stop`/`status`) are flagged as such in the task text and replaced by name in Tasks 4–8. Task 1 contains one genuine unknown — which auth scheme Fly accepts — and resolves it with a measurement plus a written decision rule for all three possible outcomes rather than leaving it to the implementer's judgement.

**3. Type consistency.** Checked across tasks:

- `FLY_VOLUME_MOUNT = "/data"` (Task 3) is what `createMachine` mounts (Task 4), what `volume-workspace.sh` defaults `AGENTPOD_VOLUME_PATH` to (Task 11), and what Task 13 Step 3 asserts.
- `HOME = "${FLY_VOLUME_MOUNT}/home"` (Task 4) matches `mkdir -p "$MOUNT/home"` and `HOME="$MOUNT/home"` (Task 11).
- `formatFlyExternalId` / `parseFlyExternalId` (Task 3) are used by `provision` (4), `start` (5), `stop` (6), `status` (7) and `destroy` (8) under those exact names.
- `FlyRequest`'s return `{ status, body }` (Task 1) is destructured as `{ body }` in Tasks 4, 6 and 7.
- `Pacer` / `noPacer` / `createFlyPacer` (Tasks 1–2) are used as `pacer: noPacer` in every test in Tasks 3–9.
- `createFlyFakeSubstrate` returns `{ fetchImpl, calls, apps }` (Task 4) and Task 9 uses `.fetchImpl`; Task 4's tests use all three.
- `config.fly` (Task 10) is read by `collectConfigErrors` as `cfg.fly.enabled` / `.apiToken` / `.volumeSizeGb`, which is what its test overrides.
- `flyStateToRuntimeState` returns `RuntimeState` from `./types`, the same union `status()` declares.
