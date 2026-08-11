# gVisor Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let provisioned Docker runtimes run under gVisor, so a container escape in agent-generated code stops being a hub compromise.

**Architecture:** One hub-level env var (`DOCKER_RUNTIME`) sets `HostConfig.Runtime` on container create. Unset means today's behaviour byte-for-byte. The runtime Docker *actually used* is read back from `inspect` and persisted, so the console shows a fact rather than an intention.

**Tech Stack:** Bun + Hono + Drizzle (hub), dockerode, zod 4 (`packages/contract`), Svelte 5 (console).

**Spec:** `docs/superpowers/specs/2026-08-12-gvisor-runtime-design.md`

## Global Constraints

- **Fail closed, never fall back.** An unavailable runtime fails the provision with an error naming it. Silently using `runc` would leave an operator believing they have kernel isolation while they have none.
- **Record what ran, not what was asked.** The stored value comes from `inspect`, never from config.
- **Unset `DOCKER_RUNTIME` must produce a byte-identical create request to today's.** `HostConfig.Runtime` is *absent from the object*, not `""` or `undefined`-valued.
- **The default does not change.** `runsc` is installed on the hub box; nothing uses it until an operator sets the var.
- Not in scope: remote Docker host, per-user or per-tier runtime choice, any other isolation technology.
- TDD: every task writes its failing test first.
- Branch: `gvisor-runtime` off `main`. Single PR.

## Already done (do not redo)

`runsc` `release-20260803.0` is installed and registered on the hub box (`178.105.68.68`), verified by checksum. `/etc/docker/daemon.json` lists it. `runc` remains Docker's default. The spike that validated the node-agent under it — enrolment, heartbeats, PTY, stdio children, signals — is recorded in the spec's Evidence table.

## File Structure

**`packages/contract`**
- `src/runtime.ts` *(modify)* — `ProvisionedRuntime.runtime`, optional and nullable.

**`apps/hub`**
- `src/services/provisioner/docker-orchestrator.ts` *(modify)* — config field, `HostConfig.Runtime`, observed runtime on `Sandbox`.
- `src/services/provisioner/types.ts` *(modify)* — `provision` returns an optional `runtime`.
- `src/services/provisioner/docker.ts` *(modify)* — read the env var, pass it down, return what was observed.
- `src/db/schema/nodes.ts` *(modify)* — nullable `runtime` column on `provisioned_runtimes`.
- `src/services/runtimes.ts` *(modify)* — persist it, expose it in the DTO.

**`apps/console`**
- `src/lib/api/client.ts` *(modify)* — the field on the runtime row type.
- `src/routes/runtimes/+page.svelte` *(modify)* — show it when present.

**`docs/DEPLOYMENT.md`** *(modify)* — `runsc` install steps.

---

## Task 1: Orchestrator sets and reports the runtime

**Files:**
- Modify: `apps/hub/src/services/provisioner/docker-orchestrator.ts`
- Create: `apps/hub/src/services/provisioner/docker-orchestrator.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DockerOrchestratorConfig.runtime?: string`; `Sandbox.runtime?: string`; `buildContainerOptions` sets `HostConfig.Runtime` when configured.

- [ ] **Step 1: Write the failing test**

There is no existing test file for the orchestrator. Create `apps/hub/src/services/provisioner/docker-orchestrator.test.ts`:

```ts
/**
 * Unit tests: DockerOrchestrator container options.
 *
 * No real Docker daemon. buildContainerOptions is private, so these reach it
 * via a cast — the alternative is exporting a function purely for tests, and
 * the option object is exactly what we need to assert on.
 */

import { describe, it, expect } from "bun:test";
import { DockerOrchestrator } from "./docker-orchestrator";
import type { SandboxConfig } from "./docker-orchestrator";

const CONFIG: SandboxConfig = {
  id: "rt_test",
  name: "test",
  image: "agentpod-node:local",
  env: { AGENTPOD_HUB_URL: "https://hub.example" },
  volumes: [],
  ports: [],
  labels: {},
  resources: { cpus: "1.0", memory: "1g", pidsLimit: 100 },
};

/** buildContainerOptions is private; this is the narrow escape hatch. */
function optionsFor(orch: DockerOrchestrator, cfg: SandboxConfig = CONFIG) {
  return (
    orch as unknown as {
      buildContainerOptions: (c: SandboxConfig, name: string) => Record<string, any>;
    }
  ).buildContainerOptions(cfg, "agentpod-rt_test");
}

describe("DockerOrchestrator container options", () => {
  it("omits HostConfig.Runtime entirely when no runtime is configured", () => {
    // Not "" and not undefined-valued — ABSENT. An unconfigured hub must send
    // exactly the request it sends today, so this change cannot alter the
    // default path even subtly.
    const opts = optionsFor(new DockerOrchestrator());
    expect("Runtime" in opts.HostConfig).toBe(false);
  });

  it("sets HostConfig.Runtime when one is configured", () => {
    const opts = optionsFor(new DockerOrchestrator({ runtime: "runsc" }));
    expect(opts.HostConfig.Runtime).toBe("runsc");
  });

  it("leaves the rest of HostConfig untouched when a runtime is set", () => {
    // The runtime is an addition, not a replacement: resource limits and the
    // tini init that stops zombie stations must survive it.
    const plain = optionsFor(new DockerOrchestrator());
    const withRt = optionsFor(new DockerOrchestrator({ runtime: "runsc" }));

    expect(withRt.HostConfig.Init).toBe(plain.HostConfig.Init);
    expect(withRt.HostConfig.NanoCpus).toBe(plain.HostConfig.NanoCpus);
    expect(withRt.HostConfig.Memory).toBe(plain.HostConfig.Memory);
    expect(withRt.HostConfig.RestartPolicy).toEqual(plain.HostConfig.RestartPolicy);
  });

  it("keeps the image and labels identical", () => {
    const withRt = optionsFor(new DockerOrchestrator({ runtime: "runsc" }));
    expect(withRt.Image).toBe(CONFIG.image);
    expect(withRt.Labels["agentpod.managed"]).toBe("true");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/docker-orchestrator.test.ts
```

Expected: the "sets HostConfig.Runtime" case FAILS (`undefined`), because `runtime` is not a config field yet. The "omits" case passes already — that is the point of writing it: it proves the default path before and after.

- [ ] **Step 3: Add the config field**

In `apps/hub/src/services/provisioner/docker-orchestrator.ts`, add to `DockerOrchestratorConfig`:

```ts
  /**
   * Container runtime name, e.g. "runsc" for gVisor. Omitted means Docker's
   * default (runc) and a create request byte-identical to before this existed.
   */
  runtime?: string;
```

and to `DEFAULT_CONFIG`:

```ts
  runtime: "",
```

- [ ] **Step 4: Set it on create**

Still in `docker-orchestrator.ts`, inside `buildContainerOptions`, add the runtime to `HostConfig` only when non-empty. Find the `HostConfig: {` block and add immediately after `Init: true,`:

```ts
        // Only present when configured: an unset runtime must produce the same
        // request Docker received before this option existed.
        ...(this.config.runtime ? { Runtime: this.config.runtime } : {}),
```

- [ ] **Step 5: Report what Docker actually used**

Add to the `Sandbox` interface:

```ts
  /**
   * The runtime Docker reports for this container, read back from inspect.
   *
   * Deliberately the observed value rather than the requested one: "we asked
   * for runsc" is a hope, "Docker says this is running under runsc" is a fact,
   * and the gap between them is exactly what this field exists to expose.
   */
  runtime?: string;
```

Then find `containerInfoToSandbox` and populate it from the inspect result. The inspect payload exposes it at `HostConfig.Runtime`:

```ts
      runtime: info.HostConfig?.Runtime || undefined,
```

Read the existing body of `containerInfoToSandbox` first and add the field alongside the others rather than restructuring it.

- [ ] **Step 6: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/
```

Expected: PASS, including the pre-existing `docker.test.ts` and `cloudflare.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/services/provisioner/docker-orchestrator.ts apps/hub/src/services/provisioner/docker-orchestrator.test.ts
git commit -m "feat(hub): optional container runtime in the docker orchestrator"
```

---

## Task 2: Driver reads the env var and returns the observed runtime

**Files:**
- Modify: `apps/hub/src/services/provisioner/types.ts:36-59`
- Modify: `apps/hub/src/services/provisioner/docker.ts`
- Modify: `apps/hub/src/services/provisioner/docker.test.ts`

**Interfaces:**
- Consumes: `DockerOrchestratorConfig.runtime`, `Sandbox.runtime` from Task 1.
- Produces: `RuntimeProvisioner.provision` returns `Promise<{ externalId: string; runtime?: string }>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/hub/src/services/provisioner/docker.test.ts`. Read the top of that file first — it has a `FakeDockerOrchestrator` whose `createSandbox` returns a `Sandbox`; these tests extend it.

```ts
describe("DockerRuntimeProvisioner runtime selection", () => {
  const ORIGINAL = process.env.DOCKER_RUNTIME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DOCKER_RUNTIME;
    else process.env.DOCKER_RUNTIME = ORIGINAL;
  });

  it("returns the runtime the orchestrator observed, not the one configured", () => {
    // The whole point of the field. If config says runsc and Docker actually
    // ran runc, we must record runc — that mismatch is what this catches, and
    // recording the request instead would hide it forever.
    process.env.DOCKER_RUNTIME = "runsc";

    const fake = new FakeDockerOrchestrator();
    fake.runtimeToReport = "runc"; // Docker disagreed with us

    const p = new DockerRuntimeProvisioner(fake as unknown as DockerOrchestrator);
    return p
      .provision({
        runtimeId: "rt_1",
        name: "n",
        resourceTier: "small",
        hubUrl: "https://hub.example",
        enrollToken: "enr_x",
        image: "agentpod-node:local",
      })
      .then((res) => {
        expect(res.runtime).toBe("runc");
      });
  });

  it("omits runtime when the orchestrator reports none", async () => {
    delete process.env.DOCKER_RUNTIME;

    const fake = new FakeDockerOrchestrator();
    fake.runtimeToReport = undefined;

    const p = new DockerRuntimeProvisioner(fake as unknown as DockerOrchestrator);
    const res = await p.provision({
      runtimeId: "rt_2",
      name: "n",
      resourceTier: "small",
      hubUrl: "https://hub.example",
      enrollToken: "enr_x",
      image: "agentpod-node:local",
    });
    expect(res.runtime).toBeUndefined();
    expect(res.externalId).toBe(FAKE_CONTAINER_ID);
  });

  it("surfaces an unavailable runtime as a failure, never a silent fallback", async () => {
    // Docker rejects an unknown runtime at create. That must reach the caller:
    // quietly running under runc would leave the operator believing they had
    // kernel isolation when they had none.
    process.env.DOCKER_RUNTIME = "not-installed";

    const fake = new FakeDockerOrchestrator();
    fake.createError = new Error('Unknown runtime specified not-installed');

    const p = new DockerRuntimeProvisioner(fake as unknown as DockerOrchestrator);
    await expect(
      p.provision({
        runtimeId: "rt_3",
        name: "n",
        resourceTier: "small",
        hubUrl: "https://hub.example",
        enrollToken: "enr_x",
        image: "agentpod-node:local",
      })
    ).rejects.toThrow(/not-installed/);
  });
});
```

Extend `FakeDockerOrchestrator` in the same file with the two new knobs — find its `createSandbox` and add:

```ts
  runtimeToReport: string | undefined = undefined;
  createError: Error | null = null;
```

and at the top of `createSandbox`:

```ts
    if (this.createError) throw this.createError;
```

and include `runtime: this.runtimeToReport` in the `Sandbox` it returns.

Add `afterEach` to the `bun:test` import if it is not already there.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/docker.test.ts
```

Expected: FAIL — `res.runtime` is undefined because `provision` does not return it yet.

- [ ] **Step 3: Widen the interface**

In `apps/hub/src/services/provisioner/types.ts`, change the `provision` signature:

```ts
  /**
   * Create and start a new runtime for the given spec.
   *
   * Returns the provider-specific external identifier, and — where the provider
   * can report it — the container runtime actually used. Optional so providers
   * with no such concept (Cloudflare) are unaffected.
   */
  provision(spec: ProvisionSpec): Promise<{ externalId: string; runtime?: string }>;
```

- [ ] **Step 4: Read the env var and pass the observation through**

In `apps/hub/src/services/provisioner/docker.ts`, change the constructor default so the env var reaches the orchestrator:

```ts
  constructor(
    private readonly orchestrator: DockerOrchestrator = new DockerOrchestrator({
      // Set by the operator to harden the host, e.g. DOCKER_RUNTIME=runsc for
      // gVisor. Unset keeps Docker's default and today's exact behaviour.
      runtime: process.env.DOCKER_RUNTIME || "",
    })
  ) {}
```

Then find `provision` and return the observed runtime alongside the id. Read the existing body first; it calls `createSandbox` and returns `{ externalId: sandbox.containerId }`. Change that return to:

```ts
    return { externalId: sandbox.containerId, runtime: sandbox.runtime };
```

No try/catch is added: an unknown runtime makes `createSandbox` throw, and that error must propagate. `createRuntime` already turns a driver throw into a 502 and marks the row `error`.

- [ ] **Step 5: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/
```

Expected: PASS. `cloudflare.ts` needs no change — its `provision` already returns `{ externalId }`, which satisfies the widened type.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/provisioner
git commit -m "feat(hub): docker driver reads DOCKER_RUNTIME and reports what ran"
```

---

## Task 3: Persist and expose the runtime

**Files:**
- Modify: `packages/contract/src/runtime.ts`
- Modify: `apps/hub/src/db/schema/nodes.ts:25-38`
- Modify: `apps/hub/src/services/runtimes.ts:53-67,148-160`
- Modify: `apps/hub/src/routes/runtimes.test.ts`

**Interfaces:**
- Consumes: `provision` returning `{ externalId, runtime? }` from Task 2.
- Produces: `provisioned_runtimes.runtime` column; `ProvisionedRuntime.runtime?: string | null`.

- [ ] **Step 1: Write the failing contract test**

Append to `packages/contract/src/runtime.test.ts` — create the file if it does not exist, matching the conventions in `packages/contract/src/station.test.ts`:

```ts
import { test, expect } from "bun:test";
import { ProvisionedRuntime } from "./runtime";

const BASE = {
  id: "rt_1", ownerId: "u_1", provider: "docker" as const, externalId: "abc",
  status: "online" as const, nodeId: null, name: "n",
  resourceTier: "small" as const, harness: "opencode" as const,
  createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:00Z",
};

test("a runtime can report the container runtime it runs under", () => {
  expect(ProvisionedRuntime.parse({ ...BASE, runtime: "runsc" }).runtime).toBe("runsc");
});

test("runtime is absent on rows that predate it and on providers without the concept", () => {
  // Null rather than a guess: a Cloudflare sandbox has no container runtime,
  // and a row created before this field existed never had one recorded.
  expect(ProvisionedRuntime.parse(BASE).runtime).toBeUndefined();
  expect(ProvisionedRuntime.parse({ ...BASE, runtime: null }).runtime).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/contract && bun test src/runtime.test.ts
```

Expected: FAIL — `runtime: "runsc"` is stripped, so `.runtime` is undefined in the first test.

- [ ] **Step 3: Add the contract field**

In `packages/contract/src/runtime.ts`, add to `ProvisionedRuntime` after `harness`:

```ts
  /**
   * Container runtime the provider reports this runtime is running under, e.g.
   * "runsc" for gVisor. Null for providers with no such concept and for rows
   * created before it was recorded — never inferred.
   */
  runtime: z.string().min(1).nullable().optional(),
```

- [ ] **Step 4: Add the column and migration**

In `apps/hub/src/db/schema/nodes.ts`, add to `provisionedRuntimes` after `harness`:

```ts
  runtime: text("runtime"),
```

Generate the migration:

```bash
cd apps/hub && bun run db:generate
```

Expected: a new `.sql` file containing only `ALTER TABLE "provisioned_runtimes" ADD COLUMN "runtime" text;`. Migrations auto-apply on hub boot; do not apply by hand.

- [ ] **Step 5: Persist it and put it in the DTO**

In `apps/hub/src/services/runtimes.ts`, add to `toContract` after the `harness` line:

```ts
    runtime: row.runtime ?? null,
```

Then find the `provisioner.provision({...})` call and change the destructure and the update that follows it:

```ts
    const { externalId, runtime } = await provisioner.provision({
```

```ts
    await db
      .update(provisionedRuntimes)
      .set({ externalId, runtime: runtime ?? null, updatedAt: new Date() })
      .where(eq(provisionedRuntimes.id, id));
```

- [ ] **Step 6: Write the failing route test**

Append to `apps/hub/src/routes/runtimes.test.ts`. Read the file first — it registers a fake provisioner via `registerProvisioner`; this test does the same with one that reports a runtime.

```ts
test("the runtime a driver reports is stored and returned", async () => {
  // Proves the value survives the whole path: driver → column → DTO. Without
  // this the field can be plumbed everywhere and still arrive null.
  resetProvisioners();
  process.env.ENABLE_DOCKER_PROVISIONING = "true";
  registerProvisioner({
    provider: "docker",
    async provision() {
      return { externalId: "container_abc", runtime: "runsc" };
    },
    async destroy() {},
  } as never);

  const res = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "docker", name: "gvisor-rt", resourceTier: "small" }),
  });

  expect(res.status).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.runtime).toBe("runsc");
});

test("a driver that reports no runtime stores null", async () => {
  resetProvisioners();
  process.env.ENABLE_DOCKER_PROVISIONING = "true";
  registerProvisioner({
    provider: "docker",
    async provision() {
      return { externalId: "container_def" };
    },
    async destroy() {},
  } as never);

  const res = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "docker", name: "plain-rt", resourceTier: "small" }),
  });

  expect(res.status).toBe(201);
  expect((await res.json()).runtime).toBeNull();
});
```

Match the file's existing helper names — if its app instance, user constant or status code differ from `app` / `TEST_USER` / `201`, use its versions rather than these.

- [ ] **Step 7: Run the suites**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS on both.

- [ ] **Step 8: Commit**

```bash
git add packages/contract apps/hub
git commit -m "feat(hub): persist and expose the container runtime a runtime ran under"
```

---

## Task 4: Console shows it, and the deployment doc explains it

**Files:**
- Modify: `apps/console/src/lib/api/client.ts`
- Modify: `apps/console/src/routes/runtimes/+page.svelte`
- Modify: `apps/console/src/routes/runtimes/page.svelte.test.ts`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: `ProvisionedRuntime.runtime` from Task 3.
- Produces: the runtime rendered on the runtimes page when present.

- [ ] **Step 1: Write the failing test**

Append to `apps/console/src/routes/runtimes/page.svelte.test.ts`. Read the file first and reuse its render helper and runtime fixture shape.

```ts
test("a runtime running under gVisor says so", async () => {
  // The operator needs to see which isolation a runtime actually got. Showing
  // nothing would make a hardened and an unhardened runtime look identical.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...RUNTIME_FIXTURE, id: "rt_1", name: "hardened", runtime: "runsc" },
  ]);
  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/runsc/));
});

test("a runtime with no reported runtime shows none", async () => {
  // Null means "not recorded", not "runc". Printing a default here would be a
  // guess presented as a fact.
  vi.spyOn(api, "listRuntimes").mockResolvedValue([
    { ...RUNTIME_FIXTURE, id: "rt_2", name: "plain", runtime: null },
  ]);
  const { container } = render(RuntimesPage);
  await waitFor(() => expect(container.textContent).toMatch(/plain/));
  expect(container.textContent).not.toMatch(/runsc|runc/);
});
```

If the file has no shared `RUNTIME_FIXTURE`, build one inline from the shape the existing tests use.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/console && pnpm test -- runtimes
```

Expected: FAIL — nothing renders `runsc`.

- [ ] **Step 3: Add the field to the client type**

In `apps/console/src/lib/api/client.ts`, find the runtime row type (search for `resourceTier`) and add:

```ts
  /** Container runtime reported by the provider, e.g. "runsc". Null when not recorded. */
  runtime?: string | null;
```

- [ ] **Step 4: Render it**

In `apps/console/src/routes/runtimes/+page.svelte`, find where a runtime row renders its provider and tier, and add the runtime beside them, only when present:

```svelte
        {#if rt.runtime}
          <Badge variant="outline" class="font-mono text-xs">{rt.runtime}</Badge>
        {/if}
```

Read the surrounding markup and match it — if the row uses plain spans rather than `Badge`, use a span, and import `Badge` only if the file already does.

- [ ] **Step 5: Run the console suite**

```bash
cd apps/console && pnpm check && pnpm test && pnpm build
```

Expected: PASS on all three.

- [ ] **Step 6: Document the install**

In `docs/DEPLOYMENT.md`, add a subsection under the hub deployment section. A config flag with no install instructions is a trap.

````markdown
### Optional: gVisor isolation for provisioned runtimes

Provisioned runtimes run on the hub box and execute agent-generated code. Under
Docker's default `runc` they share the host kernel, so a container escape is a
hub compromise. gVisor (`runsc`) gives each container its own userspace kernel.

It needs **no nested virtualisation and no bare metal** — Linux 4.14.77+ is the
only requirement.

```bash
ARCH=$(uname -m)
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
curl -fsSL -o runsc "${URL}/runsc" -o runsc.sha512 "${URL}/runsc.sha512" \
     -o containerd-shim-runsc-v1 "${URL}/containerd-shim-runsc-v1" \
     -o containerd-shim-runsc-v1.sha512 "${URL}/containerd-shim-runsc-v1.sha512"
sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
chmod a+rx runsc containerd-shim-runsc-v1
sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin/
sudo /usr/local/bin/runsc install
sudo systemctl reload docker      # reload, NOT restart — running containers keep running
```

Verify Docker sees it, then enable it for new runtimes:

```bash
docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}'   # expect runsc listed
echo 'DOCKER_RUNTIME=runsc' >> /etc/agentpod/hub.env
systemctl restart agentpod-hub
```

Existing runtimes keep their current runtime; this affects newly provisioned
ones. The console shows each runtime's actual runtime, read back from Docker
rather than from config, so you can confirm rather than assume.

**If `runsc` is not installed and `DOCKER_RUNTIME=runsc` is set, provisioning
fails loudly.** It never falls back to `runc` — a silent fallback would leave
you believing you had kernel isolation when you had none.

Verified on the reference box (Ubuntu 24.04, kernel 6.8, Docker 29.6.1): the
node-agent enrols, heartbeats, allocates PTYs for the terminal capability, and
runs ACP stdio children under `runsc` identically to `runc`. Expect 5–20% CPU
overhead depending on syscall frequency.
````

- [ ] **Step 7: Commit**

```bash
git add apps/console docs/DEPLOYMENT.md
git commit -m "feat(console): show a runtime's container runtime; document runsc install"
```

---

## Task 5: Full verification, live check, and PR

- [ ] **Step 1: Run every suite**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd ../node-agent && go vet ./... && go test -race ./...
cd ../console && pnpm check && pnpm test && pnpm build
```

Expected: all four green — the required checks on `main`.

- [ ] **Step 2: Verify the fixture check the way CI does**

```bash
cd packages/contract && bun run scripts/emit-go-fixtures.ts --check
```

Expected: PASS. This change touches no frame the node-agent mirrors, so no fixture should move.

- [ ] **Step 3: Verify against real Docker locally**

The unit tests use a fake orchestrator, so nothing so far has proven dockerode actually accepts the option. With Docker running locally:

```bash
docker run -d --name gvisor-optcheck --rm alpine:latest sleep 30
docker inspect gvisor-optcheck --format '{{.HostConfig.Runtime}}'
docker rm -f gvisor-optcheck
```

Expected: prints `runc`. This confirms the field name `HostConfig.Runtime` is what inspect returns, which is what Task 1 Step 5 reads. If it prints empty, the read path is wrong and Task 1 needs fixing before the PR.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin gvisor-runtime
gh pr create --title "feat: run provisioned runtimes under gVisor" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-12-gvisor-runtime-design.md` — step 2 of the
re-planned driver wave.

Provisioned runtimes land on the hub box and execute agent-generated code. Under
`runc` they share the host kernel, so a container escape is a hub compromise.
`DOCKER_RUNTIME=runsc` gives each container its own userspace kernel.

## Validated before it was designed

`runsc` was installed on the hub box and the whole path exercised first, because
a runtime flag that breaks the agent would be worse than no flag:

| Check | Result |
|---|---|
| gVisor genuinely intercepting | container kernel `4.19.0-gvisor` vs host `6.8.0-107-generic` |
| `/proc` — health metrics | works |
| **PTY: `pty.StartWithSize`, `Setsize`, read/write** | **byte-identical to `runc`** |
| Long-lived stdio child (ACP shape) | works |
| Signals and child reaping | works |
| Node-agent enrols, dials the hub, heartbeats | `status: online`, last seen 3s |
| `apn scan` inside the sandbox | grade A, `unknown` for absent `lsof` |

`docker run -t` *does* differ under gVisor — `tty` cannot resolve `/dev/pts/0` —
but the node-agent allocates its own PTY via `creack/pty`, and a probe built
against that library was identical to `runc`. Testing the convenient thing
rather than the real thing would have produced a false alarm.

## Two properties worth reviewing for

**Fails closed.** An unavailable runtime fails the provision with an error
naming it. It never silently falls back to `runc`, which would leave an operator
believing they had kernel isolation while they had none — the same failure shape
as the scanner that graded machines A on files it never opened.

**Records what ran, not what was asked.** The stored value is read back from
`inspect`, so a config saying `runsc` while Docker ran `runc` records `runc`.
That mismatch is the whole reason the field exists.

Unset `DOCKER_RUNTIME` produces a create request byte-identical to today's —
`HostConfig.Runtime` is absent from the object, not empty — and a test asserts it.

## Not in scope

Remote Docker host (deferred: it needs either a credential on the hub or
Tailscale, and both were declined), per-user runtime choice, other isolation
technologies. This does not fix co-location — a runaway agent can still starve
the hub — only the shared-kernel half.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EohapceVTgobwUGTQ5LuyW
EOF
)"
```

- [ ] **Step 5: Wait for the four required checks**

```bash
gh pr checks --watch
```

Expected: `contract`, `hub`, `node-agent`, `console` all green.
