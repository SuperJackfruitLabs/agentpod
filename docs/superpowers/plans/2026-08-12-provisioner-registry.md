# Provisioner Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a driver declare what it can do, check those declarations in CI, and stop provider names being hardcoded — so Fly and Modal can be added without editing three packages.

**Architecture:** Every driver exposes a `DriverManifest` whose fields are required, so omission is a compile error. The registry serves manifests to the hub and console instead of a hardcoded union. A conformance suite verifies each driver's *declarations against its behaviour*. Credentials move behind a resolver so the per-org store can land later without touching drivers.

**Tech Stack:** Bun + Hono + Drizzle (hub), zod 4 (contract), Svelte 5 (console), vitest (Cloudflare worker).

**Spec:** `docs/superpowers/specs/2026-08-12-provisioner-registry-design.md` — read it first, especially the four-substrate comparison table. Every manifest field exists because its absence cost something real.

**Scope:** This plan covers the manifest, registry, conformance suite, worker CI and credential resolver, retrofitted onto the two drivers that exist. **The Fly and Modal drivers are separate plans**, written after the empirical probes the spec requires.

## Global Constraints

- Docker and Cloudflare declarations must describe what those drivers **already do**. This plan changes no runtime behaviour; if a test that passed before now fails, the declaration is wrong, not the test.
- TDD: failing test first, every time. Prove each new guard is non-vacuous by breaking the code and watching the test fail.
- Never weaken an existing test to make a new one pass.
- Run the full suites **after the last edit**: `cd packages/contract && bun test`; `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`; `cd apps/console && pnpm check && pnpm test && PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build`; `cd cloudflare/worker-v2 && npx vitest run`.
- Console tests require **Node 22**, not 26 (jsdom 25 leaves `window.localStorage` undefined → 125 unrelated failures).

---

### Task 1: The manifest type, and Docker declares it

**Files:**
- Modify: `apps/hub/src/services/provisioner/types.ts`
- Modify: `apps/hub/src/services/provisioner/docker.ts`
- Test: `apps/hub/src/services/provisioner/docker.test.ts`

**Interfaces:**
- Produces: `DriverManifest` (exported from `types.ts`), and `RuntimeProvisioner.manifest: DriverManifest` as a **required** readonly property.

- [ ] **Step 1: Write the failing test**

```ts
it("declares a manifest describing what it can actually do", () => {
  const m = new DockerRuntimeProvisioner().manifest;
  // Docker is the only substrate whose disk survives a stop — the spec's table
  // shows the other three do not, which is why this is declared, not assumed.
  expect(m.workspaceStorage).toBe("rootfs");
  expect(m.stopSemantics).toBe("resumable");
  expect(m.maxLifetimeMs).toBeNull();
  expect(m.imageBinding).toBe("per-instance");
  expect(m.supportedTiers).toEqual(["small", "medium", "large"]);
  expect(m.idleBehaviour).toBe("never");
  expect(m.lifecycle).toEqual(expect.arrayContaining(["start", "stop", "status"]));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/docker.test.ts`
Expected: FAIL — `manifest` is undefined.

- [ ] **Step 3: Add the type**

In `types.ts`, add the interface exactly as the spec defines it (`provider`, `workspaceStorage`, `stopSemantics`, `maxLifetimeMs`, `imageBinding`, `supportedTiers`, `idleBehaviour`, `lifecycle`), then add `readonly manifest: DriverManifest;` to `RuntimeProvisioner`. Keep the existing `readonly provider` for now — Task 4 removes it once nothing reads it.

Document each field with the incident that motivates it; the spec's table is the source. `stopSemantics` gets the strongest comment: had it been required, the Cloudflare workspace loss would have been a compile-time question.

- [ ] **Step 4: Declare it on Docker**

Add the `manifest` property with the values the test asserts. These are Docker's real behaviour, not aspirations.

- [ ] **Step 5: Run the test**

Expected: PASS. The Cloudflare driver will now fail to compile — that is correct and Task 2 fixes it.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/provisioner/types.ts apps/hub/src/services/provisioner/docker.ts apps/hub/src/services/provisioner/docker.test.ts
git commit -m "feat(provisioner): required driver manifest, declared by Docker"
```

---

### Task 2: Cloudflare declares its manifest

**Files:**
- Modify: `apps/hub/src/services/provisioner/cloudflare-sandbox.ts`
- Test: `apps/hub/src/services/provisioner/cloudflare-sandbox.test.ts`

**Interfaces:**
- Consumes: `DriverManifest` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
it("declares the constraints that made this driver refuse things", () => {
  const m = new CloudflareSandboxProvisioner({ deployedTier: "large" }).manifest;
  // Every value here is a fact this driver already enforces by hand.
  expect(m.workspaceStorage).toBe("external-archive"); // R2, because the disk is wiped on sleep
  expect(m.stopSemantics).toBe("resumable");
  expect(m.imageBinding).toBe("fixed");                // baked at worker deploy time
  expect(m.supportedTiers).toEqual(["large"]);         // instance_type is fixed per class
  expect(m.idleBehaviour).toBe("platform-inbound");    // sleepAfter, fed by inbound requests only
  expect(m.maxLifetimeMs).toBeNull();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/cloudflare-sandbox.test.ts`
Expected: FAIL — `manifest` undefined.

- [ ] **Step 3: Declare it**

`supportedTiers` must derive from the existing `deployedTier` constructor option, not be hardcoded — the driver already refuses other tiers using that value, and two sources of the same truth will drift.

- [ ] **Step 4: Run the whole hub suite**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`
Expected: PASS (~516 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/
git commit -m "feat(provisioner): Cloudflare declares its manifest"
```

---

### Task 3: Registry serves manifests

**Files:**
- Modify: `apps/hub/src/services/provisioner/registry.ts`
- Modify: `apps/hub/src/services/runtimes.ts` (re-export), `apps/hub/src/routes/runtimes.ts`
- Test: `apps/hub/src/services/provisioner/registry.test.ts`

**Interfaces:**
- Consumes: `DriverManifest`.
- Produces: `providerManifests(): DriverManifest[]`, replacing `providerCapabilities()`.

- [ ] **Step 1: Write the failing test**

```ts
it("serves each enabled provider's full manifest", () => {
  process.env.ENABLE_DOCKER_PROVISIONING = "true";
  registerProvisioner(new DockerRuntimeProvisioner());
  const [m] = providerManifests();
  expect(m.provider).toBe("docker");
  expect(m.supportedTiers).toEqual(["small", "medium", "large"]);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/registry.test.ts`
Expected: FAIL — `providerManifests` not exported.

- [ ] **Step 3: Implement**

`providerManifests()` maps enabled providers to `driver.manifest`. Delete `providerCapabilities()` and the `ALL_TIERS` fallback — a manifest is required now, so there is nothing to default. Update `GET /api/runtimes/providers` to return `{ providers, manifests }`, keeping `providers` for compatibility with the deployed console until Task 5 ships.

- [ ] **Step 4: Run the hub suite**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/ apps/hub/src/services/runtimes.ts apps/hub/src/routes/runtimes.ts
git commit -m "feat(provisioner): registry serves driver manifests"
```

---

### Task 4: Provider names become data

**Files:**
- Modify: `packages/contract/src/runtime.ts`, `packages/contract/src/runtime.test.ts`
- Modify: `apps/hub/src/services/provisioner/types.ts`, `registry.ts`
- Modify: `apps/hub/src/routes/runtimes.ts`

**Interfaces:**
- Consumes: `providerManifests()` from Task 3.

- [ ] **Step 1: Write the failing contract test**

```ts
it("accepts any provider name — the registry decides what is valid, not the enum", () => {
  const r = ProvisionRequest.parse({ provider: "fly", name: "x", resourceTier: "small" });
  expect(r.provider).toBe("fly");
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd packages/contract && bun test`
Expected: FAIL — `"fly"` is not in the enum.

- [ ] **Step 3: Widen the contract, narrow the hub**

Change `RuntimeProvider` from a zod enum to `z.string().min(1)`. Replace the `RuntimeProviderName` union in `types.ts` with `type RuntimeProviderName = string`.

**The validation does not disappear — it moves.** `createRuntime` already calls `isProviderEnabled` and throws `provider disabled: X` / `unknown provider: X`; that check now resolves against registered manifests. Add a hub test asserting an unregistered provider is still refused with a 400, so widening the contract does not widen what the hub accepts.

- [ ] **Step 4: Run contract and hub suites**

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contract apps/hub
git commit -m "feat(provisioner): provider names validated by the registry, not the enum"
```

---

### Task 5: Console builds its provider list from manifests

**Files:**
- Modify: `apps/console/src/lib/api/client.ts`
- Modify: `apps/console/src/lib/components/fleet/NewRuntimeDialog.svelte`
- Test: `apps/console/src/lib/components/fleet/NewRuntimeDialog.svelte.test.ts`

**Interfaces:**
- Consumes: `GET /api/runtimes/providers` → `{ providers, manifests }`.

- [ ] **Step 1: Write the failing test**

```ts
test("offers a provider the console has never heard of, if the hub reports it", async () => {
  // The point of the registry: adding a driver must not require a console edit.
  const { getByText } = render(NewRuntimeDialog, {
    props: {
      open: true,
      providers: ["fly"],
      manifests: [{ provider: "fly", supportedTiers: ["small"], imageBinding: "per-instance" }],
      onClose: () => {}, onCreated: () => {},
    },
  });
  expect(getByText("fly")).toBeTruthy();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/console && pnpm vitest run src/lib/components/fleet/NewRuntimeDialog.svelte.test.ts`
Expected: FAIL — no `manifests` prop.

- [ ] **Step 3: Implement**

Accept `manifests` and derive the tier list from the selected provider's manifest, replacing the `capabilities` prop added in PR #250 (same idea, richer payload). Keep the existing behaviour that an unsupported tier selection resets to a supported one.

- [ ] **Step 4: Run all three console commands**

Run: `cd apps/console && pnpm check && pnpm test && PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build` (Node 22)
Expected: all pass, reported separately.

- [ ] **Step 5: Commit**

```bash
git add apps/console
git commit -m "feat(console): provider list built from hub-reported manifests"
```

---

### Task 6: Conformance suite

**Files:**
- Create: `apps/hub/src/services/provisioner/conformance.ts`, `apps/hub/src/services/provisioner/conformance.test.ts`

**Interfaces:**
- Consumes: `DriverManifest`, `RuntimeProvisioner`.
- Produces: `assertConforms(driver: RuntimeProvisioner): Promise<void>` — throws with a message naming the violated rule.

- [ ] **Step 1: Write the failing test**

```ts
const base: DriverManifest = {
  provider: "fake", workspaceStorage: "rootfs", stopSemantics: "resumable",
  maxLifetimeMs: null, imageBinding: "per-instance", supportedTiers: ["small"],
  idleBehaviour: "never", lifecycle: ["start", "stop", "status"],
};

it("rejects a driver that declares a fixed image but accepts any image", async () => {
  // Cloudflare silently ignored spec.image until we made it refuse by hand.
  const driver = fakeDriver({ ...base, imageBinding: "fixed" }, { provisionAcceptsAnyImage: true });
  await expect(assertConforms(driver)).rejects.toThrow(/imageBinding/i);
});

it("rejects a driver that declares a tier it will not provision", async () => {
  const driver = fakeDriver({ ...base, supportedTiers: ["small", "large"] }, { refusesTier: "large" });
  await expect(assertConforms(driver)).rejects.toThrow(/supportedTiers/i);
});

it("rejects a terminal-stop driver that also claims a start verb", async () => {
  // Modal: terminate is irreversible, so there is no start to call.
  const driver = fakeDriver({ ...base, stopSemantics: "terminal", lifecycle: ["start", "stop"] });
  await expect(assertConforms(driver)).rejects.toThrow(/stopSemantics/i);
});

it("rejects a resumable driver whose rootfs is wiped and has no archive", async () => {
  // The Cloudflare data loss, as a checkable rule.
  const driver = fakeDriver({ ...base, workspaceStorage: "rootfs", stopSemantics: "resumable" },
                             { rootfsWipedOnStop: true });
  await expect(assertConforms(driver)).rejects.toThrow(/workspaceStorage/i);
});

it("accepts the real Docker and Cloudflare drivers", async () => {
  await expect(assertConforms(new DockerRuntimeProvisioner())).resolves.toBeUndefined();
  await expect(assertConforms(new CloudflareSandboxProvisioner({ deployedTier: "large" }))).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm failure**

Expected: FAIL — `assertConforms` not defined.

- [ ] **Step 3: Implement**

Write `assertConforms` plus a `fakeDriver` helper in the test file. The rules are structural (checked against the manifest and the driver's method presence) plus behavioural where a fake can exercise them — `imageBinding: "fixed"` means `provision` with a differing image must reject; a tier outside `supportedTiers` must reject. **Do not** call real substrates.

The last test is the load-bearing one: the two real drivers must pass, so the suite is validated against reality before it gates anything new.

- [ ] **Step 4: Run the hub suite**

Expected: PASS.

- [ ] **Step 5: Prove the suite is not vacuous**

Temporarily flip Cloudflare's declared `imageBinding` to `"per-instance"`. `assertConforms` must reject it, because the driver really does refuse a differing image. Restore, confirm green, and report what you saw.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/provisioner/conformance.ts apps/hub/src/services/provisioner/conformance.test.ts
git commit -m "feat(provisioner): conformance suite checking declarations against behaviour"
```

---

### Task 7: Worker CI coverage

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Read the existing workflow** and note how the `contract`, `hub`, `node-agent` and `console` jobs are declared — match that shape rather than inventing one.

- [ ] **Step 2: Add a `worker` job** that runs `npm install` and `npx vitest run` in `cloudflare/worker-v2`.

`cloudflare/worker-v2` has **no CI coverage today** — its 36 tests only ever run in a developer's checkout, which is exactly why the frozen-`envVars` bug (#253) stayed invisible until it cost a workspace.

- [ ] **Step 3: Verify by pushing and watching the job run.** A workflow change cannot be verified locally; confirm the job appears and passes on the PR.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the Cloudflare worker test suite"
```

---

### Task 8: Credential resolver

**Files:**
- Create: `apps/hub/src/services/provisioner/credentials.ts`, `apps/hub/src/services/provisioner/credentials.test.ts`
- Modify: `apps/hub/src/services/provisioner/bootstrap.ts`

**Interfaces:**
- Produces: `interface CredentialResolver { get(key: string): string | undefined }`, `envCredentialResolver()`, and `requireCredentials(manifest, keys, resolver)`.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses to register a driver whose credentials are missing", () => {
  const resolver = { get: () => undefined };
  expect(() => requireCredentials("fly", ["FLY_API_TOKEN"], resolver))
    .toThrow(/FLY_API_TOKEN/);
});

it("returns the resolved values when present", () => {
  const resolver = { get: (k: string) => (k === "FLY_API_TOKEN" ? "tok" : undefined) };
  expect(requireCredentials("fly", ["FLY_API_TOKEN"], resolver)).toEqual({ FLY_API_TOKEN: "tok" });
});
```

- [ ] **Step 2: Run and confirm failure**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`envCredentialResolver()` reads `process.env`. `requireCredentials` throws naming the provider and every missing key, so a misconfigured deploy fails at startup rather than on a user's first provisioning attempt.

**Do not** wire Docker or Cloudflare through it in this task — they read env directly today and changing that is behaviour, not structure. The resolver exists so the Fly and Modal drivers have somewhere to get a token, and so the per-org store can replace the implementation in Horizon 3 without touching drivers.

- [ ] **Step 4: Run the hub suite**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/credentials.ts apps/hub/src/services/provisioner/credentials.test.ts
git commit -m "feat(provisioner): env-backed credential resolver"
```

---

### Task 9: Deploy and verify

- [ ] **Step 1: Open the PR**, confirm all five CI checks pass (the new `worker` job included).

- [ ] **Step 2: Deploy the hub**, then the console.

- [ ] **Step 3: Verify against the live hub** — `GET /api/runtimes/providers` returns manifests for `docker` and `cloudflare` with the values Tasks 1 and 2 declared.

- [ ] **Step 4: Verify in the console** — open New Runtime, confirm the provider list still shows both and that selecting Cloudflare still offers only `large`.

- [ ] **Step 5: Provision one Docker runtime end to end** and destroy it, confirming this plan changed no runtime behaviour.

---

## Self-review notes

- **Spec coverage:** manifest (T1–T2), registry (T3), dynamic names (T4), console (T5), conformance (T6), worker CI (T7), resolver (T8), live verification (T9).
- **Deliberately not here:** the Fly and Modal drivers, and the empirical probes the spec makes a prerequisite to writing them. Those are separate plans, because their content depends on what the probes find.
- **Known risk:** Task 4 widens the contract. The mitigation is the explicit hub test that an unregistered provider is still refused — widening the wire format must not widen what the hub accepts.
