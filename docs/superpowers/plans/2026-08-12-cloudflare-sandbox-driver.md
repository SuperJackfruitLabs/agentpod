# Cloudflare Sandbox Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second substrate — provision a station on Cloudflare from the console, and have it enrol, stay up, and survive a restart as the same node.

**Architecture:** A new worker on `@cloudflare/containers` runs an image carrying a released `agentpod-node`, kept alive by overriding `onActivityExpired()` without stopping. A new hub driver talks to it over a small REST surface and validates every response. Identity across restarts is already solved by runtime-bound re-enrolment (merged in #245).

**Tech Stack:** `@cloudflare/containers` + `wrangler` (worker), Bun + Hono + Drizzle (hub driver), Docker (image build via wrangler).

**Spec:** `docs/superpowers/specs/2026-08-12-cloudflare-sandbox-driver-design.md`
**Spike evidence:** `docs/superpowers/specs/2026-08-12-cloudflare-sandbox-spike-findings.md`

## Global Constraints

- **Always-on, not scale-to-zero.** Containers keep themselves alive by overriding `onActivityExpired()` and declining to stop. Sleep/wake as a station state is explicitly out of scope.
- **Validate every worker response.** The dead driver's failure was an `ASSUMPTION` comment about the worker contract that nobody checked. Parse and reject, never trust.
- **Reject a mismatched image, never ignore it.** Cloudflare bakes the image at deploy time, so `ProvisionSpec.image` cannot be honoured; silently ignoring an input is how the old driver would have failed.
- **The image pulls a released binary and verifies it against `SHA256SUMS`** — the same artefacts `install.sh` and self-update use. Do not vendor a hand-built binary.
- **Do not delete the dead worker or driver.** They stay marked until this replaces them in production.
- Cost, for anyone reviewing the default: ~$28/month per always-on 4 GiB station, ~$1,090 across 39. This is a burst-and-geography substrate, not the default.
- Branch: `cloudflare-sandbox-driver` off `main`. Single PR.
- TDD: every task writes its failing test first.

## Prerequisites, already satisfied

- **Runtime identity persistence is merged** (#245) and deployed. A runtime-bound token re-presented after a restart returns the same `nodeId`. Without it this driver produces stations that vanish on first eviction.
- **`cloudflare` is already a known provider** in `RuntimeProviderName` and the registry, gated by `ENABLE_CLOUDFLARE_SANDBOXES`. No registry work is needed.
- **`wrangler` is authenticated** with `containers (write)` and `cloudchamber (write)` on the account for `rakesh.gangwar1994@gmail.com`.

## What the spike already proved — do not re-litigate

A real Cloudflare container running `agentpod-node` against the production hub:
enrolled in ~20s (`hostname=cloudchamber`), stayed online 9 minutes at
`sleepAfter="2m"`, and `onActivityExpired()` fired with the override renewing the
timer as documented. `stop` then `start` restarted it reliably. Identity did not
survive — which is what #245 fixed.

## File Structure

**`cloudflare/worker-v2/`** *(new — alongside the dead `cloudflare/worker/`)*
- `wrangler.toml` — container binding, DO migration, instance type.
- `Dockerfile` — released `agentpod-node` on a slim base, checksum-verified.
- `src/index.ts` — `NodeAgentContainer` + the REST surface.
- `src/auth.ts` — bearer check, one responsibility so it is testable alone.
- `test/worker.test.ts` — routing and auth.
- `package.json`, `vitest.config.ts`, `README.md`.

**`apps/hub`**
- `src/services/provisioner/cloudflare-sandbox.ts` *(create)* — the new driver.
- `src/services/provisioner/cloudflare-sandbox.test.ts` *(create)*.
- `src/services/provisioner/bootstrap.ts` *(modify)* — register the new driver.

---

## Task 1: Worker scaffold, image, and container class

**Files:**
- Create: `cloudflare/worker-v2/{wrangler.toml,Dockerfile,package.json,README.md}`
- Create: `cloudflare/worker-v2/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a deployable worker exposing `GET /health`, `POST /sandbox`, `GET /sandbox/:id`, `DELETE /sandbox/:id`, `POST /sandbox/:id/start`, `POST /sandbox/:id/stop`; class `NodeAgentContainer`.

- [ ] **Step 1: Create the image**

Create `cloudflare/worker-v2/Dockerfile`. It pulls a **released** binary and verifies it, rather than vendoring a hand-built one — the same artefacts `install.sh` and self-update consume, so a Cloudflare station runs exactly the binary the fleet runs.

```dockerfile
FROM debian:bookworm-slim

# Pin explicitly. A floating "latest" would make two deploys of the same worker
# produce different fleet behaviour, which is exactly the kind of drift the
# release pipeline exists to prevent.
ARG AGENTPOD_VERSION=v0.1.22

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Verify against SHA256SUMS, as install.sh and self-update do. An unverified
# binary here would be a supply-chain hole in the substrate itself.
RUN set -eux; \
    base="https://github.com/rakeshgangwar/agentpod/releases/download/${AGENTPOD_VERSION}"; \
    curl -fsSL -o /usr/local/bin/agentpod-node "${base}/agentpod-node-linux-amd64"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    cd /usr/local/bin; \
    cp agentpod-node agentpod-node-linux-amd64; \
    grep ' agentpod-node-linux-amd64$' /tmp/SHA256SUMS | sha256sum -c -; \
    rm -f agentpod-node-linux-amd64 /tmp/SHA256SUMS; \
    chmod +x /usr/local/bin/agentpod-node; \
    /usr/local/bin/agentpod-node version

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

Create `cloudflare/worker-v2/entrypoint.sh`. It mirrors `apps/node-agent/deploy/node-entrypoint.sh`; the difference is that on this substrate the enrol path runs on **every** start, because the disk is fresh each time.

```sh
#!/bin/sh
set -e

# Enroll reads AGENTPOD_HUB_URL and AGENTPOD_ENROLL_TOKEN from the environment.
#
# On an ephemeral-disk substrate this runs on every start, not just the first.
# The hub returns the SAME node for a runtime-bound token whose runtime already
# has one (runtime identity persistence, #245), so a restart resumes rather than
# orphaning. Without that this loop would mint a new node every restart.
/usr/local/bin/agentpod-node enroll

exec /usr/local/bin/agentpod-node run
```

- [ ] **Step 2: Create the worker config**

Create `cloudflare/worker-v2/wrangler.toml`:

```toml
name = "agentpod-sandbox-v2"
main = "src/index.ts"
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true

[[durable_objects.bindings]]
name = "NODE_AGENT"
class_name = "NodeAgentContainer"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["NodeAgentContainer"]

[[containers]]
class_name = "NodeAgentContainer"
image = "./Dockerfile"
# 4 GiB. A live opencode runtime OOM-killed its ACP session at 513MB rss, and
# the Docker "small" tier had to go to 1g for `opencode serve` plus one
# `opencode acp` to coexist; standard-1 leaves real headroom.
instance_type = "standard-1"
max_instances = 20
```

Create `cloudflare/worker-v2/package.json`:

```json
{
  "name": "agentpod-sandbox-v2",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "tail": "wrangler tail --format pretty"
  },
  "dependencies": { "@cloudflare/containers": "^0.3.7" },
  "devDependencies": {
    "wrangler": "^4.121.0",
    "vitest": "^2.1.9",
    "@cloudflare/vitest-pool-workers": "^0.5.40"
  }
}
```

- [ ] **Step 3: Write the auth helper**

Create `cloudflare/worker-v2/src/auth.ts`. Separate from routing so it can be tested alone and so a route cannot accidentally skip it.

```ts
/**
 * Bearer-token check for every route except /health.
 *
 * The worker can start containers that enrol into a fleet, so an unauthenticated
 * caller could mint stations. /health is exempt so the driver can fail fast on a
 * misconfigured URL without holding a credential.
 */
export function isAuthorised(request: Request, expected: string | undefined): boolean {
  if (!expected) return false; // no secret configured → refuse everything
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

/** Constant-time compare, so a wrong token cannot be guessed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 4: Write the worker**

Create `cloudflare/worker-v2/src/index.ts`:

```ts
import { Container, getContainer } from "@cloudflare/containers";
import { isAuthorised } from "./auth";

interface Env {
  NODE_AGENT: DurableObjectNamespace;
  AGENTPOD_WORKER_TOKEN?: string;
}

/**
 * A station on Cloudflare: a container running agentpod-node, which dials the
 * hub OUTBOUND over WSS and receives no incoming requests at all.
 *
 * That is why onActivityExpired is overridden. Cloudflare's activity timer is
 * driven by *incoming* requests (cloudflare/containers#147), so a node-agent
 * generates no activity however busy it is. Declining to stop renews the timer,
 * which the spike confirmed keeps a station alive indefinitely.
 */
export class NodeAgentContainer extends Container {
  sleepAfter = "30m";

  override async onStart() {
    console.log("[agentpod] container started", new Date().toISOString());
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }) {
    console.log("[agentpod] container stopped", { exitCode, reason });
  }

  /**
   * Deliberately does NOT call this.stop().
   *
   * A station is long-lived and connection-oriented; sleeping would drop its
   * WSS connection and take it offline. Scale-to-zero is a cost optimisation
   * that needs "asleep" as a distinct station state, and is out of scope here.
   */
  override async onActivityExpired() {
    console.log("[agentpod] activity expired — staying alive (station is long-lived)");
  }
}

interface CreateBody {
  id: string;
  hubUrl: string;
  enrollToken: string;
}

const json = (body: unknown, status = 200) =>
  Response.json(body as Record<string, unknown>, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Liveness, unauthenticated on purpose: the driver checks it to fail fast
    // on a misconfigured URL before it holds a credential.
    if (request.method === "GET" && parts[0] === "health") {
      return json({ status: "ok" });
    }

    if (!isAuthorised(request, env.AGENTPOD_WORKER_TOKEN)) {
      return json({ error: "unauthorized" }, 401);
    }

    if (parts[0] !== "sandbox") return json({ error: "not found" }, 404);

    // POST /sandbox — start a station.
    if (request.method === "POST" && !parts[1]) {
      let body: CreateBody;
      try {
        body = (await request.json()) as CreateBody;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      if (!body.id || !body.hubUrl || !body.enrollToken) {
        return json({ error: "id, hubUrl and enrollToken are required" }, 400);
      }

      const c = getContainer(env.NODE_AGENT, body.id) as unknown as {
        start: (o?: { envVars?: Record<string, string> }) => Promise<void>;
      };
      // The token is passed through but never logged, here or anywhere in this
      // worker. Do not add log statements that reference body.enrollToken.
      await c.start({
        envVars: {
          AGENTPOD_HUB_URL: body.hubUrl,
          AGENTPOD_ENROLL_TOKEN: body.enrollToken,
        },
      });
      return json({ sandboxId: body.id }, 201);
    }

    const id = parts[1];
    if (!id) return json({ error: "not found" }, 404);

    const container = getContainer(env.NODE_AGENT, id) as unknown as {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      destroy: () => Promise<void>;
    };

    if (request.method === "GET" && !parts[2]) {
      return json({ sandboxId: id });
    }

    if (request.method === "DELETE" && !parts[2]) {
      await container.destroy();
      return json({ destroyed: id });
    }

    if (request.method === "POST" && parts[2] === "start") {
      await container.start();
      return json({ started: id });
    }

    if (request.method === "POST" && parts[2] === "stop") {
      await container.stop();
      return json({ stopped: id });
    }

    return json({ error: "not found" }, 404);
  },
};
```

- [ ] **Step 5: Install and typecheck**

```bash
cd cloudflare/worker-v2 && npm install && npx tsc --noEmit -p . 2>&1 | tail -5 || true
```

Expected: dependencies install. If there is no `tsconfig.json`, create one matching `cloudflare/worker/tsconfig.json` — read that file and copy it, changing only paths.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/worker-v2
git commit -m "feat(cloudflare): worker-v2 scaffold, image and container class"
```

---

## Task 2: Worker tests

**Files:**
- Create: `cloudflare/worker-v2/vitest.config.ts`
- Create: `cloudflare/worker-v2/test/worker.test.ts`

**Interfaces:**
- Consumes: `isAuthorised` and the default export from Task 1.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Create `cloudflare/worker-v2/test/worker.test.ts`. These test the auth helper and routing as pure units — container lifecycle needs a real platform and is covered by the live verification in Task 5.

```ts
import { describe, it, expect } from "vitest";
import { isAuthorised } from "../src/auth";

const req = (token?: string) =>
  new Request("https://w.example/sandbox", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

describe("isAuthorised", () => {
  it("refuses everything when no secret is configured", () => {
    // A worker deployed without its secret must not be open. Failing closed
    // matters more here than anywhere: this endpoint starts containers that
    // enrol into the fleet.
    expect(isAuthorised(req("anything"), undefined)).toBe(false);
    expect(isAuthorised(req("anything"), "")).toBe(false);
  });

  it("accepts the right token and rejects a wrong one", () => {
    expect(isAuthorised(req("s3cret"), "s3cret")).toBe(true);
    expect(isAuthorised(req("wrong"), "s3cret")).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(isAuthorised(req(), "s3cret")).toBe(false);
    expect(
      isAuthorised(
        new Request("https://w.example/sandbox", { headers: { Authorization: "s3cret" } }),
        "s3cret"
      )
    ).toBe(false);
  });

  it("rejects a token of a different length without comparing content", () => {
    expect(isAuthorised(req("s3cre"), "s3cret")).toBe(false);
    expect(isAuthorised(req("s3crett"), "s3cret")).toBe(false);
  });
});
```

Create `cloudflare/worker-v2/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Run them**

```bash
cd cloudflare/worker-v2 && npm test 2>&1 | tail -6
```

Expected: PASS. These describe behaviour Task 1 already implemented; they exist so a later edit cannot quietly open the endpoint.

- [ ] **Step 3: Commit**

```bash
git add cloudflare/worker-v2
git commit -m "test(cloudflare): worker auth is closed by default"
```

---

## Task 3: The hub driver

**Files:**
- Create: `apps/hub/src/services/provisioner/cloudflare-sandbox.ts`
- Create: `apps/hub/src/services/provisioner/cloudflare-sandbox.test.ts`

**Interfaces:**
- Consumes: `RuntimeProvisioner`, `ProvisionSpec` from `./types`.
- Produces: `class CloudflareSandboxProvisioner implements RuntimeProvisioner` with `provider = "cloudflare"`, constructor options `{ workerUrl?, apiToken?, deployedImage?, fetchImpl? }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/hub/src/services/provisioner/cloudflare-sandbox.test.ts`. Model the fake-fetch pattern on the existing `cloudflare.test.ts` — read it first.

```ts
/**
 * Unit tests: CloudflareSandboxProvisioner.
 *
 * No real Cloudflare. A fake fetch captures requests and returns controlled
 * responses — including malformed ones, which is the case the dead driver
 * would have accepted.
 */

import { describe, it, expect } from "bun:test";
import { CloudflareSandboxProvisioner } from "./cloudflare-sandbox";
import type { ProvisionSpec } from "./types";

const IMAGE = "agentpod-node-opencode:v0.1.22";

const SPEC: ProvisionSpec = {
  runtimeId: "rt_abc",
  name: "test",
  resourceTier: "small",
  hubUrl: "https://hub.example",
  enrollToken: "enr_secret",
  image: IMAGE,
};

function fakeFetch(response: unknown, status = 201) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const make = (impl: typeof globalThis.fetch) =>
  new CloudflareSandboxProvisioner({
    workerUrl: "https://w.example",
    apiToken: "tok",
    deployedImage: IMAGE,
    fetchImpl: impl,
  });

describe("CloudflareSandboxProvisioner", () => {
  it("provisions and returns the worker's sandbox id", async () => {
    const { impl, calls } = fakeFetch({ sandboxId: "rt_abc" });
    const res = await make(impl).provision(SPEC);

    expect(res.externalId).toBe("rt_abc");
    expect(calls[0]!.url).toBe("https://w.example/sandbox");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("reports its runtime so the console can show real isolation", async () => {
    const { impl } = fakeFetch({ sandboxId: "rt_abc" });
    const res = await make(impl).provision(SPEC);
    expect(res.runtime).toBe("cloudflare-container");
  });

  it("sends the hub url and enrolment token", async () => {
    const { impl, calls } = fakeFetch({ sandboxId: "rt_abc" });
    await make(impl).provision(SPEC);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.hubUrl).toBe(SPEC.hubUrl);
    expect(body.enrollToken).toBe(SPEC.enrollToken);
    expect(body.id).toBe(SPEC.runtimeId);
  });

  it("authenticates with a bearer token", async () => {
    const { impl, calls } = fakeFetch({ sandboxId: "rt_abc" });
    await make(impl).provision(SPEC);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("REJECTS a response that does not match the expected shape", async () => {
    // The dead driver's exact failure: it assumed the worker's contract and
    // never checked, so a 2xx with the wrong body produced a runtime that sat
    // in `provisioning` forever with no error anywhere.
    const { impl } = fakeFetch({ nope: true });
    await expect(make(impl).provision(SPEC)).rejects.toThrow(/unexpected response/i);
  });

  it("rejects a non-2xx response", async () => {
    const { impl } = fakeFetch({ error: "boom" }, 500);
    await expect(make(impl).provision(SPEC)).rejects.toThrow(/500/);
  });

  it("REJECTS a spec whose image is not the deployed one", async () => {
    // Cloudflare bakes the image at deploy time, so ProvisionSpec.image cannot
    // be honoured. Silently ignoring an input is how the old driver failed —
    // refuse loudly instead.
    const { impl } = fakeFetch({ sandboxId: "rt_abc" });
    await expect(
      make(impl).provision({ ...SPEC, image: "something-else:latest" })
    ).rejects.toThrow(/image/i);
  });

  it("destroys by sandbox id", async () => {
    const { impl, calls } = fakeFetch({ destroyed: "rt_abc" }, 200);
    await make(impl).destroy("rt_abc");
    expect(calls[0]!.url).toBe("https://w.example/sandbox/rt_abc");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("maps start and stop to the lifecycle routes", async () => {
    const started = fakeFetch({ started: "rt_abc" }, 200);
    await make(started.impl).start!("rt_abc");
    expect(started.calls[0]!.url).toBe("https://w.example/sandbox/rt_abc/start");

    const stopped = fakeFetch({ stopped: "rt_abc" }, 200);
    await make(stopped.impl).stop!("rt_abc");
    expect(stopped.calls[0]!.url).toBe("https://w.example/sandbox/rt_abc/stop");
  });

  it("fails clearly when the worker url is not configured", async () => {
    const p = new CloudflareSandboxProvisioner({ workerUrl: "", apiToken: "tok" });
    await expect(p.provision(SPEC)).rejects.toThrow(/CLOUDFLARE_WORKER_URL/);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/cloudflare-sandbox.test.ts
```

Expected: FAIL — `Cannot find module './cloudflare-sandbox'`.

- [ ] **Step 3: Write the driver**

Create `apps/hub/src/services/provisioner/cloudflare-sandbox.ts`:

```ts
/**
 * Cloudflare Sandbox provisioner driver.
 *
 * Talks to `cloudflare/worker-v2/`, which runs a container carrying a released
 * agentpod-node. The container dials the hub outbound and enrols itself, so this
 * driver's only job is lifecycle.
 *
 * Replaces the dead OpenCode-era driver in `cloudflare.ts`. The lesson carried
 * over from it: **every response is validated**. That driver documented an
 * ASSUMPTION about the worker's contract and never checked it, so a 2xx with the
 * wrong body would have produced a runtime stuck in `provisioning` with no error
 * logged anywhere.
 *
 * SECURITY: the enrolment token is sent in the request body and is never logged
 * by this module. Do not add log statements that reference spec.enrollToken.
 */

import type { RuntimeProvisioner, ProvisionSpec } from "./types";

export interface CloudflareSandboxOptions {
  workerUrl?: string;
  apiToken?: string;
  /**
   * The image the worker was deployed with. Cloudflare bakes it at deploy time,
   * so a spec asking for anything else cannot be satisfied and is refused.
   */
  deployedImage?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export class CloudflareSandboxProvisioner implements RuntimeProvisioner {
  readonly provider = "cloudflare" as const;

  private readonly workerUrl: string;
  private readonly apiToken: string;
  private readonly deployedImage: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor({
    workerUrl = process.env.CLOUDFLARE_WORKER_URL ?? "",
    apiToken = process.env.CLOUDFLARE_WORKER_TOKEN ?? "",
    deployedImage = process.env.CLOUDFLARE_SANDBOX_IMAGE ?? "",
    fetchImpl = globalThis.fetch,
  }: CloudflareSandboxOptions = {}) {
    this.workerUrl = workerUrl.replace(/\/$/, "");
    this.apiToken = apiToken;
    this.deployedImage = deployedImage;
    this.fetchImpl = fetchImpl;
  }

  private async call(
    path: string,
    init: RequestInit
  ): Promise<Record<string, unknown>> {
    if (!this.workerUrl) {
      throw new Error(
        "cloudflare: CLOUDFLARE_WORKER_URL is not set; cannot reach the sandbox worker"
      );
    }

    const res = await this.fetchImpl(`${this.workerUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      throw new Error(`cloudflare: worker returned ${res.status} for ${path}`);
    }

    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`cloudflare: unexpected response from ${path} (not JSON)`);
    }
  }

  async provision(
    spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    // Cloudflare bakes the image at worker deploy time. Honour-or-refuse, never
    // ignore: a driver that quietly drops an input is how the previous one would
    // have failed.
    if (this.deployedImage && spec.image !== this.deployedImage) {
      throw new Error(
        `cloudflare: this worker is deployed with image "${this.deployedImage}" and ` +
          `cannot provision "${spec.image}". Cloudflare bakes the image at deploy ` +
          `time; redeploy the worker to change it.`
      );
    }

    const body = await this.call("/sandbox", {
      method: "POST",
      body: JSON.stringify({
        id: spec.runtimeId,
        hubUrl: spec.hubUrl,
        enrollToken: spec.enrollToken,
      }),
    });

    const sandboxId = body.sandboxId;
    if (typeof sandboxId !== "string" || !sandboxId) {
      throw new Error(
        "cloudflare: unexpected response from /sandbox (no sandboxId)"
      );
    }

    return { externalId: sandboxId, runtime: "cloudflare-container" };
  }

  async destroy(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}`, { method: "DELETE" });
  }

  async start(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}/start`, { method: "POST" });
  }

  async stop(externalId: string): Promise<void> {
    await this.call(`/sandbox/${externalId}/stop`, { method: "POST" });
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/
```

Expected: PASS, including the dead driver's own tests, which are untouched.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/cloudflare-sandbox.ts apps/hub/src/services/provisioner/cloudflare-sandbox.test.ts
git commit -m "feat(hub): CloudflareSandboxProvisioner, validating every response"
```

---

## Task 4: Register the new driver

**Files:**
- Modify: `apps/hub/src/services/provisioner/bootstrap.ts`
- Modify: `apps/hub/src/services/provisioner/cloudflare.ts` (header note only)

**Interfaces:**
- Consumes: `CloudflareSandboxProvisioner` from Task 3.
- Produces: `registerEnabledProvisioners()` registers the new driver for `cloudflare`.

- [ ] **Step 1: Swap the registration**

In `apps/hub/src/services/provisioner/bootstrap.ts`, replace the Cloudflare import and registration:

```ts
import { CloudflareSandboxProvisioner } from "./cloudflare-sandbox";
```

```ts
  if (isProviderEnabled("cloudflare")) {
    registerProvisioner(new CloudflareSandboxProvisioner());
  }
```

Remove the now-unused `CloudflareRuntimeProvisioner` import.

- [ ] **Step 2: Note the supersession on the dead driver**

Add one line to the top of the DEAD block in `apps/hub/src/services/provisioner/cloudflare.ts`, so a reader knows where the live code is:

```
 * SUPERSEDED by ./cloudflare-sandbox.ts, which is what the registry now wires.
```

- [ ] **Step 3: Run the hub suite**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS. The dead driver's unit tests still pass — they construct it directly and do not go through the registry.

- [ ] **Step 4: Commit**

```bash
git add apps/hub/src/services/provisioner
git commit -m "feat(hub): register CloudflareSandboxProvisioner for the cloudflare provider"
```

---

## Task 5: Deploy, verify live, and PR

This is where the work is proven. Every substrate this session has surprised us in production after passing tests.

- [ ] **Step 1: Run every suite**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd ../node-agent && go vet ./... && go test -race ./...
cd ../console && pnpm check && pnpm test && pnpm build
cd ../../cloudflare/worker-v2 && npm test
```

Expected: all green.

- [ ] **Step 2: Deploy the worker**

```bash
cd cloudflare/worker-v2 && npx wrangler deploy
```

Note the deployed URL. Then set its secret:

```bash
cd cloudflare/worker-v2 && npx wrangler secret put AGENTPOD_WORKER_TOKEN
```

Use a fresh random value (`openssl rand -hex 32`). Confirm liveness:

```bash
curl -s https://<worker-url>/health
curl -s -o /dev/null -w "%{http_code}\n" https://<worker-url>/sandbox -X POST
```

Expected: `{"status":"ok"}` then `401` — the endpoint that starts containers must refuse an unauthenticated caller.

- [ ] **Step 3: Configure and deploy the hub**

Add to `/etc/agentpod/hub.env` on `178.105.68.68`:

```
ENABLE_CLOUDFLARE_SANDBOXES=true
CLOUDFLARE_WORKER_URL=https://<worker-url>
CLOUDFLARE_WORKER_TOKEN=<the secret from step 2>
CLOUDFLARE_SANDBOX_IMAGE=<the image string imageForHarness returns for the harness you will test>
```

Read `imageForHarness` in `apps/hub/src/services/runtimes.ts` to get the exact value — a mismatch is refused by design, so this must be right.

Deploy the branch and restart, then confirm the provider is live:

```bash
ssh root@178.105.68.68 'journalctl -u agentpod-hub --since "1 minute ago" --no-pager | grep -o "Provisioners registered: .*"'
```

Expected: `docker, cloudflare`.

- [ ] **Step 4: Provision through the real path**

Provision a Cloudflare runtime via `createRuntime` on the hub — not by hand, and not by calling the worker directly. Confirm:

- the runtime row reaches `status=online` with `runtime=cloudflare-container`
- a node exists with `hostname=cloudchamber` and a recent `lastSeenAt`

- [ ] **Step 5: Verify the restart — the point of the whole slice**

Stop and start the container through the worker, then confirm the runtime **still points at the same `nodeId`** and the node returns online.

This is the acceptance test. It exercises runtime identity persistence (#245) on the substrate that needs it, and a failure here means the driver is not done however green the unit tests are.

- [ ] **Step 6: Clean up**

Destroy the test runtime through `destroyRuntime` so the destroy path is exercised too, and confirm the container is gone from Cloudflare.

- [ ] **Step 7: Open the PR**

```bash
git push -u origin cloudflare-sandbox-driver
gh pr create --title "feat: Cloudflare sandbox provider" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-12-cloudflare-sandbox-driver-design.md` —
a second substrate, replacing the dead OpenCode-era worker and driver.

A new worker on `@cloudflare/containers` runs an image carrying a **released**
`agentpod-node`, checksum-verified against `SHA256SUMS` like `install.sh` does.
The container dials the hub outbound and enrols itself; the driver only does
lifecycle.

## Always-on, deliberately

Containers stay alive by overriding `onActivityExpired()` without stopping — the
spike confirmed this keeps a station up indefinitely. Cloudflare's activity timer
is driven by *incoming* requests and a node-agent receives none
([cloudflare/containers#147](https://github.com/cloudflare/containers/issues/147)),
so without this a station would sleep and go offline on a timer.

Scale-to-zero needs "asleep" as a distinct station state and is out of scope.
Cost of the choice: ~$28/month per always-on 4 GiB station. **This is a burst and
geography substrate, not the default** — a Hetzner box runs the whole fleet for
about €46/month.

## Two lessons from the dead driver, encoded as tests

**Every response is validated.** The old driver documented an `ASSUMPTION` about
the worker's contract and never checked it, so a 2xx with the wrong body would
have produced a runtime stuck in `provisioning` with no error anywhere. A test
now asserts a malformed response is rejected.

**A mismatched image is refused, not ignored.** Cloudflare bakes the image at
deploy time so `ProvisionSpec.image` cannot be honoured; the driver refuses
loudly rather than silently dropping the input.

## Verified live

Provisioned through `createRuntime`, not by hand: runtime reached
`status=online runtime=cloudflare-container` with a node heartbeating, then
**survived a restart as the same `nodeId`** — which exercises runtime identity
persistence (#245) on the substrate that needs it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EohapceVTgobwUGTQ5LuyW
EOF
)"
```

- [ ] **Step 8: Wait for the four required checks**

```bash
gh pr checks --watch
```
