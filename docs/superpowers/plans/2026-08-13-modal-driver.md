# Modal Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision AgentPod runtimes on Modal, where a runtime is a rolling series of disposable sandboxes anchored by one named Volume, and the platform's hard 24-hour sandbox ceiling is handled by the hub instead of being discovered by a user.

**Architecture:** A `modal` driver talks to a narrow `ModalApi` port; one adapter file wraps the first-party JS SDK and is the only place SDK churn can reach. `provision()` creates a sandbox mounting a Volume named after the runtime id, so the workspace outlives every sandbox; the composite `externalId` (`<volumeName>#<sandboxId>`) is what lets a stateless driver find both. `terminate` is irreversible, so the driver declares `stopSemantics: "terminal"` and implements no `start()`; the hub learns that "start" on a terminal driver means *provision again against the same Volume*, and a new sweeper uses the same path to rotate a sandbox before Modal destroys it at 24 hours.

**Tech Stack:** Bun + Hono + Drizzle/Postgres (hub), `modal` JS SDK pinned at `0.9.0`, Docker buildx (image), `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-12-provisioner-registry-design.md` — read it first. Every manifest field this driver fills in exists because its absence cost something real.

## Sequencing — read this before starting

**This plan executes AFTER the Fly driver has landed and been live-verified.** That order is deliberate: Modal is the harder test of whether the manifest generalises (terminal stop, a platform-imposed lifetime ceiling, no start verb at all), and if it surfaces a gap in the `RuntimeProvisioner` interface, that is far cheaper to handle with a second driver already stable in production than with Fly still in flight.

**Do not assume any Fly code exists.** Nothing in this plan reads, imports, extends or refactors a Fly driver. Every dependency is on groundwork that is already shipped on `main`:

- Drivers declare a required `DriverManifest` (`apps/hub/src/services/provisioner/types.ts`).
- Provider names are data: a driver named `modal` is gated by `ENABLE_MODAL_PROVISIONING` with **no** contract, hub or console edit (`registry.ts:providerEnvFlag`).
- `assertConforms` (`conformance.ts`) checks declarations against behaviour; this driver must pass it.
- `requireCredentials` (`credentials.ts`) turns a missing key into a startup refusal listing every missing key at once.
- `status?()` exists and `stopRuntime`/`sweepStalledRuntimeStops` use it as the *only* evidence for writing `stopped`.
- Runtime-bound enrolment tokens are durable and re-presentable (`RUNTIME_TOKEN_TTL_MS`, 10 years, PR #252), and `enrollNode` resumes an existing node with a rotated secret rather than orphaning it.

## Cost, stated honestly before anyone turns this on

Modal sandbox compute carries roughly a **3× premium over standard Modal rates** and bills **wall-clock for as long as the sandbox exists** — not for work done. A minimal always-on runtime is about **$21/month**. A mostly-idle fleet is this substrate's worst case, and AgentPod fleets are mostly idle. Modal earns its place for short, bursty, isolated work; it is the wrong default for a long-lived station that sits waiting for its operator. The docs task makes this the first sentence an operator reads.

**RBAC:** Modal's per-resource scoping requires the **$250/month Team plan**. On Starter, `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` are **workspace-wide** — the hub's token can see and destroy everything in that Modal workspace. Use a workspace dedicated to AgentPod. This is a cost of doing business with Modal, not something this plan can engineer around.

## Measured facts — these were probed against a real Modal account on 2026-08-13

Use these, not documentation. Where a step contradicts your memory of Modal's docs, the step is right.

- **The first-party JS SDK works on Bun.** `npm install modal`, `bun probe.mjs`: client constructed, credentials resolved, sandbox created, volume mounted, `exec` run, sandbox terminated. **No Python shim is needed** — this driver is ordinary TypeScript.
- **A named Volume DOES anchor identity across sandbox recreation.** Sandbox 1 wrote a sentinel into a volume-mounted path and terminated; sandbox 2 — a different `sandboxId` — mounted the same Volume *by name* and read the sentinel back. **This single fact is what makes Modal viable at all.**
- **`terminate` is irreversible and there is no start verb.** Every restart is a new sandbox with a new id and a fresh rootfs.
- **Hard 24-hour maximum sandbox lifetime.** The platform destroys a healthy runtime on that deadline, never brings it back, and gives no warning callback. Nothing in the API rotates for you.
- **`idleTimeoutMs` is opt-in and defaults to off.** Never set it. That sidesteps the Cloudflare-style inbound-activity trap entirely — see the spec's `idleBehaviour: "platform-inbound"` warning.
- **`timeoutMs` defaults to 5 minutes.** Not setting it is not "no limit", it is "your station dies in five minutes".
- **The SDK is 0.x and churns.** `timeout` was renamed `timeoutMs` and an unknown key is rejected at runtime by the SDK's own `checkForRenamedParams` guard. **Pin the version exactly** — `"modal": "0.9.0"`, no caret.
- **Images must contain python and pip**, any `ENTRYPOINT` must `exec "$@"`, and **linux/amd64 only**. Our node-agent image is a Go binary on Debian with an entrypoint that ignores `"$@"`, so it needs a Modal-specific layer. That is a real task here, not a footnote.

The exact SDK surface, read from `node_modules/modal/dist/index.d.ts` at 0.9.0 and used verbatim throughout this plan:

```ts
new ModalClient({ tokenId, tokenSecret })
client.apps.fromName(name, { createIfMissing: true })        // → Promise<App>
client.volumes.fromName(name, { createIfMissing: true })     // → Promise<Volume>
client.volumes.delete(name)                                  // → Promise<void>
client.images.fromRegistry(tag)                              // → Image  (NOT a promise)
client.sandboxes.create(app, image, params)                  // → Promise<Sandbox>
client.sandboxes.fromId(sandboxId)                           // → Promise<Sandbox>
sandbox.sandboxId; sandbox.terminate(); sandbox.poll()       // poll → number | null
// SandboxCreateParams keys used: cpu, memoryMiB, timeoutMs, workdir, command, env, volumes
// NotFoundError is exported from "modal"
```

## The four design questions, answered

The spec refused to let these be deferred. Each answer is implemented by a named task.

**1. What does `start` mean when there is no start verb?**
It means **provision again against the same Volume**, and it is the *hub's* job, not the driver's. The driver implements no `start()` — conformance rule 3 forbids one on a `terminal` driver, and a driver that accepted a start call would be reporting success for something that can never happen. Instead `startRuntime()` learns one manifest-driven branch: when `manifest.stopSemantics === "terminal"`, it calls `reprovisionRuntime()` — best-effort terminate the old sandbox, mint a fresh runtime-bound enrolment token, call `provision()` with the **same `runtimeId`**, and persist the new `externalId`. Because the volume name is derived from `runtimeId`, provisioning again re-attaches the same workspace. The console's existing Start button therefore works with no console change (Task 8).

**2. How is rotation triggered, and by whom?**
By the hub, on the sweeper's existing 15-second tick, in a new `sweepExpiringRuntimes()` alongside `sweepStalledRuntimeStarts`/`sweepStalledRuntimeStops` — the same idea one step further out: a runtime the *substrate* is about to kill. It is generic, driven by `manifest.maxLifetimeMs`, so no driver-specific code lands in the sweeper and any future capped substrate is covered. A runtime is rotated when `now - externalStartedAt >= maxLifetimeMs - ROTATION_MARGIN_MS` (30 minutes), and only in the live states `online` and `starting`. A `stopped`, `asleep`, `error` or `destroyed` runtime is **never** rotated — resurrecting a deliberately stopped Modal runtime would bill forever, which is the exact class of bug this project keeps paying for. Rotation is deliberately **age-based only**: it does not resurrect a sandbox that died early, because that turns a crash into a paid crash-loop with no human in it (Task 9).

**3. What does `status()` return for a sandbox that hit the 24-hour cap?**
`stopped` — and that is safe, because the driver's answer and the hub's word are different things. At the driver level `stopped` means exactly "this sandbox is not running", which is true. The hub never converts that into the runtime status `stopped` on its own: `sweepStalledRuntimeStops` only writes `stopped` for rows already in `stopping`, i.e. rows where an operator asked. An expired sandbox belongs to an `online` row, so the rotation sweeper reaches it first and moves it to `starting` with a `statusReason` naming the 24-hour ceiling. The word `stopped` is therefore never shown for something nobody stopped (Tasks 4 and 9).

**4. Does the enrolment token survive in the Volume — and if so what protects it?**
**No, and deliberately.** The Volume is mounted at `/workspace` and carries the workspace and nothing else. `HOME` stays on the disposable rootfs, so the node-agent's `config.json` (node id + node secret, written to `$HOME/.config/agentpod-node/`) dies with each sandbox, and the enrolment token exists only in one sandbox's env for one sandbox's lifetime. Every new sandbox gets a **freshly minted runtime-bound token**, and the hub's re-enrolment path resumes the same node with a rotated secret. Nothing protects a credential in the Volume because no credential is ever put there; the 24-hour ceiling therefore degrades from data loss to daily re-enrolment churn, and rotation rotates the node secret as a side effect (Tasks 8, 9 and 13).

## Global Constraints

- **Pin the SDK exactly:** `"modal": "0.9.0"` in `apps/hub/package.json` — no `^`, no `~`. The SDK is 0.x, renames parameters between releases and rejects unknown keys at runtime.
- **Never touch the real Modal API from a test.** Every unit test runs against a fake `ModalApi` or a fake `ModalClientLike`. A check that needs an API token runs nowhere, which is how the Cloudflare worker went a year without CI.
- **The fake must be faithful.** It throws for an unknown sandbox id and for deleting a volume that is already gone. A fake that tolerates everything makes every behavioural rule pass for free, which is the same as not having the rule.
- **Never log `spec.enrollToken`**, and never log a resolved credential. Add no log line that references either.
- **Never set `idleTimeoutMs`.** Modal's idle reaping is opt-in and off; opting in would recreate the inbound-activity trap that tore down live Cloudflare sandboxes on 2026-08-12.
- **Always set `timeoutMs`.** The default is 5 minutes.
- **`ENABLE_MODAL_PROVISIONING` requires no registry edit.** Do not add anything to `LEGACY_ENV_FLAGS`; the flag is derived from the provider name.
- TDD: failing test first, every time. Prove each guard is non-vacuous by breaking the implementation and watching the test fail.
- Never weaken an existing test to make a new one pass. This plan changes no Docker or Cloudflare behaviour; if one of their tests fails, the new code is wrong.
- Run the full suites **after the last edit**:
  `cd packages/contract && bun test`
  `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test`
  `cd apps/console && pnpm check && pnpm test && PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build`
- Hub tests require a **pgvector** postgres on `:5434` and the explicit `DATABASE_URL` override (bun auto-loads `apps/hub/.env`). See root `CLAUDE.md`.
- `bun run typecheck` in `apps/hub` is **known red** on pre-existing `stations.ts` errors. Do not fix those in passing; do check your new files produce no new errors.
- Branch: `modal-driver` off `main`. Single PR.

## File Structure

**`apps/hub` — new**
- `src/services/provisioner/modal.ts` — the driver: manifest, volume naming, external-id codec, provision/stop/status/destroy. Knows nothing about the SDK.
- `src/services/provisioner/modal.test.ts` — unit tests against a fake `ModalApi`.
- `src/services/provisioner/modal-api.ts` — the `ModalApi` port, `ModalNotFoundError`, and `createModalApi()`: the one file that imports `modal`.
- `src/services/provisioner/modal-api.test.ts` — adapter tests against a fake `ModalClientLike`.
- `src/db/drizzle-migrations/0034_runtime_external_started_at.sql` — one nullable column.
- `apps/node-agent/deploy/Dockerfile.modal`, `apps/node-agent/deploy/modal-entrypoint.sh` — the amd64, python-bearing image with no `ENTRYPOINT`.

**`apps/hub` — modified**
- `src/services/provisioner/conformance.test.ts` — the Modal driver joins the real-driver block.
- `src/services/runtimes.ts` — `reprovisionRuntime`, the terminal branch of `startRuntime`, `sweepExpiringRuntimes`, provider-scoped `imageForHarness`.
- `src/services/node-sweeper.ts` — one more call on the existing tick.
- `src/services/provisioner/bootstrap.ts` — register the driver when the flag is on.
- `src/db/schema/nodes.ts`, `src/db/drizzle-migrations/meta/_journal.json` — the new column.
- `src/utils/validate-config.ts`, `src/config.ts` — boot refusal for a half-configured Modal.
- `src/routes/runtimes.test.ts` — integration coverage for start-as-create and rotation.
- `docs/DEPLOYMENT.md`, `docs/OPERATING.md` — env block and operator guidance.

The driver/adapter split is not ceremony: `assertConforms` provisions and destroys for real, so a driver whose substrate cannot be injected can never be conformance-checked, and an SDK that renames a parameter every minor version must be reachable from exactly one file.

---

### Task 1: Driver skeleton — manifest, volume naming, external-id codec

The manifest is the whole point of the groundwork, and the codec is the design decision everything else rests on: the hub stores **one** string per runtime, and this driver needs two identifiers — the durable Volume and the disposable sandbox.

**Files:**
- Create: `apps/hub/src/services/provisioner/modal-api.ts`
- Create: `apps/hub/src/services/provisioner/modal.ts`
- Create: `apps/hub/src/services/provisioner/modal.test.ts`

**Interfaces:**
- Consumes: `DriverManifest`, `ProvisionSpec`, `ResourceTier`, `RuntimeState`, `RuntimeProvisioner` from `./types`.
- Produces:
  - `interface ModalApi` with `createSandbox(params: ModalCreateSandboxParams): Promise<{ sandboxId: string }>`, `terminateSandbox(sandboxId: string): Promise<void>`, `pollSandbox(sandboxId: string): Promise<number | null>`, `deleteVolume(name: string): Promise<void>`.
  - `type ModalCreateSandboxParams = { appName; image; volumeName; mountPath; workdir; command: string[]; env: Record<string,string>; cpu: number; memoryMiB: number; timeoutMs: number }`.
  - `class ModalNotFoundError extends Error` and `MODAL_CREDENTIAL_KEYS = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]`, both in `modal-api.ts` — the credential keys live beside the thing that needs them, and keeping them out of `modal.ts` means the driver imports the port and the port never imports the driver.
  - `class ModalRuntimeProvisioner implements RuntimeProvisioner`, constructed as `new ModalRuntimeProvisioner({ api, appName?, maxLifetimeMs? })`.
  - `volumeNameFor(runtimeId: string): string`, `encodeExternalId(volumeName: string, sandboxId: string): string`, `decodeExternalId(externalId: string): { volumeName: string; sandboxId: string }`.
  - `MODAL_MAX_LIFETIME_MS = 86_400_000`, `MODAL_WORKSPACE_PATH = "/workspace"`.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/src/services/provisioner/modal.test.ts`:

```ts
/**
 * Unit tests: ModalRuntimeProvisioner.
 *
 * No real Modal. The driver takes its substrate as a `ModalApi` port and every
 * test here injects a fake one — which is also what makes the conformance suite
 * runnable against this driver, since assertConforms really does provision and
 * destroy.
 */

import { describe, it, expect } from "bun:test";
import {
  ModalRuntimeProvisioner,
  volumeNameFor,
  encodeExternalId,
  decodeExternalId,
  MODAL_MAX_LIFETIME_MS,
} from "./modal";
import type { ModalApi } from "./modal-api";

/** A port that answers nothing — enough for declaration-only tests. */
const inertApi: ModalApi = {
  async createSandbox() {
    throw new Error("inert");
  },
  async terminateSandbox() {},
  async pollSandbox() {
    return null;
  },
  async deleteVolume() {},
};

const driver = () => new ModalRuntimeProvisioner({ api: inertApi });

describe("ModalRuntimeProvisioner — manifest", () => {
  it("declares what Modal actually is, not what would be convenient", () => {
    const m = driver().manifest;
    expect(m.provider).toBe("modal");
    // The workspace lives in a named Volume; the sandbox's rootfs is thrown
    // away on every recreation, and there are a lot of recreations.
    expect(m.workspaceStorage).toBe("volume");
    // terminate() cannot be undone. This is the field the spec calls THE field.
    expect(m.stopSemantics).toBe("terminal");
    // The measured platform ceiling: 24h, after which Modal destroys a healthy
    // sandbox with no warning and no way back.
    expect(m.maxLifetimeMs).toBe(86_400_000);
    expect(m.imageBinding).toBe("per-instance");
    expect(m.supportedTiers).toEqual(["small", "medium", "large"]);
    // idleTimeoutMs is opt-in and we never opt in, so nothing reaps a busy
    // station for looking idle — the Cloudflare trap does not exist here.
    expect(m.idleBehaviour).toBe("never");
  });

  it("declares NO start verb, because Modal has none", () => {
    const m = driver().manifest;
    expect(m.lifecycle).toEqual(["stop", "status"]);
    // Conformance rule 3 checks the method too: the hub reaches for start() by
    // presence, so an undeclared-but-present one would still be called.
    expect(driver().start).toBeUndefined();
  });

  it("clamps a configured lifetime to Modal's hard ceiling", () => {
    // The override exists so rotation can be verified in ten minutes instead of
    // a day, and so a future ceiling change is one env var. It must never claim
    // more than the platform allows: Modal rejects a longer timeoutMs outright,
    // which would break provisioning entirely rather than degrade it.
    const over = new ModalRuntimeProvisioner({ api: inertApi, maxLifetimeMs: 999_999_999 });
    expect(over.manifest.maxLifetimeMs).toBe(MODAL_MAX_LIFETIME_MS);
    const under = new ModalRuntimeProvisioner({ api: inertApi, maxLifetimeMs: 600_000 });
    expect(under.manifest.maxLifetimeMs).toBe(600_000);
  });
});

describe("volumeNameFor", () => {
  it("derives a stable Modal-legal name from the runtime id", () => {
    // Stability is the whole mechanism: this is what lets a brand-new sandbox
    // find the workspace of the sandbox it replaces.
    expect(volumeNameFor("rt_9f3cAB")).toBe("agentpod-rt-9f3cab");
    expect(volumeNameFor("rt_9f3cAB")).toBe(volumeNameFor("rt_9f3cAB"));
  });

  it("refuses a runtime id with nothing usable in it", () => {
    expect(() => volumeNameFor("___")).toThrow(/volume name/i);
  });
});

describe("external id codec", () => {
  it("round-trips the volume and the sandbox", () => {
    const id = encodeExternalId("agentpod-rt-abc", "sb-123");
    expect(decodeExternalId(id)).toEqual({
      volumeName: "agentpod-rt-abc",
      sandboxId: "sb-123",
    });
  });

  it("refuses a bare sandbox id", () => {
    // A driver that guessed here would delete the wrong volume, or none.
    expect(() => decodeExternalId("sb-123")).toThrow(/external id/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/modal.test.ts`
Expected: FAIL — cannot resolve `./modal`.

- [ ] **Step 3: Write the port**

Create `apps/hub/src/services/provisioner/modal-api.ts`:

```ts
/**
 * The narrow slice of Modal this driver needs, and the one place the SDK is
 * allowed to be imported (the adapter lands in Task 2).
 *
 * The SDK is 0.x and renames parameters between minor versions — `timeout`
 * became `timeoutMs`, and an unknown key is rejected at runtime by the SDK's own
 * guard rather than ignored. Confining it to one file means a rename costs one
 * edit and one test, not an audit of the driver.
 */

/** Everything Modal needs to start one sandbox for one AgentPod runtime. */
export interface ModalCreateSandboxParams {
  /** Modal App the sandbox is grouped under. Grouping only; carries no state. */
  appName: string;
  /** Registry reference Modal pulls. Must be linux/amd64 and carry python+pip. */
  image: string;
  /** The durable anchor: created if missing, reused by every later sandbox. */
  volumeName: string;
  /** Where the volume is mounted. The workspace, and nothing else, lives here. */
  mountPath: string;
  /** Working directory of the entrypoint command. */
  workdir: string;
  /** Entrypoint argv. The image sets no ENTRYPOINT — see Dockerfile.modal. */
  command: string[];
  /** Environment. Carries the enrolment token: NEVER log this object. */
  env: Record<string, string>;
  cpu: number;
  memoryMiB: number;
  /**
   * Maximum lifetime. Modal's default is FIVE MINUTES, so omitting it does not
   * mean "no limit", it means a station that dies before its operator returns
   * from coffee.
   */
  timeoutMs: number;
}

/**
 * A resource Modal says does not exist.
 *
 * Typed rather than message-matched: the driver has to tell "already gone,
 * which is what I wanted" from "the substrate is unreachable", and destroy
 * idempotency (conformance rule 6) hangs on getting that distinction right.
 */
export class ModalNotFoundError extends Error {}

/**
 * Credentials this substrate needs.
 *
 * Declared here rather than in modal.ts because the adapter is what consumes
 * them, and because the driver imports this file — a constant pointing the
 * other way would make the two modules import each other.
 */
export const MODAL_CREDENTIAL_KEYS = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];

/** The substrate, as this driver needs it. Implemented for real in Task 2. */
export interface ModalApi {
  createSandbox(params: ModalCreateSandboxParams): Promise<{ sandboxId: string }>;
  /** Irreversible. Modal has no start verb; this ends the sandbox for good. */
  terminateSandbox(sandboxId: string): Promise<void>;
  /** `null` while running, else the exit code. Throws ModalNotFoundError if forgotten. */
  pollSandbox(sandboxId: string): Promise<number | null>;
  /** Deletes the durable anchor. Throws ModalNotFoundError if already gone. */
  deleteVolume(name: string): Promise<void>;
}
```

- [ ] **Step 4: Write the driver skeleton**

Create `apps/hub/src/services/provisioner/modal.ts`:

```ts
/**
 * Modal sandbox provisioner driver.
 *
 * A Modal runtime is A ROLLING SERIES OF SANDBOXES ANCHORED BY A NAMED VOLUME.
 * That sentence is the design. Modal has no stop/start — `terminate` is
 * irreversible — and every sandbox is destroyed by the platform at 24 hours
 * whatever it is doing, so the sandbox cannot be the thing that persists. The
 * Volume is: it is named after the AgentPod runtime id, so a brand-new sandbox
 * finds the previous one's workspace by name (measured 2026-08-13; without this
 * fact Modal would not be usable at all).
 *
 * What is NOT in the Volume, on purpose: credentials. HOME stays on the
 * disposable rootfs, so the node-agent's config.json — node id and node secret
 * — dies with each sandbox, and every new sandbox enrols with a freshly minted
 * runtime-bound token. Nothing has to protect a secret at rest in shared storage
 * because nothing puts one there.
 *
 * SECURITY: spec.enrollToken is passed in the sandbox env and is never logged by
 * this module. Do not add a log statement that references it.
 */

import type {
  DriverManifest,
  ProvisionSpec,
  ResourceTier,
  RuntimeProvisioner,
  RuntimeState,
} from "./types";
import type { ModalApi } from "./modal-api";

/** Modal's hard ceiling on a sandbox's life. Not configurable by us. */
export const MODAL_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Where the anchoring Volume is mounted. The workspace, and only that. */
export const MODAL_WORKSPACE_PATH = "/workspace";

/**
 * Tier → sandbox sizing, matching the Docker driver's limits so "medium" means
 * the same thing to a user whichever substrate they picked.
 */
export const MODAL_RESOURCE_TIERS: Record<ResourceTier, { cpu: number; memoryMiB: number }> = {
  small: { cpu: 0.5, memoryMiB: 1024 },
  medium: { cpu: 1, memoryMiB: 2048 },
  large: { cpu: 2, memoryMiB: 4096 },
};

/** Separator for the composite external id. Legal in neither half. */
const EXTERNAL_ID_SEPARATOR = "#";

/**
 * The durable name for a runtime's Volume.
 *
 * Derived from the runtime id rather than stored anywhere, so provisioning again
 * for the same runtime re-attaches the same workspace with no extra bookkeeping
 * — that is what makes "start" implementable on a substrate with no start verb.
 */
export function volumeNameFor(runtimeId: string): string {
  const slug = runtimeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  if (!slug) {
    throw new Error(
      `modal: cannot derive a volume name from runtime id "${runtimeId}"`
    );
  }
  return `agentpod-${slug}`;
}

/**
 * The hub stores ONE string per runtime, and this driver needs two identifiers:
 * the Volume that persists and the sandbox that does not. Encoding both is what
 * lets a stateless driver, on a fresh hub process, destroy the right volume for
 * a sandbox it has never seen.
 */
export function encodeExternalId(volumeName: string, sandboxId: string): string {
  return `${volumeName}${EXTERNAL_ID_SEPARATOR}${sandboxId}`;
}

export function decodeExternalId(externalId: string): {
  volumeName: string;
  sandboxId: string;
} {
  const [volumeName, sandboxId, ...rest] = externalId.split(EXTERNAL_ID_SEPARATOR);
  if (!volumeName || !sandboxId || rest.length > 0) {
    throw new Error(
      `modal: malformed external id "${externalId}" — expected ` +
        `"<volume>${EXTERNAL_ID_SEPARATOR}<sandbox>"`
    );
  }
  return { volumeName, sandboxId };
}

export interface ModalProvisionerOptions {
  /** The substrate. Injected so tests and the conformance suite never call Modal. */
  api: ModalApi;
  /** Modal App the sandboxes are grouped under. Grouping only. */
  appName?: string;
  /**
   * Override for the platform ceiling, clamped to MODAL_MAX_LIFETIME_MS.
   *
   * Two honest uses: verifying rotation in ten minutes rather than a day, and
   * absorbing a future change to Modal's ceiling without a release. It can only
   * ever shorten — a longer timeoutMs is rejected by Modal outright.
   */
  maxLifetimeMs?: number;
}

export class ModalRuntimeProvisioner implements RuntimeProvisioner {
  readonly provider = "modal" as const;
  readonly supportedTiers: ResourceTier[] = ["small", "medium", "large"];
  readonly manifest: DriverManifest;

  private readonly api: ModalApi;
  private readonly appName: string;
  private readonly maxLifetimeMs: number;

  constructor({ api, appName, maxLifetimeMs }: ModalProvisionerOptions) {
    this.api = api;
    this.appName = appName ?? process.env.MODAL_APP_NAME ?? "agentpod";
    const requested =
      maxLifetimeMs ?? Number(process.env.MODAL_MAX_LIFETIME_MS) || MODAL_MAX_LIFETIME_MS;
    this.maxLifetimeMs = Math.min(requested, MODAL_MAX_LIFETIME_MS);

    this.manifest = {
      provider: "modal",
      // The rootfs is thrown away on every recreation and there are a lot of
      // recreations; the named Volume is the only thing that persists.
      workspaceStorage: "volume",
      // terminate() is irreversible and there is no start verb. Conformance
      // rule 3 turns this into a check that no start() exists on this class.
      stopSemantics: "terminal",
      // Measured: the platform destroys a healthy sandbox at this age, silently
      // and permanently. sweepExpiringRuntimes() rotates before it happens.
      maxLifetimeMs: this.maxLifetimeMs,
      // Modal pulls the registry reference per sandbox, so spec.image is real.
      imageBinding: "per-instance",
      supportedTiers: this.supportedTiers,
      // idleTimeoutMs is opt-in and we never set it, so nothing here mistakes an
      // outbound-only node-agent for an idle one.
      idleBehaviour: "never",
      // No "start": there is nothing to start. The hub restarts a terminal
      // runtime by provisioning again against the same Volume.
      lifecycle: ["stop", "status"],
    };
  }

  async provision(
    _spec: ProvisionSpec
  ): Promise<{ externalId: string; runtime?: string }> {
    throw new Error("modal: provision is implemented in Task 3");
  }

  async destroy(_externalId: string): Promise<void> {
    throw new Error("modal: destroy is implemented in Task 5");
  }

  async stop(_externalId: string): Promise<void> {
    throw new Error("modal: stop is implemented in Task 4");
  }

  async status(_externalId: string): Promise<RuntimeState> {
    throw new Error("modal: status is implemented in Task 4");
  }
}
```

- [ ] **Step 5: Run the test**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/modal.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/provisioner/modal.ts apps/hub/src/services/provisioner/modal-api.ts apps/hub/src/services/provisioner/modal.test.ts
git commit -m "feat(provisioner): Modal driver skeleton, manifest and volume anchor naming"
```

---

### Task 2: Credentials and the real SDK adapter

The tokens are needed by the SDK client, not by the driver's logic, so credential resolution belongs here — and putting it in the factory makes a missing key a **startup refusal that names both keys at once**, which is what `requireCredentials` exists for.

**Files:**
- Modify: `apps/hub/package.json` (add `"modal": "0.9.0"`)
- Modify: `apps/hub/src/services/provisioner/modal-api.ts`
- Create: `apps/hub/src/services/provisioner/modal-api.test.ts`

**Interfaces:**
- Consumes: `ModalApi`, `ModalCreateSandboxParams`, `ModalNotFoundError` (Task 1); `CredentialResolver`, `requireCredentials`, `envCredentialResolver` from `./credentials`.
- Produces: `interface ModalClientLike` (the structural slice of the SDK client used), and `createModalApi(opts?: { resolver?: CredentialResolver; clientFactory?: (c: { tokenId: string; tokenSecret: string }) => ModalClientLike }): ModalApi`.

- [ ] **Step 1: Pin the SDK**

```bash
cd apps/hub && bun add modal@0.9.0
```

Then open `apps/hub/package.json` and change the dependency to the exact string `"modal": "0.9.0"` — bun writes `^0.9.0` and a caret on a 0.x SDK that renames parameters is how a working hub stops provisioning after an unrelated `bun install`.

- [ ] **Step 2: Write the failing test**

Create `apps/hub/src/services/provisioner/modal-api.test.ts`:

```ts
/**
 * Unit tests: the Modal SDK adapter.
 *
 * The real `modal` package is never constructed here — clientFactory injects a
 * structural stand-in. What is under test is exactly the part that breaks when
 * the SDK churns: which parameter names we pass, and how a Modal NotFoundError
 * becomes something the driver can act on.
 */

import { describe, it, expect } from "bun:test";
import { createModalApi, ModalNotFoundError } from "./modal-api";
import type { ModalClientLike } from "./modal-api";

const CREDS = { MODAL_TOKEN_ID: "tok-id", MODAL_TOKEN_SECRET: "tok-secret" };
const resolverOf = (env: Record<string, string>) => ({ get: (k: string) => env[k] });

/** A NotFoundError shaped like the SDK's: same name, plain Error otherwise. */
class FakeNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

function fakeClient() {
  const calls = {
    apps: [] as Array<[string, unknown]>,
    volumes: [] as Array<[string, unknown]>,
    deleted: [] as string[],
    images: [] as string[],
    created: [] as unknown[],
    terminated: [] as string[],
  };
  const sandbox = {
    sandboxId: "sb-created",
    async terminate() {
      calls.terminated.push("sb-created");
    },
    async poll() {
      return null as number | null;
    },
  };
  const client: ModalClientLike = {
    apps: {
      async fromName(name, params) {
        calls.apps.push([name, params]);
        return { appId: "ap-1" };
      },
    },
    volumes: {
      async fromName(name, params) {
        calls.volumes.push([name, params]);
        return { volumeId: "vo-1" };
      },
      async delete(name) {
        if (name === "gone") throw new FakeNotFound(`Volume '${name}' not found`);
        calls.deleted.push(name);
      },
    },
    images: {
      fromRegistry(tag) {
        calls.images.push(tag);
        return { imageId: "im-1" };
      },
    },
    sandboxes: {
      async create(_app, _image, params) {
        calls.created.push(params);
        return sandbox;
      },
      async fromId(id) {
        if (id === "sb-gone") throw new FakeNotFound(`Sandbox '${id}' not found`);
        return sandbox;
      },
    },
  };
  return { client, calls };
}

const apiWith = (client: ModalClientLike) =>
  createModalApi({ resolver: resolverOf(CREDS), clientFactory: () => client });

describe("createModalApi — credentials", () => {
  it("refuses to build without credentials, naming every missing key at once", () => {
    // A startup refusal, not a runtime failure on a user's first provision —
    // and one that costs an operator one redeploy rather than one per key.
    expect(() => createModalApi({ resolver: resolverOf({}) })).toThrow(
      /MODAL_TOKEN_ID.*MODAL_TOKEN_SECRET/
    );
  });

  it("passes the resolved tokens to the client", () => {
    let seen: { tokenId: string; tokenSecret: string } | null = null;
    const { client } = fakeClient();
    createModalApi({
      resolver: resolverOf(CREDS),
      clientFactory: (c) => {
        seen = c;
        return client;
      },
    });
    expect(seen).toEqual({ tokenId: "tok-id", tokenSecret: "tok-secret" });
  });
});

describe("createModalApi — createSandbox", () => {
  it("creates the app and the volume if missing, and mounts the volume", async () => {
    const { client, calls } = fakeClient();
    const res = await apiWith(client).createSandbox({
      appName: "agentpod",
      image: "ghcr.io/example/agentpod-node-modal:v1",
      volumeName: "agentpod-rt-abc",
      mountPath: "/workspace",
      workdir: "/workspace",
      command: ["/modal-entrypoint.sh"],
      env: { AGENTPOD_HUB_URL: "https://hub.example" },
      cpu: 1,
      memoryMiB: 2048,
      timeoutMs: 86_400_000,
    });

    expect(res.sandboxId).toBe("sb-created");
    expect(calls.apps).toEqual([["agentpod", { createIfMissing: true }]]);
    // createIfMissing on the volume is what makes provisioning idempotent on the
    // anchor: the first sandbox creates it, every later one re-attaches it.
    expect(calls.volumes).toEqual([["agentpod-rt-abc", { createIfMissing: true }]]);
    expect(calls.images).toEqual(["ghcr.io/example/agentpod-node-modal:v1"]);

    const params = calls.created[0] as Record<string, unknown>;
    expect(params.volumes).toEqual({ "/workspace": { volumeId: "vo-1" } });
    expect(params.workdir).toBe("/workspace");
    expect(params.command).toEqual(["/modal-entrypoint.sh"]);
    expect(params.cpu).toBe(1);
    expect(params.memoryMiB).toBe(2048);
    // 0.9.0 renamed `timeout` to `timeoutMs` and REJECTS the old key at runtime.
    expect(params.timeoutMs).toBe(86_400_000);
    // Never opt into idle reaping: a node-agent dials out and receives nothing,
    // so an idle timer would reap a busy station. Off by default; keep it off.
    expect(params).not.toHaveProperty("idleTimeoutMs");
  });
});

describe("createModalApi — not-found mapping", () => {
  it("turns a Modal NotFoundError into ModalNotFoundError on poll", async () => {
    const { client } = fakeClient();
    await expect(apiWith(client).pollSandbox("sb-gone")).rejects.toBeInstanceOf(
      ModalNotFoundError
    );
  });

  it("turns a Modal NotFoundError into ModalNotFoundError on volume delete", async () => {
    // destroy() has to tell "already gone, which is what I wanted" from "the
    // substrate is unreachable", and conformance rule 6 fails the driver if it
    // gets that wrong.
    const { client } = fakeClient();
    await expect(apiWith(client).deleteVolume("gone")).rejects.toBeInstanceOf(
      ModalNotFoundError
    );
  });

  it("does NOT swallow an unrelated failure", async () => {
    const { client } = fakeClient();
    client.volumes.delete = async () => {
      throw new Error("connection reset");
    };
    const err = await apiWith(client)
      .deleteVolume("agentpod-rt-abc")
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(ModalNotFoundError);
    expect(String(err.message)).toContain("connection reset");
  });
});

describe("createModalApi — poll", () => {
  it("passes the exit code through untouched", async () => {
    const { client } = fakeClient();
    const api = apiWith(client);
    expect(await api.pollSandbox("sb-created")).toBeNull();
    client.sandboxes.fromId = async () => ({
      sandboxId: "sb-created",
      async terminate() {},
      async poll() {
        return 137;
      },
    });
    expect(await api.pollSandbox("sb-created")).toBe(137);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/modal-api.test.ts`
Expected: FAIL — `createModalApi` is not exported.

- [ ] **Step 4: Implement the adapter**

Append to `apps/hub/src/services/provisioner/modal-api.ts`:

```ts
import { requireCredentials, envCredentialResolver } from "./credentials";
import type { CredentialResolver } from "./credentials";

/**
 * The slice of the SDK client this adapter uses, described structurally.
 *
 * Structural rather than `typeof ModalClient` on purpose: it documents exactly
 * what we depend on (four calls), and it lets the tests inject a stand-in
 * without constructing a real client or reaching the network.
 */
export interface ModalClientLike {
  apps: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<unknown>;
  };
  volumes: {
    fromName(name: string, params: { createIfMissing: boolean }): Promise<unknown>;
    delete(name: string): Promise<void>;
  };
  images: {
    /** Synchronous in 0.9.0 — it returns an Image, not a Promise. */
    fromRegistry(tag: string): unknown;
  };
  sandboxes: {
    create(app: unknown, image: unknown, params: Record<string, unknown>): Promise<ModalSandboxLike>;
    fromId(sandboxId: string): Promise<ModalSandboxLike>;
  };
}

export interface ModalSandboxLike {
  readonly sandboxId: string;
  terminate(): Promise<void>;
  /** `null` while running, else the exit code. */
  poll(): Promise<number | null>;
}

export interface CreateModalApiOptions {
  resolver?: CredentialResolver;
  clientFactory?: (creds: { tokenId: string; tokenSecret: string }) => ModalClientLike;
}

/**
 * Modal reports a missing resource with an exported `NotFoundError`. Matching on
 * the constructor NAME rather than importing the class keeps this adapter's
 * tests free of the SDK and survives the dual CJS/ESM builds shipping two
 * distinct class objects for the same error.
 */
function isNotFound(err: unknown): boolean {
  return (err as { name?: string })?.name === "NotFoundError";
}

async function mappingNotFound<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isNotFound(err)) {
      throw new ModalNotFoundError((err as Error).message);
    }
    throw err;
  }
}

/**
 * Build the real Modal-backed `ModalApi`.
 *
 * Credentials are resolved HERE, at construction, so a hub configured with
 * ENABLE_MODAL_PROVISIONING=true and no tokens refuses at startup listing both
 * missing keys — rather than accepting a provisioning request and failing it
 * with something that reads like an auth problem.
 *
 * Note what these tokens are and are not: they create NEW infrastructure in a
 * Modal workspace. They cannot reach an enrolled node — enrolment is
 * outbound-dialled and SSH runs from the operator's machine. See credentials.ts.
 */
export function createModalApi({
  resolver = envCredentialResolver(),
  clientFactory,
}: CreateModalApiOptions = {}): ModalApi {
  const creds = requireCredentials("modal", MODAL_CREDENTIAL_KEYS, resolver);
  const build =
    clientFactory ??
    ((c: { tokenId: string; tokenSecret: string }) => {
      // The only import of the SDK in the codebase. Required lazily so a hub
      // with Modal disabled never loads it.
      const { ModalClient } = require("modal") as {
        ModalClient: new (params: { tokenId: string; tokenSecret: string }) => unknown;
      };
      return new ModalClient(c) as ModalClientLike;
    });

  const client = build({
    tokenId: creds.MODAL_TOKEN_ID!,
    tokenSecret: creds.MODAL_TOKEN_SECRET!,
  });

  return {
    async createSandbox(params: ModalCreateSandboxParams) {
      const app = await client.apps.fromName(params.appName, { createIfMissing: true });
      // createIfMissing is the anchor mechanism: the first sandbox for a runtime
      // creates the volume, every later one re-attaches the same data by name.
      const volume = await client.volumes.fromName(params.volumeName, {
        createIfMissing: true,
      });
      const image = client.images.fromRegistry(params.image);

      const sandbox = await mappingNotFound(() =>
        client.sandboxes.create(app, image, {
          command: params.command,
          env: params.env,
          volumes: { [params.mountPath]: volume },
          workdir: params.workdir,
          cpu: params.cpu,
          memoryMiB: params.memoryMiB,
          // Modal's default is 5 minutes. Deliberately no idleTimeoutMs: idle
          // reaping is opt-in and opting in would reap a busy station whose
          // agent only ever dials out.
          timeoutMs: params.timeoutMs,
        })
      );
      return { sandboxId: sandbox.sandboxId };
    },

    async terminateSandbox(sandboxId: string) {
      await mappingNotFound(async () => {
        const sandbox = await client.sandboxes.fromId(sandboxId);
        await sandbox.terminate();
      });
    },

    async pollSandbox(sandboxId: string) {
      return mappingNotFound(async () => {
        const sandbox = await client.sandboxes.fromId(sandboxId);
        return sandbox.poll();
      });
    },

    async deleteVolume(name: string) {
      await mappingNotFound(() => client.volumes.delete(name));
    },
  };
}
```

- [ ] **Step 5: Run the test**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/modal-api.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Confirm the pinned SDK's parameter names still match**

Run: `cd apps/hub && grep -n "cpu?\|memoryMiB?\|timeoutMs?\|workdir?\|idleTimeoutMs?" node_modules/modal/dist/index.d.ts | head -20`
Expected: every key the adapter passes appears in `SandboxCreateParams`. If a name differs, **the `.d.ts` wins** — fix the adapter and its test, and note the rename in the commit message. This is a two-minute check that prevents a class of failure the SDK reports only at runtime.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/package.json apps/hub/bun.lock apps/hub/src/services/provisioner/modal-api.ts apps/hub/src/services/provisioner/modal-api.test.ts
git commit -m "feat(provisioner): Modal SDK adapter, pinned at 0.9.0, with credential refusal at build time"
```

---

### Task 3: Volume-anchored provisioning

**Files:**
- Modify: `apps/hub/src/services/provisioner/modal.ts`
- Modify: `apps/hub/src/services/provisioner/modal.test.ts`

**Interfaces:**
- Consumes: `ModalApi` (Task 1), `volumeNameFor`, `encodeExternalId`, `MODAL_RESOURCE_TIERS`, `MODAL_WORKSPACE_PATH`.
- Produces: `provision(spec)` resolving to `{ externalId: "<volume>#<sandbox>", runtime: "modal-sandbox" }`; exported `fakeModalApi()` is **not** produced — the fake lives in the test file.

- [ ] **Step 1: Write the failing test**

Add to `apps/hub/src/services/provisioner/modal.test.ts` — the fake first, at the top of the file after the imports (replacing nothing; `inertApi` stays for the declaration tests):

```ts
import { ModalNotFoundError } from "./modal-api";
import type { ModalCreateSandboxParams } from "./modal-api";
import type { ProvisionSpec } from "./types";

/**
 * A faithful fake Modal.
 *
 * Faithful means unfriendly where Modal is unfriendly: an unknown sandbox id
 * and a second delete of the same volume both raise ModalNotFoundError. A
 * lenient fake would make destroy idempotency (conformance rule 6) pass for
 * free, which is the same as not checking it.
 */
function fakeModal() {
  const created: ModalCreateSandboxParams[] = [];
  const terminated: string[] = [];
  const deletedVolumes: string[] = [];
  /** sandboxId → exit code; null means still running. */
  const sandboxes = new Map<string, number | null>();
  const volumes = new Set<string>();
  let counter = 0;

  const api: ModalApi = {
    async createSandbox(params) {
      created.push(params);
      volumes.add(params.volumeName);
      const sandboxId = `sb-${++counter}`;
      sandboxes.set(sandboxId, null);
      return { sandboxId };
    },
    async terminateSandbox(sandboxId) {
      if (!sandboxes.has(sandboxId)) {
        throw new ModalNotFoundError(`Sandbox '${sandboxId}' not found`);
      }
      terminated.push(sandboxId);
      // Modal retains a terminated sandbox and reports its exit code.
      sandboxes.set(sandboxId, 137);
    },
    async pollSandbox(sandboxId) {
      if (!sandboxes.has(sandboxId)) {
        throw new ModalNotFoundError(`Sandbox '${sandboxId}' not found`);
      }
      return sandboxes.get(sandboxId)!;
    },
    async deleteVolume(name) {
      if (!volumes.has(name)) {
        throw new ModalNotFoundError(`Volume '${name}' not found`);
      }
      volumes.delete(name);
      deletedVolumes.push(name);
    },
  };

  return { api, created, terminated, deletedVolumes, sandboxes, volumes };
}

const SPEC: ProvisionSpec = {
  runtimeId: "rt_abc123",
  name: "modal-box",
  resourceTier: "medium",
  hubUrl: "https://hub.example",
  enrollToken: "enr_secret",
  image: "ghcr.io/example/agentpod-node-modal:v1",
};
```

Then append these tests:

```ts
describe("ModalRuntimeProvisioner — provision", () => {
  it("anchors the workspace in a volume named after the RUNTIME, not the sandbox", async () => {
    const modal = fakeModal();
    const res = await new ModalRuntimeProvisioner({ api: modal.api }).provision(SPEC);

    expect(modal.created[0]!.volumeName).toBe("agentpod-rt-abc123");
    expect(modal.created[0]!.mountPath).toBe("/workspace");
    // The composite id: the hub stores one string, and this driver needs both
    // the volume that survives and the sandbox that does not.
    expect(res.externalId).toBe("agentpod-rt-abc123#sb-1");
    expect(res.runtime).toBe("modal-sandbox");
  });

  it("re-attaches the SAME volume when the same runtime is provisioned again", async () => {
    // This is the whole design: a Modal runtime is a rolling series of
    // sandboxes anchored by one Volume, and "start" is a create.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const first = await driver.provision(SPEC);
    const second = await driver.provision(SPEC);

    expect(modal.created[1]!.volumeName).toBe(modal.created[0]!.volumeName);
    expect(second.externalId).not.toBe(first.externalId);
  });

  it("injects the hub url and the enrolment token, and sets no idle timer", async () => {
    const modal = fakeModal();
    await new ModalRuntimeProvisioner({ api: modal.api }).provision(SPEC);
    const params = modal.created[0]!;
    expect(params.env.AGENTPOD_HUB_URL).toBe("https://hub.example");
    expect(params.env.AGENTPOD_ENROLL_TOKEN).toBe("enr_secret");
    expect(params.command).toEqual(["/modal-entrypoint.sh"]);
    expect(params.workdir).toBe("/workspace");
  });

  it("sets the sandbox timeout to the declared ceiling", async () => {
    // Modal's default is five minutes. A station that dies in five minutes is
    // not a station, and nothing in the API warns you.
    const modal = fakeModal();
    await new ModalRuntimeProvisioner({ api: modal.api }).provision(SPEC);
    expect(modal.created[0]!.timeoutMs).toBe(86_400_000);
  });

  it("honours the resource tier instead of quietly rounding it", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision({ ...SPEC, resourceTier: "small" });
    await driver.provision({ ...SPEC, runtimeId: "rt_two", resourceTier: "large" });
    expect(modal.created[0]).toMatchObject({ cpu: 0.5, memoryMiB: 1024 });
    expect(modal.created[1]).toMatchObject({ cpu: 2, memoryMiB: 4096 });
  });

  it("refuses an image Modal could never pull, naming it", async () => {
    // agentpod-node:local is the DEFAULT for a Docker-first hub and is
    // meaningless to Modal, which pulls from a registry. Failing here with the
    // image named beats a sandbox that never boots and a runtime that sits in
    // `provisioning` until the sweeper gives up.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(
      driver.provision({ ...SPEC, image: "agentpod-node:local" })
    ).rejects.toThrow(/agentpod-node:local/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/modal.test.ts`
Expected: FAIL — "modal: provision is implemented in Task 3".

- [ ] **Step 3: Implement provision**

In `apps/hub/src/services/provisioner/modal.ts`, add the entrypoint constant next to the other constants:

```ts
/**
 * The sandbox's main process.
 *
 * Passed as a COMMAND, not baked as an ENTRYPOINT: Modal requires any image
 * ENTRYPOINT to `exec "$@"`, and our node-agent entrypoint does not — it enrols
 * and then execs its own run loop. Dockerfile.modal clears ENTRYPOINT and this
 * supplies the command instead. See Task 13.
 */
export const MODAL_ENTRYPOINT = ["/modal-entrypoint.sh"];
```

and replace the `provision` stub with:

```ts
  async provision(spec: ProvisionSpec): Promise<{ externalId: string; runtime?: string }> {
    // Modal pulls from a registry. A bare local tag — which is the default a
    // Docker-first hub hands out — produces a sandbox that never boots and a
    // runtime that sits in `provisioning` until the sweeper expires it, with
    // nothing anywhere naming the cause.
    if (!spec.image.includes("/")) {
      throw new Error(
        `modal: image "${spec.image}" is not a registry reference Modal can pull ` +
          `(no registry host). Push a linux/amd64 image and set ` +
          `NODE_AGENT_MODAL_IMAGE — see docs/DEPLOYMENT.md.`
      );
    }

    const tier = MODAL_RESOURCE_TIERS[spec.resourceTier];
    if (!tier) {
      throw new Error(`modal: unsupported resource tier "${spec.resourceTier}"`);
    }

    const volumeName = volumeNameFor(spec.runtimeId);
    const { sandboxId } = await this.api.createSandbox({
      appName: this.appName,
      image: spec.image,
      // Created if missing, re-attached if not: the same runtime id always
      // reaches the same workspace, which is what makes a rolling series of
      // sandboxes look like one durable runtime.
      volumeName,
      mountPath: MODAL_WORKSPACE_PATH,
      workdir: MODAL_WORKSPACE_PATH,
      command: MODAL_ENTRYPOINT,
      // The token lives here and only here — never in the Volume, never in a
      // log. Each sandbox enrols with a freshly minted one.
      env: {
        AGENTPOD_HUB_URL: spec.hubUrl,
        AGENTPOD_ENROLL_TOKEN: spec.enrollToken,
      },
      cpu: tier.cpu,
      memoryMiB: tier.memoryMiB,
      timeoutMs: this.maxLifetimeMs,
    });

    return { externalId: encodeExternalId(volumeName, sandboxId), runtime: "modal-sandbox" };
  }
```

- [ ] **Step 4: Run the test**

Expected: PASS (13 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/modal.ts apps/hub/src/services/provisioner/modal.test.ts
git commit -m "feat(provisioner): Modal provisioning anchored by a named Volume"
```

---

### Task 4: `stop()` is terminate, `status()` is a poll

**Files:**
- Modify: `apps/hub/src/services/provisioner/modal.ts`
- Modify: `apps/hub/src/services/provisioner/modal.test.ts`

**Interfaces:**
- Consumes: `decodeExternalId`, `ModalNotFoundError`.
- Produces: `stop(externalId): Promise<void>`, `status(externalId): Promise<RuntimeState>`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/modal.test.ts`:

```ts
describe("ModalRuntimeProvisioner — stop", () => {
  it("terminates the sandbox in the composite id", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.stop(externalId);
    expect(modal.terminated).toEqual(["sb-1"]);
  });

  it("does NOT delete the volume — stopping must not destroy the workspace", async () => {
    // The Volume is the runtime's identity. A stop that took it would make
    // every stop a destroy, which is the Cloudflare data loss in a new costume.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.stop(externalId);
    expect(modal.deletedVolumes).toEqual([]);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);
  });

  it("treats an already-gone sandbox as stopped rather than an error", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(driver.stop("agentpod-rt-abc123#sb-never")).resolves.toBeUndefined();
  });
});

describe("ModalRuntimeProvisioner — status", () => {
  it("reports running while poll() has no exit code", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    expect(await driver.status(externalId)).toBe("running");
  });

  it("reports stopped once the sandbox has an exit code", async () => {
    // Including the 24-hour-ceiling case: at the driver level `stopped` means
    // exactly "this sandbox is not running", which is true however it ended.
    // Nothing here turns that into the hub's word `stopped` — only
    // sweepStalledRuntimeStops does, and only for a runtime someone asked to
    // stop. An expired sandbox belongs to an `online` row, which the rotation
    // sweeper reaches first.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.stop(externalId);
    expect(await driver.status(externalId)).toBe("stopped");
  });

  it("says unknown — never stopped — for a sandbox Modal has forgotten", async () => {
    // `stopped` is read by an operator as "it has stopped costing me money".
    // A sandbox the substrate cannot find is not evidence of that.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    expect(await driver.status("agentpod-rt-abc123#sb-never")).toBe("unknown");
  });

  it("propagates a transport failure instead of inventing an answer", async () => {
    const modal = fakeModal();
    modal.api.pollSandbox = async () => {
      throw new Error("connection reset");
    };
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    // probeState() in runtimes.ts logs it and degrades to `unknown`; guessing
    // here would hide a broken substrate behind a confident answer.
    await expect(driver.status("agentpod-rt-abc123#sb-1")).rejects.toThrow(/connection reset/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Expected: FAIL — "modal: stop is implemented in Task 4".

- [ ] **Step 3: Implement**

In `modal.ts`, import `ModalNotFoundError` (`import { ModalNotFoundError } from "./modal-api";`) and replace both stubs:

```ts
  /**
   * Terminate the sandbox. IRREVERSIBLE — Modal has no start verb.
   *
   * The Volume is deliberately untouched: it is the runtime's identity, and the
   * hub restarts a terminal runtime by provisioning a new sandbox against it
   * (see reprovisionRuntime in ../runtimes.ts).
   */
  async stop(externalId: string): Promise<void> {
    const { sandboxId } = decodeExternalId(externalId);
    try {
      await this.api.terminateSandbox(sandboxId);
    } catch (err) {
      // Already gone is the state the caller asked for. Anything else is real.
      if (err instanceof ModalNotFoundError) return;
      throw err;
    }
  }

  /**
   * Ask Modal whether this sandbox is still running.
   *
   * `poll()` answers `null` while running and an exit code once finished, so
   * there is no third state to invent — and no need to. A sandbox Modal has
   * forgotten is `unknown`, never `stopped`: the hub turns `stopped` into a
   * claim an operator reads as "it has stopped costing me money", and a missing
   * record is not evidence of that.
   */
  async status(externalId: string): Promise<RuntimeState> {
    const { sandboxId } = decodeExternalId(externalId);
    try {
      const exitCode = await this.api.pollSandbox(sandboxId);
      return exitCode === null ? "running" : "stopped";
    } catch (err) {
      if (err instanceof ModalNotFoundError) return "unknown";
      throw err;
    }
  }
```

- [ ] **Step 4: Run the test**

Expected: PASS (21 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/modal.ts apps/hub/src/services/provisioner/modal.test.ts
git commit -m "feat(provisioner): Modal stop terminates, status polls, neither guesses"
```

---

### Task 5: `destroy()` — terminate the sandbox AND delete the Volume, idempotently

Destroy is the one verb where forgetting the Volume costs money forever: a deleted runtime whose Volume survives keeps billing storage with nothing in the console to show for it.

**Files:**
- Modify: `apps/hub/src/services/provisioner/modal.ts`
- Modify: `apps/hub/src/services/provisioner/modal.test.ts`

**Interfaces:**
- Produces: `destroy(externalId): Promise<void>` — tolerant of anything already gone.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/services/provisioner/modal.test.ts`:

```ts
describe("ModalRuntimeProvisioner — destroy", () => {
  it("takes the sandbox AND the volume", async () => {
    // A surviving volume is a bill with no console row to explain it.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.destroy(externalId);
    expect(modal.terminated).toEqual(["sb-1"]);
    expect(modal.deletedVolumes).toEqual(["agentpod-rt-abc123"]);
  });

  it("is idempotent — a second destroy resolves", async () => {
    // destroyRuntime() turns a driver throw into a 502 and leaves the row
    // un-destroyed, so the retry that should finish a half-done destroy would
    // wedge the runtime instead. Conformance rule 6.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.destroy(externalId);
    await expect(driver.destroy(externalId)).resolves.toBeUndefined();
  });

  it("still deletes the volume when the sandbox is already gone", async () => {
    // The likeliest half-done destroy on this substrate: the 24-hour ceiling
    // already took the sandbox and the volume is all that is left.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.sandboxes.delete("sb-1");
    await driver.destroy(externalId);
    expect(modal.deletedVolumes).toEqual(["agentpod-rt-abc123"]);
  });

  it("does NOT swallow a substrate failure", async () => {
    // Tolerating "already gone" must not become tolerating everything: a
    // destroy that silently failed would leave a runtime billing behind a row
    // that says destroyed.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.api.deleteVolume = async () => {
      throw new Error("connection reset");
    };
    await expect(driver.destroy(externalId)).rejects.toThrow(/connection reset/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Expected: FAIL — "modal: destroy is implemented in Task 5".

- [ ] **Step 3: Implement**

Replace the `destroy` stub in `modal.ts`:

```ts
  /**
   * Permanently remove the runtime: the sandbox, then the Volume that outlives
   * sandboxes.
   *
   * Both steps tolerate "already gone" and nothing else. The order matters —
   * deleting a Volume still mounted by a live sandbox is a race Modal is under
   * no obligation to make pleasant.
   */
  async destroy(externalId: string): Promise<void> {
    const { volumeName, sandboxId } = decodeExternalId(externalId);

    try {
      await this.api.terminateSandbox(sandboxId);
    } catch (err) {
      if (!(err instanceof ModalNotFoundError)) throw err;
    }

    try {
      await this.api.deleteVolume(volumeName);
    } catch (err) {
      if (!(err instanceof ModalNotFoundError)) throw err;
    }
  }
```

- [ ] **Step 4: Run the test**

Expected: PASS (25 tests in the file).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/modal.ts apps/hub/src/services/provisioner/modal.test.ts
git commit -m "feat(provisioner): Modal destroy removes the sandbox and its Volume, idempotently"
```

---

### Task 6: Conformance — the declarations are checked against the behaviour

**Files:**
- Modify: `apps/hub/src/services/provisioner/conformance.test.ts`

**Interfaces:**
- Consumes: `assertConforms` from `./conformance`; `ModalRuntimeProvisioner`; the fake Modal substrate (duplicated into this file — the two test files must not import each other's helpers).

- [ ] **Step 1: Write the failing test**

In `apps/hub/src/services/provisioner/conformance.test.ts`, add the import beside the existing driver imports:

```ts
import { ModalRuntimeProvisioner } from "./modal";
import { ModalNotFoundError } from "./modal-api";
import type { ModalApi } from "./modal-api";
```

Add this fake substrate after `FakeDockerSubstrate` (a self-contained copy: this file must stay runnable on its own, and a shared helper would let one test's leniency weaken another's rule):

```ts
// ─── A fake Modal substrate ───────────────────────────────────────────────────

/**
 * Faithful stand-in for Modal: an unknown sandbox id and a repeat volume delete
 * both raise ModalNotFoundError, exactly as the adapter maps them. A lenient
 * fake here would make destroy idempotency pass for free.
 */
function fakeModalApi(): ModalApi {
  const sandboxes = new Map<string, number | null>();
  const volumes = new Set<string>();
  let counter = 0;
  return {
    async createSandbox(params) {
      volumes.add(params.volumeName);
      const sandboxId = `sb-${++counter}`;
      sandboxes.set(sandboxId, null);
      return { sandboxId };
    },
    async terminateSandbox(sandboxId) {
      if (!sandboxes.has(sandboxId)) {
        throw new ModalNotFoundError(`Sandbox '${sandboxId}' not found`);
      }
      sandboxes.set(sandboxId, 137);
    },
    async pollSandbox(sandboxId) {
      if (!sandboxes.has(sandboxId)) {
        throw new ModalNotFoundError(`Sandbox '${sandboxId}' not found`);
      }
      return sandboxes.get(sandboxId)!;
    },
    async deleteVolume(name) {
      if (!volumes.has(name)) {
        throw new ModalNotFoundError(`Volume '${name}' not found`);
      }
      volumes.delete(name);
    },
  };
}

const modalDriver = () => new ModalRuntimeProvisioner({ api: fakeModalApi() });
```

Add to the `describe("assertConforms — the real drivers", ...)` block:

```ts
  it("holds the real Modal driver to every declaration", async () => {
    // The point of the whole registry-groundwork exercise: Modal's constraints
    // — terminal stop, a 24h ceiling, no start verb — are the hardest test of
    // whether the manifest generalises. Reaching the end of a fail-fast suite
    // is itself the proof that imageBinding, supportedTiers, stopSemantics,
    // status and destroy idempotency all held.
    //
    // Note the probe image: it carries a registry host, which the driver
    // requires and which a local tag like `agentpod-node:local` lacks.
    await expect(
      assertConforms(modalDriver(), { image: "agentpod.invalid/conformance-probe:v0" })
    ).resolves.toBeUndefined();
  });

  it("REFUSES a Modal driver that grew a start() method", async () => {
    // stopSemantics "terminal" means terminate cannot be undone. The hub reaches
    // for start() by method presence, so a well-meaning start() added later
    // would have the hub reporting success for something that can never happen.
    const driver = modalDriver() as unknown as { start?: (id: string) => Promise<void> };
    driver.start = async () => {};
    await expect(
      assertConforms(driver as never, { image: "agentpod.invalid/conformance-probe:v0" })
    ).rejects.toThrow(/stopSemantics/i);
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/conformance.test.ts`
Expected: FAIL — cannot resolve `./modal` symbols until the imports are in place; then both new tests must pass. If the first one fails on a rule, **the driver is wrong, not the suite** — read the violated field in the error message and fix the driver.

- [ ] **Step 3: Make it pass**

No new production code should be needed. If `assertConforms` reports `supportedTiers`, check that `MODAL_RESOURCE_TIERS` covers exactly the three declared tiers. If it reports `imageBinding`, check that the registry-host refusal names the image it refuses (rule 1 requires the message to contain it) and that the suite's `DIFFERING_IMAGE` — which does carry a host — is accepted, since `per-instance` must not refuse for image reasons.

- [ ] **Step 4: Run the whole provisioner suite**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/conformance.test.ts
git commit -m "test(provisioner): Modal driver passes the conformance suite"
```

---

### Task 7: Record when the current sandbox started

Rotation needs the age of the **sandbox**, and `provisioned_runtimes.created_at` is the age of the runtime, which after the first rotation is a different number entirely.

**Files:**
- Modify: `apps/hub/src/db/schema/nodes.ts`
- Create: `apps/hub/src/db/drizzle-migrations/0034_runtime_external_started_at.sql`
- Modify: `apps/hub/src/db/drizzle-migrations/meta/_journal.json`
- Modify: `apps/hub/src/services/runtimes.ts`
- Modify: `apps/hub/src/routes/runtimes.test.ts`

**Interfaces:**
- Produces: `provisionedRuntimes.externalStartedAt` (nullable `timestamp`, column `external_started_at`), written wherever an `externalId` is written.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/routes/runtimes.test.ts` (inside the existing top-level test list, matching its style):

```ts
test("provisioning records when the sandbox started, not only when the row was made", async () => {
  // Rotation asks "how old is the CURRENT sandbox". After the first rotation
  // that is a different question from "how old is this runtime", and answering
  // with created_at would rotate a fresh sandbox every tick, for ever.
  const res = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "docker", name: "aged", resourceTier: "small" }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };

  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  expect(row!.externalStartedAt).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/runtimes.test.ts`
Expected: FAIL — `externalStartedAt` does not exist.

- [ ] **Step 3: Add the column**

In `apps/hub/src/db/schema/nodes.ts`, inside `provisionedRuntimes`, after the `runtime` column:

```ts
  // When the CURRENT external instance started, which on a substrate that
  // rotates instances is not created_at. Null for rows that predate this column
  // and for a runtime that has never had an instance.
  externalStartedAt: timestamp("external_started_at"),
```

Create `apps/hub/src/db/drizzle-migrations/0034_runtime_external_started_at.sql`:

```sql
ALTER TABLE "provisioned_runtimes" ADD COLUMN "external_started_at" timestamp;
```

Append to the `entries` array in `apps/hub/src/db/drizzle-migrations/meta/_journal.json`, after the `0033_runtime_stopping_status` entry (mind the comma on the previous entry):

```json
    {
      "idx": 34,
      "version": "7",
      "when": 1786620000000,
      "tag": "0034_runtime_external_started_at",
      "breakpoints": true
    }
```

- [ ] **Step 4: Write it on provision**

In `apps/hub/src/services/runtimes.ts`, in `createRuntime`, change the update that persists the externalId:

```ts
    await db
      .update(provisionedRuntimes)
      .set({
        externalId,
        runtime: runtime ?? null,
        // The clock starts when the substrate accepted the instance. Every
        // later write of externalId must set this too, or a rotated runtime
        // keeps the age of the sandbox it replaced.
        externalStartedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, id));
```

- [ ] **Step 5: Run the test**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/runtimes.test.ts`
Expected: PASS. Migrations auto-apply on boot; the test helper `ensurePgMigrations` applies them for the suite.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/db/schema/nodes.ts apps/hub/src/db/drizzle-migrations/ apps/hub/src/services/runtimes.ts apps/hub/src/routes/runtimes.test.ts
git commit -m "feat(runtimes): record when the current external instance started"
```

---

### Task 8: Start means create, for any driver whose stop is terminal

**Files:**
- Modify: `apps/hub/src/services/runtimes.ts`
- Modify: `apps/hub/src/routes/runtimes.test.ts`

**Interfaces:**
- Consumes: `getProvisionerUnguarded`, `mintEnrollmentToken`, `imageForHarness`, `RuntimeRow`.
- Produces: `reprovisionRuntime(row: RuntimeRow, reason: string): Promise<void>` (exported), and a terminal branch inside `startRuntime` that calls it instead of throwing 400.

- [ ] **Step 1: Write the failing test**

Add a second fake provisioner and two tests to `apps/hub/src/routes/runtimes.test.ts`. Put the fake next to `fakeDockerProvisioner`:

```ts
/**
 * A terminal-stop driver, the shape Modal forces: no start(), because there is
 * nothing to start, and a provision() that re-attaches the same anchor when
 * handed the same runtimeId.
 */
const terminalCalls: { provision: ProvisionSpec[]; stop: string[] } = {
  provision: [],
  stop: [],
};
let terminalCounter = 0;

const fakeTerminalProvisioner: RuntimeProvisioner = {
  provider: "modal",
  manifest: {
    provider: "modal",
    workspaceStorage: "volume",
    stopSemantics: "terminal",
    maxLifetimeMs: 86_400_000,
    imageBinding: "per-instance",
    supportedTiers: ["small", "medium", "large"],
    idleBehaviour: "never",
    lifecycle: ["stop", "status"],
  },
  async provision(spec) {
    terminalCalls.provision.push(spec);
    return { externalId: `anchor-${spec.runtimeId}#sb-${++terminalCounter}` };
  },
  async destroy() {},
  async stop(externalId) {
    terminalCalls.stop.push(externalId);
  },
  async status() {
    return "running";
  },
  // Deliberately NO start(): conformance rule 3 forbids one on a terminal
  // driver, and this is the case startRuntime has to handle without it.
};
```

Add two lines beside the existing `ENABLE_DOCKER_PROVISIONING` assignment at the top of the file, in the env block that runs **before any `src/` import**:

```ts
process.env.ENABLE_MODAL_PROVISIONING = "true";
// reprovisionRuntime runs without a request, so it takes the hub URL from
// config rather than from an origin. Unset, every re-create throws.
process.env.PROVISIONING_HUB_URL = "https://hub.test";
```

Register the fake wherever `fakeDockerProvisioner` is registered.

Then the tests:

```ts
test("starting a terminal-stop runtime creates a NEW instance against the same anchor", async () => {
  // Modal has no start verb — terminate is irreversible. The honest answer is
  // not a 400 forever: it is that a restart on such a substrate IS a create,
  // against the Volume that carries the workspace.
  const created = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "modal", name: "rolling", resourceTier: "small" }),
  });
  const { id } = (await created.json()) as { id: string };
  const [before] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));

  const res = await app.request(`/api/runtimes/${id}/start`, {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER },
  });
  expect(res.status).toBe(200);

  const [after] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  // A new sandbox, the same runtime id — so the same volume anchor.
  expect(after!.externalId).not.toBe(before!.externalId);
  expect(terminalCalls.provision.at(-1)!.runtimeId).toBe(id);
  // `starting`, never `online`: the substrate accepting a create is not a node
  // existing. Only enrolment writes online.
  expect(after!.status).toBe("starting");
  expect(after!.externalStartedAt!.getTime()).toBeGreaterThanOrEqual(
    before!.externalStartedAt!.getTime()
  );
});

test("re-creating mints a fresh enrolment token, because the old one is not in the hub", async () => {
  // The hub stores only a hash, so it cannot re-inject the token it minted. It
  // mints another bound to the same runtime; enrollNode resumes the same node
  // with a rotated secret (PR #252). Nothing is kept in the Volume — the
  // node-agent's config lives on the disposable rootfs on purpose.
  const created = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "modal", name: "tokens", resourceTier: "small" }),
  });
  const { id } = (await created.json()) as { id: string };
  const firstToken = terminalCalls.provision.at(-1)!.enrollToken;

  await app.request(`/api/runtimes/${id}/start`, {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER },
  });

  const secondToken = terminalCalls.provision.at(-1)!.enrollToken;
  expect(secondToken).not.toBe(firstToken);

  const tokenRows = await db
    .select()
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.provisionedRuntimeId, id));
  expect(tokenRows.length).toBe(2);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/runtimes.test.ts`
Expected: FAIL — the start route returns 400 (`provider modal does not support start`).

- [ ] **Step 3: Implement `reprovisionRuntime`**

In `apps/hub/src/services/runtimes.ts`, add above `startRuntime`:

```ts
/**
 * The hub URL a provisioned container should dial.
 *
 * Request-scoped for createRuntime, but rotation runs on a timer with no
 * request in sight, so it has to come from configuration there.
 */
function provisioningHubUrl(): string {
  const url = process.env.PROVISIONING_HUB_URL;
  if (!url) {
    throw new Error(
      "PROVISIONING_HUB_URL is not set, so a runtime cannot be re-created — " +
        "the new container would have no hub to enrol against"
    );
  }
  return url;
}

/**
 * Re-create a runtime's instance on a substrate whose stop is terminal.
 *
 * This is what "start" means when there is no start verb. Modal's terminate
 * cannot be undone and every restart is a new sandbox with a new id and a fresh
 * rootfs — so the thing that persists is the driver's anchor, and a driver
 * anchors by `spec.runtimeId`. Provisioning again with the SAME runtimeId
 * therefore re-attaches the same workspace.
 *
 * Two things must happen alongside the create, and both are easy to forget:
 *
 *  - The old instance is terminated first, best effort. Leaving it behind is
 *    a sandbox nobody is watching and everybody is paying for.
 *  - A FRESH enrolment token is minted. The hub stores only a hash, so it
 *    cannot re-present the original; a new runtime-bound token is durable by
 *    default (RUNTIME_TOKEN_TTL_MS) and enrollNode resumes the existing node
 *    with a rotated secret rather than orphaning it.
 *
 * Leaves the runtime `starting` — never `online`. The substrate accepting a
 * create is not a node existing, and sweepStalledRuntimeStarts walks it back to
 * `error` if none arrives.
 */
export async function reprovisionRuntime(
  row: RuntimeRow,
  reason: string
): Promise<void> {
  const provisioner = getProvisionerUnguarded(row.provider);
  if (!provisioner) {
    throw Object.assign(new Error(`provider not available: ${row.provider}`), {
      status: 502,
    });
  }

  const hubUrl = provisioningHubUrl();

  if (row.externalId && provisioner.stop) {
    try {
      await provisioner.stop(row.externalId);
    } catch (err) {
      // Best effort by design: the old instance may already be gone (that is
      // the common case for the 24h ceiling), and refusing to create a
      // replacement because the corpse would not die again helps nobody.
      console.warn(
        `[runtimes] ${row.id}: could not terminate the previous instance: ${(err as Error).message}`
      );
    }
  }

  const { token } = await mintEnrollmentToken(row.userId, {
    provisionedRuntimeId: row.id,
  });

  const { externalId, runtime } = await provisioner.provision({
    runtimeId: row.id,
    name: row.name,
    resourceTier: row.resourceTier as "small" | "medium" | "large",
    hubUrl,
    enrollToken: token,
    // One argument today; Task 12 makes image resolution provider-aware and
    // updates this call and createRuntime's together.
    image: imageForHarness(row.harness ?? "none"),
  });

  await db
    .update(provisionedRuntimes)
    .set({
      externalId,
      runtime: runtime ?? row.runtime ?? null,
      externalStartedAt: new Date(),
      status: "starting",
      statusReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(provisionedRuntimes.id, row.id));
}
```

Then, in `startRuntime`, replace the unsupported-start guard:

```ts
  // A driver whose stop is terminal has no start to call — Modal's terminate is
  // irreversible — so a restart on such a substrate IS a create, against the
  // anchor that carries the workspace. This is manifest-driven rather than
  // provider-specific: any future terminal substrate gets it for free.
  if (!provisioner.start) {
    if (provisioner.manifest.stopSemantics === "terminal") {
      await reprovisionRuntime(row, "re-created: this substrate has no start, so a start is a new instance");
      return;
    }
    throw Object.assign(
      new Error(`provider ${row.provider} does not support start`),
      { status: 400 }
    );
  }
```

- [ ] **Step 4: Run the test**

Expected: PASS. The existing test "POST /api/runtimes/:id/stop on a driver with no stop → 400" must still pass — that fake declares `stopSemantics: "resumable"`, so it keeps the 400.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/runtimes.ts apps/hub/src/routes/runtimes.test.ts
git commit -m "feat(runtimes): start means re-create on a terminal-stop substrate"
```

---

### Task 9: Rotate before the platform kills the sandbox

**Files:**
- Modify: `apps/hub/src/services/runtimes.ts`
- Modify: `apps/hub/src/services/node-sweeper.ts`
- Modify: `apps/hub/src/routes/runtimes.test.ts`

**Interfaces:**
- Consumes: `reprovisionRuntime` (Task 8), `providerManifests`/`getProvisionerUnguarded`, `externalStartedAt` (Task 7).
- Produces: `ROTATION_MARGIN_MS = 30 * 60_000`, `sweepExpiringRuntimes(now?: number): Promise<string[]>` returning the rotated runtime ids.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/routes/runtimes.test.ts`:

```ts
test("rotates a runtime before the substrate's ceiling destroys it", async () => {
  // Modal destroys a healthy sandbox at 24h with no warning and no way back.
  // Nothing in the API rotates for you, so the hub does it — early enough that
  // the replacement is enrolled before the platform takes the original.
  const created = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "modal", name: "ages", resourceTier: "small" }),
  });
  const { id } = (await created.json()) as { id: string };
  await db
    .update(provisionedRuntimes)
    .set({ status: "online" })
    .where(eq(provisionedRuntimes.id, id));
  const [before] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));

  const justInsideTheMargin =
    before!.externalStartedAt!.getTime() + 86_400_000 - ROTATION_MARGIN_MS + 1_000;
  const rotated = await sweepExpiringRuntimes(justInsideTheMargin);

  expect(rotated).toContain(id);
  const [after] = await db
    .select()
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.id, id));
  expect(after!.externalId).not.toBe(before!.externalId);
  expect(after!.status).toBe("starting");
  // The operator has to be able to tell this from a failure they caused.
  expect(after!.statusReason).toMatch(/24|ceiling|lifetime/i);
});

test("does not rotate a young sandbox", async () => {
  const created = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "modal", name: "young", resourceTier: "small" }),
  });
  const { id } = (await created.json()) as { id: string };
  await db
    .update(provisionedRuntimes)
    .set({ status: "online" })
    .where(eq(provisionedRuntimes.id, id));

  expect(await sweepExpiringRuntimes(Date.now() + 60_000)).not.toContain(id);
});

test("NEVER rotates a runtime that was deliberately stopped", async () => {
  // The expensive mistake this guard prevents: resurrecting a stopped runtime
  // creates a sandbox nobody asked for and bills wall-clock for it until
  // somebody notices. `asleep`, `error` and `destroyed` are excluded for the
  // same reason — only `online` and `starting` are live.
  const created = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "modal", name: "stopped", resourceTier: "small" }),
  });
  const { id } = (await created.json()) as { id: string };
  await db
    .update(provisionedRuntimes)
    .set({ status: "stopped" })
    .where(eq(provisionedRuntimes.id, id));

  const rotated = await sweepExpiringRuntimes(Date.now() + 86_400_000);
  expect(rotated).not.toContain(id);
});

test("ignores a substrate with no ceiling", async () => {
  // Docker declares maxLifetimeMs: null. Nothing destroys its container for
  // age, and rotating one would throw away a perfectly good workspace.
  const created = await app.request("/api/runtimes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-User-Id": TEST_USER },
    body: JSON.stringify({ provider: "docker", name: "eternal", resourceTier: "small" }),
  });
  const { id } = (await created.json()) as { id: string };
  await db
    .update(provisionedRuntimes)
    .set({ status: "online" })
    .where(eq(provisionedRuntimes.id, id));

  expect(await sweepExpiringRuntimes(Date.now() + 10 * 86_400_000)).not.toContain(id);
});
```

Extend the file's import from `../services/runtimes` with `sweepExpiringRuntimes` and `ROTATION_MARGIN_MS`.

- [ ] **Step 2: Run and confirm failure**

Expected: FAIL — `sweepExpiringRuntimes` is not exported.

- [ ] **Step 3: Implement the sweeper**

Append to `apps/hub/src/services/runtimes.ts`:

```ts
/**
 * How long before a substrate's ceiling a runtime is rotated.
 *
 * Long enough for a full re-create and re-enrolment (a node enrols within
 * seconds; START_TIMEOUT_MS allows two minutes) with room for a retry on the
 * next 15s tick if the first attempt fails, and short enough that a rotation is
 * a rare event rather than a routine tax on a runtime's life.
 */
export const ROTATION_MARGIN_MS = 30 * 60_000;

/**
 * Rotate runtimes the substrate is about to destroy for age.
 *
 * The third sweep on the same tick, and the same idea one step further out:
 * sweepStalledRuntimeStarts handles a runtime that never arrived,
 * sweepStalledRuntimeStops one that would not leave, and this one a runtime the
 * PLATFORM is about to kill while it is working perfectly.
 *
 * Modal is why it exists — a hard 24-hour sandbox lifetime, no warning
 * callback, no way to extend, and no way back afterwards. It is written against
 * `manifest.maxLifetimeMs` rather than against Modal, so nothing here knows
 * which substrate it is saving.
 *
 * Deliberately narrow:
 *   - Only `online` and `starting`. A `stopped` or `asleep` runtime must NEVER
 *     be rotated: re-creating one bills wall-clock for a sandbox nobody asked
 *     for, and on this substrate that is the single most expensive mistake
 *     available. `error` is excluded too — a human is already needed there.
 *   - Only rows with an externalId and an externalStartedAt. Without the second
 *     there is no age to judge, and guessing from created_at would rotate a
 *     fresh sandbox on every tick after the first rotation.
 *   - AGE ONLY. A sandbox that died early is not rotated, because that turns a
 *     crash into a paid crash-loop with nobody in it. The node going offline
 *     already surfaces that, and Start is one click.
 *   - Every write is a compare-and-set on the status we read, so an operator
 *     stopping a runtime mid-sweep wins.
 *
 * @param now injectable clock for tests.
 * @returns the ids actually rotated.
 */
export async function sweepExpiringRuntimes(
  now: number = Date.now()
): Promise<string[]> {
  const live = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(
        inArray(provisionedRuntimes.status, ["online", "starting"]),
        isNotNull(provisionedRuntimes.externalId),
        isNotNull(provisionedRuntimes.externalStartedAt)
      )
    );

  const rotated: string[] = [];

  for (const row of live) {
    const provisioner = getProvisionerUnguarded(row.provider);
    const ceiling = provisioner?.manifest.maxLifetimeMs ?? null;
    if (!ceiling) continue;

    const age = now - row.externalStartedAt!.getTime();
    if (age < ceiling - ROTATION_MARGIN_MS) continue;

    // Claim the row first. The status write is the lock: a concurrent stop or a
    // second sweeper tick finds it already `provisioning` and moves on.
    const claimed = await db
      .update(provisionedRuntimes)
      .set({ status: "provisioning", updatedAt: new Date(now) })
      .where(
        and(
          eq(provisionedRuntimes.id, row.id),
          eq(provisionedRuntimes.status, row.status)
        )
      )
      .returning({ id: provisionedRuntimes.id });
    if (claimed.length === 0) continue;

    try {
      await reprovisionRuntime(
        row,
        `re-created before this substrate's ${humanMs(ceiling)} instance lifetime ` +
          `ceiling destroyed it — the workspace is anchored outside the instance ` +
          `and carries over`
      );
      rotated.push(row.id);
      console.log(`[runtime-sweeper] ${row.id} rotated ahead of the ${humanMs(ceiling)} ceiling`);
    } catch (err) {
      await db
        .update(provisionedRuntimes)
        .set({
          status: "error",
          statusReason:
            `could not re-create this runtime before its ${humanMs(ceiling)} ` +
            `lifetime ceiling: ${(err as Error).message}`,
          updatedAt: new Date(now),
        })
        .where(eq(provisionedRuntimes.id, row.id));
      console.error(`[runtime-sweeper] ${row.id} rotation failed: ${(err as Error).message}`);
    }
  }

  return rotated;
}
```

- [ ] **Step 4: Wire it into the tick**

In `apps/hub/src/services/node-sweeper.ts`, extend the import and the interval:

```ts
import {
  sweepStalledRuntimeStarts,
  sweepStalledRuntimeStops,
  sweepExpiringRuntimes,
} from "./runtimes";
```

```ts
    // And the one nobody asked for: a runtime the SUBSTRATE is about to destroy
    // for age. Modal's sandboxes die at 24 hours however healthy they are, with
    // no warning, so the hub replaces them before that lands.
    void sweepExpiringRuntimes().catch((err) =>
      console.error("[sweeper] runtime rotation sweep failed:", err)
    );
```

Update the block comment above `startNodeSweeper` from "Three expiries" to "Four expiries", naming this one.

- [ ] **Step 5: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/runtimes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/runtimes.ts apps/hub/src/services/node-sweeper.ts apps/hub/src/routes/runtimes.test.ts
git commit -m "feat(runtimes): rotate instances before a substrate's lifetime ceiling destroys them"
```

---

### Task 10: Register the driver when the flag is on

**Files:**
- Modify: `apps/hub/src/services/provisioner/bootstrap.ts`
- Create: `apps/hub/src/services/provisioner/bootstrap.test.ts`

**Interfaces:**
- Consumes: `isProviderEnabled`, `registerProvisioner`, `ModalRuntimeProvisioner`, `createModalApi`.
- Produces: `registerEnabledProvisioners()` registers `modal` when `ENABLE_MODAL_PROVISIONING=true`.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/src/services/provisioner/bootstrap.test.ts`:

```ts
/**
 * The wiring test.
 *
 * Registration is the step that has no other test: a driver can be perfect and
 * still be absent from the registry, in which case createRuntime answers
 * "provider not registered" and an operator reads it as a missing feature.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { registerEnabledProvisioners } from "./bootstrap";
import { getProvisionerUnguarded, resetProvisioners } from "./registry";

afterEach(() => {
  resetProvisioners();
  delete process.env.ENABLE_MODAL_PROVISIONING;
  delete process.env.MODAL_TOKEN_ID;
  delete process.env.MODAL_TOKEN_SECRET;
});

describe("registerEnabledProvisioners — modal", () => {
  it("registers nothing for modal when the flag is off", () => {
    registerEnabledProvisioners();
    expect(getProvisionerUnguarded("modal")).toBeUndefined();
  });

  it("registers the driver when the flag is on and credentials exist", () => {
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    process.env.MODAL_TOKEN_ID = "tok-id";
    process.env.MODAL_TOKEN_SECRET = "tok-secret";
    registerEnabledProvisioners();
    const driver = getProvisionerUnguarded("modal");
    expect(driver?.manifest.stopSemantics).toBe("terminal");
    expect(driver?.manifest.maxLifetimeMs).toBe(86_400_000);
  });

  it("refuses to boot when the flag is on and the credentials are missing", () => {
    // Startup refusal, not a runtime failure on somebody's first provision —
    // and it names both keys so a misconfigured deploy is one fix, not two.
    process.env.ENABLE_MODAL_PROVISIONING = "true";
    expect(() => registerEnabledProvisioners()).toThrow(
      /MODAL_TOKEN_ID.*MODAL_TOKEN_SECRET/
    );
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/provisioner/bootstrap.test.ts`
Expected: FAIL — nothing registers `modal`.

- [ ] **Step 3: Implement**

In `apps/hub/src/services/provisioner/bootstrap.ts`, add the imports and the branch at the end of `registerEnabledProvisioners`:

```ts
import { ModalRuntimeProvisioner } from "./modal";
import { createModalApi } from "./modal-api";
```

```ts
  if (isProviderEnabled("modal")) {
    // createModalApi resolves MODAL_TOKEN_ID/MODAL_TOKEN_SECRET and throws
    // naming any that are missing, so a half-configured deploy fails at boot
    // rather than on a user's first provisioning attempt. No touch hook: Modal
    // reaps nothing for idleness (idleTimeoutMs is opt-in and we never opt in),
    // so there is no deadline to push out.
    registerProvisioner(new ModalRuntimeProvisioner({ api: createModalApi() }));
  }
```

- [ ] **Step 4: Run the test**

Expected: PASS. If constructing the real `ModalClient` fails in the "credentials exist" case (the SDK validating a token shape), inject a client factory via `createModalApi({ clientFactory })` in the test rather than weakening the production path — the SDK is not supposed to reach the network at construction, and if it does, that is a finding worth a comment.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/provisioner/bootstrap.ts apps/hub/src/services/provisioner/bootstrap.test.ts
git commit -m "feat(provisioner): register the Modal driver behind ENABLE_MODAL_PROVISIONING"
```

---

### Task 11: Refuse to boot half-configured

**Files:**
- Modify: `apps/hub/src/config.ts`
- Modify: `apps/hub/src/utils/validate-config.ts`
- Modify: `apps/hub/src/utils/validate-config.test.ts`

**Interfaces:**
- Consumes: `collectConfigErrors(cfg, warn)`.
- Produces: `config.modal = { enabled, tokenId, tokenSecret, image, appName }`, and boot errors for `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `NODE_AGENT_MODAL_IMAGE`, `PROVISIONING_HUB_URL`.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/utils/validate-config.test.ts` (follow the file's existing helper style, which builds a config object and filters errors by field):

```ts
// ─── Modal ────────────────────────────────────────────────────────────────────

const withModal = (
  over: Partial<typeof config.modal>,
  provisioningHubUrl = "https://hub.example"
) =>
  ({
    ...config,
    modal: { ...config.modal, ...over },
    provisioningHubUrl,
  }) as typeof config;

const fieldsFor = (cfg: typeof config) =>
  collectConfigErrors(cfg, quiet).map((e) => e.field);

const CONFIGURED = {
  enabled: true,
  tokenId: "tok-id",
  tokenSecret: "tok-secret",
  image: "ghcr.io/example/agentpod-node-modal:v1",
} as const;

describe("validateConfig — modal", () => {
  it("accepts a fully configured Modal hub", () => {
    const fields = fieldsFor(withModal(CONFIGURED));
    expect(fields).not.toContain("MODAL_TOKEN_ID");
    expect(fields).not.toContain("MODAL_TOKEN_SECRET");
    expect(fields).not.toContain("NODE_AGENT_MODAL_IMAGE");
    expect(fields).not.toContain("PROVISIONING_HUB_URL");
  });

  it("requires both tokens, reported together", () => {
    const fields = fieldsFor(withModal({ ...CONFIGURED, tokenId: "", tokenSecret: "" }));
    expect(fields).toContain("MODAL_TOKEN_ID");
    expect(fields).toContain("MODAL_TOKEN_SECRET");
  });

  it("requires a registry image Modal can actually pull", () => {
    // The Docker-first default is `agentpod-node:local`, which Modal cannot
    // pull. Unset or local, the runtime provisions "successfully" and then
    // never produces a node — a two-minute wait ending in a sweeper message
    // that names nothing.
    expect(fieldsFor(withModal({ ...CONFIGURED, image: "" }))).toContain(
      "NODE_AGENT_MODAL_IMAGE"
    );
    expect(
      fieldsFor(withModal({ ...CONFIGURED, image: "agentpod-node:local" }))
    ).toContain("NODE_AGENT_MODAL_IMAGE");
  });

  it("requires PROVISIONING_HUB_URL, because rotation runs without a request", () => {
    // A rotating substrate re-creates instances on a timer. With no request to
    // take an origin from, an unset value would turn every 24h rotation into an
    // error — a day after anyone was watching.
    expect(fieldsFor(withModal(CONFIGURED, ""))).toContain("PROVISIONING_HUB_URL");
  });

  it("leaves a hub with Modal disabled alone", () => {
    // Conditional for the same reason as the Cloudflare rule above: a hub that
    // never registers this driver must not need its variables to boot.
    const fields = fieldsFor(
      withModal({ enabled: false, tokenId: "", tokenSecret: "", image: "" }, "")
    );
    expect(fields).not.toContain("MODAL_TOKEN_ID");
    expect(fields).not.toContain("NODE_AGENT_MODAL_IMAGE");
    expect(fields).not.toContain("PROVISIONING_HUB_URL");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/utils/validate-config.test.ts`
Expected: FAIL — no modal rules exist.

- [ ] **Step 3: Add the config surface**

In `apps/hub/src/config.ts`, after the `cloudflare` block:

```ts
  modal: {
    enabled: getEnvBool('ENABLE_MODAL_PROVISIONING', false),
    // Workspace-wide on Modal's Starter plan: per-resource scoping needs the
    // $250/mo Team plan. Use a Modal workspace dedicated to AgentPod.
    tokenId: getEnv('MODAL_TOKEN_ID', ''),
    tokenSecret: getEnv('MODAL_TOKEN_SECRET', ''),
    // Modal pulls from a registry and runs linux/amd64 only, so the local tags
    // a Docker-first hub uses are meaningless to it.
    image: getEnv('NODE_AGENT_MODAL_IMAGE', ''),
    appName: getEnv('MODAL_APP_NAME', 'agentpod'),
  },

  // Hub URL a provisioned container dials to enrol. Request-scoped for a
  // console-initiated create, but a rotating substrate re-creates instances on
  // a timer with no request in sight — so it must be configured.
  provisioningHubUrl: getEnv('PROVISIONING_HUB_URL', ''),
```

- [ ] **Step 4: Add the rules**

In `apps/hub/src/utils/validate-config.ts`, after the Cloudflare rule:

```ts
  // Conditional for the same reason as the Cloudflare rule above: a hub that
  // never talks to Modal must not be stopped from booting by Modal's variables.
  if (cfg.modal.enabled) {
    if (!cfg.modal.tokenId) {
      errors.push({
        field: "MODAL_TOKEN_ID",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true. Create it in the Modal " +
          "dashboard. Note: on Modal's Starter plan a token is WORKSPACE-WIDE — " +
          "per-resource scoping needs the $250/mo Team plan — so use a workspace " +
          "dedicated to AgentPod.",
      });
    }
    if (!cfg.modal.tokenSecret) {
      errors.push({
        field: "MODAL_TOKEN_SECRET",
        message: "Required when ENABLE_MODAL_PROVISIONING=true, alongside MODAL_TOKEN_ID.",
      });
    }
    if (!cfg.modal.image || !cfg.modal.image.includes("/")) {
      errors.push({
        field: "NODE_AGENT_MODAL_IMAGE",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true, and it must be a registry " +
          "reference Modal can pull (linux/amd64, carrying python and pip). The " +
          "Docker default `agentpod-node:local` is meaningless to Modal: the sandbox " +
          "never boots and the runtime sits in `provisioning` until it is expired. " +
          "See docs/DEPLOYMENT.md.",
      });
    }
    if (!cfg.provisioningHubUrl) {
      errors.push({
        field: "PROVISIONING_HUB_URL",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true: Modal destroys a sandbox at " +
          "24 hours, so the hub re-creates it on a timer with no request to take an " +
          "origin from. Unset, every rotation fails a day after anyone was watching.",
      });
    }
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/utils/validate-config.test.ts src/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/config.ts apps/hub/src/utils/validate-config.ts apps/hub/src/utils/validate-config.test.ts
git commit -m "feat(hub): refuse to boot with Modal enabled and half configured"
```

---

### Task 12: Provider-scoped image resolution

A hub with Docker and Modal both enabled needs two different image references for the same harness: a local tag for Docker, a registry reference for Modal. Today `imageForHarness` knows only the harness, so one of the two is always wrong.

**Files:**
- Modify: `apps/hub/src/services/runtimes.ts`
- Create: `apps/hub/src/services/runtimes-image.test.ts`

**Interfaces:**
- Produces: exported `imageForHarness(harness: string, provider: string): string`, resolving `NODE_AGENT_<PROVIDER>_<HARNESS>_IMAGE` → `NODE_AGENT_<HARNESS>_IMAGE` → the built-in default.

- [ ] **Step 1: Write the failing test**

Create `apps/hub/src/services/runtimes-image.test.ts`:

```ts
/**
 * Image resolution is service-layer work: drivers are image-agnostic and always
 * use ProvisionSpec.image. It becomes provider-aware here because two enabled
 * substrates need different references for the SAME harness — Docker a local
 * tag, Modal a registry reference it can pull.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";

import { describe, it, expect, afterEach } from "bun:test";
import { imageForHarness } from "./runtimes";

const KEYS = [
  "NODE_AGENT_IMAGE",
  "NODE_AGENT_OPENCODE_IMAGE",
  "NODE_AGENT_MODAL_IMAGE",
  "NODE_AGENT_MODAL_OPENCODE_IMAGE",
];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("imageForHarness", () => {
  it("keeps today's behaviour for a provider with no override", () => {
    // The regression guard: Docker and Cloudflare must resolve exactly what
    // they resolved before this change.
    expect(imageForHarness("none", "docker")).toBe("agentpod-node:local");
    expect(imageForHarness("opencode", "docker")).toBe("agentpod-node-opencode:local");
    process.env.NODE_AGENT_IMAGE = "custom:tag";
    expect(imageForHarness("none", "docker")).toBe("custom:tag");
  });

  it("prefers a provider-scoped override", () => {
    process.env.NODE_AGENT_IMAGE = "agentpod-node:local";
    process.env.NODE_AGENT_MODAL_IMAGE = "ghcr.io/example/agentpod-node-modal:v1";
    expect(imageForHarness("none", "modal")).toBe("ghcr.io/example/agentpod-node-modal:v1");
    expect(imageForHarness("none", "docker")).toBe("agentpod-node:local");
  });

  it("scopes per harness as well as per provider", () => {
    process.env.NODE_AGENT_MODAL_OPENCODE_IMAGE = "ghcr.io/example/agentpod-node-modal-oc:v1";
    expect(imageForHarness("opencode", "modal")).toBe(
      "ghcr.io/example/agentpod-node-modal-oc:v1"
    );
  });

  it("falls back to the harness-wide value when the provider has no override", () => {
    process.env.NODE_AGENT_OPENCODE_IMAGE = "agentpod-node-opencode:local";
    expect(imageForHarness("opencode", "modal")).toBe("agentpod-node-opencode:local");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/runtimes-image.test.ts`
Expected: FAIL — `imageForHarness` is not exported and takes one argument.

- [ ] **Step 3: Implement**

Replace `imageForHarness` in `apps/hub/src/services/runtimes.ts`:

```ts
/**
 * Resolve the container image for a harness on a given provider.
 *
 * Image resolution lives in the service layer so drivers stay image-agnostic —
 * they always use ProvisionSpec.image and never read env themselves.
 *
 * It is provider-scoped because two enabled substrates need different
 * references for the same harness: Docker runs `agentpod-node-opencode:local`
 * from the host daemon, while Modal pulls from a registry and runs linux/amd64
 * only. One variable cannot serve both, and the failure mode when it tries is
 * silent — a sandbox that never boots.
 *
 * Resolution order, first hit wins:
 *   NODE_AGENT_<PROVIDER>_<HARNESS>_IMAGE   e.g. NODE_AGENT_MODAL_OPENCODE_IMAGE
 *   NODE_AGENT_<HARNESS>_IMAGE              e.g. NODE_AGENT_OPENCODE_IMAGE
 *   the built-in local default
 *
 * With no provider-scoped variable set, this resolves exactly what it resolved
 * before — Docker and Cloudflare are unchanged.
 */
export function imageForHarness(harness: string, provider: string): string {
  const suffix =
    harness === "opencode" ? "_OPENCODE" : harness === "pi" ? "_PI" : "";
  const scope = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const fallback =
    suffix === "_OPENCODE"
      ? "agentpod-node-opencode:local"
      : suffix === "_PI"
        ? "agentpod-node-pi:local"
        : "agentpod-node:local";

  return (
    process.env[`NODE_AGENT_${scope}${suffix}_IMAGE`] ||
    process.env[`NODE_AGENT${suffix}_IMAGE`] ||
    fallback
  );
}
```

Update both call sites to pass the provider: in `createRuntime`, `image: imageForHarness(harness, provider)`; in `reprovisionRuntime`, `image: imageForHarness(row.harness ?? "none", row.provider)`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/runtimes-image.test.ts src/routes/runtimes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/runtimes.ts apps/hub/src/services/runtimes-image.test.ts
git commit -m "feat(runtimes): provider-scoped image resolution"
```

---

### Task 13: The Modal image — python, pip, no entrypoint, amd64

Modal will not run our existing image. Three separate requirements, each fatal on its own: the image must carry python and pip, any `ENTRYPOINT` must `exec "$@"` (ours enrols and then execs its own loop, ignoring `"$@"` entirely), and only linux/amd64 is supported.

**Files:**
- Create: `apps/node-agent/deploy/Dockerfile.modal`
- Create: `apps/node-agent/deploy/modal-entrypoint.sh`

**Interfaces:**
- Consumes: `agentpod-node:base` (built from `Dockerfile.base`), `MODAL_ENTRYPOINT = ["/modal-entrypoint.sh"]` and `MODAL_WORKSPACE_PATH = "/workspace"` from Task 1/3.
- Produces: an image tag pushed to a registry, referenced by `NODE_AGENT_MODAL_IMAGE`.

- [ ] **Step 1: Write the entrypoint script**

Create `apps/node-agent/deploy/modal-entrypoint.sh`:

```sh
#!/bin/sh
set -e

# The sandbox's main process on Modal.
#
# Passed as the sandbox COMMAND, not baked as an image ENTRYPOINT: Modal
# requires any ENTRYPOINT to end in `exec "$@"` so it can wrap the container's
# command, and this script does not — it enrols and then execs the node-agent's
# own run loop. Dockerfile.modal clears ENTRYPOINT for exactly that reason.
#
# The workspace is a Modal Volume mounted here by the driver. It is the ONLY
# thing that survives a sandbox, and every sandbox is destroyed at 24 hours, so
# anything written elsewhere is written in sand.
#
# HOME deliberately stays on the disposable rootfs: the node-agent's config.json
# holds the node id and node secret, and putting a credential in shared,
# long-lived storage would need protecting. Instead every sandbox enrols afresh
# with the runtime-bound token in AGENTPOD_ENROLL_TOKEN, and the hub resumes the
# same node with a rotated secret.
cd /workspace || exit 1

# Enroll reads AGENTPOD_HUB_URL and AGENTPOD_ENROLL_TOKEN from the environment.
/agentpod-node enroll

exec /agentpod-node run
```

- [ ] **Step 2: Write the Dockerfile**

Create `apps/node-agent/deploy/Dockerfile.modal`:

```dockerfile
# syntax=docker/dockerfile:1

# node-agent image for the Modal provisioner.
#
# Three things Modal requires that our other images do not provide, each fatal
# on its own:
#
#   1. python3 and pip must be present in the image. Modal's sandbox tooling
#      relies on them; an image without them does not boot, and the failure
#      surfaces as a sandbox that simply never enrols.
#   2. Any ENTRYPOINT must end in `exec "$@"`. The base image's
#      /node-entrypoint.sh does not — it enrols and then execs its own run loop,
#      ignoring "$@" — so this image clears ENTRYPOINT and the driver passes
#      /modal-entrypoint.sh as the sandbox COMMAND instead.
#   3. linux/amd64 only. Build with --platform, especially on an Apple Silicon
#      machine, where the default build is arm64 and Modal rejects it.
#
# Build and push (the tag becomes NODE_AGENT_MODAL_IMAGE):
#
#   docker build -f apps/node-agent/deploy/Dockerfile.base -t agentpod-node:base apps/node-agent
#   docker buildx build --platform linux/amd64 \
#     -f apps/node-agent/deploy/Dockerfile.modal \
#     -t ghcr.io/<owner>/agentpod-node-modal:<version> \
#     --push apps/node-agent
FROM agentpod-node:base

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/modal-entrypoint.sh /modal-entrypoint.sh
RUN chmod +x /modal-entrypoint.sh

# The Volume mount point. Created here so the path exists even if a sandbox is
# ever started without one.
RUN mkdir -p /workspace
WORKDIR /workspace

# Cleared on purpose: see (2) above. The driver supplies the command.
ENTRYPOINT []
```

- [ ] **Step 3: Build it and check all three requirements**

```bash
cd /path/to/agentpod
docker build -f apps/node-agent/deploy/Dockerfile.base -t agentpod-node:base apps/node-agent
docker buildx build --platform linux/amd64 \
  -f apps/node-agent/deploy/Dockerfile.modal \
  -t agentpod-node-modal:local --load apps/node-agent

# 1. python and pip are present
docker run --rm --platform linux/amd64 --entrypoint /bin/sh agentpod-node-modal:local \
  -c 'python3 --version && python3 -m pip --version'
# 2. no ENTRYPOINT is baked in
docker inspect -f '{{json .Config.Entrypoint}}' agentpod-node-modal:local
# 3. the image is amd64
docker inspect -f '{{.Architecture}}' agentpod-node-modal:local
```

Expected: a python 3.x version and a pip version; `null` or `[]` for the entrypoint; `amd64` for the architecture. All three must hold — each was a separate way for a Modal sandbox to fail silently.

- [ ] **Step 4: Push it**

```bash
docker buildx build --platform linux/amd64 \
  -f apps/node-agent/deploy/Dockerfile.modal \
  -t ghcr.io/<owner>/agentpod-node-modal:v0.1.0 \
  --push apps/node-agent
```

The registry must be readable by Modal. A private registry needs a Modal `Secret` passed to `images.fromRegistry(tag, secret)`, which this adapter does not do — **use a public repository**, or extend `createModalApi` first. Record which you did in the commit message.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/deploy/Dockerfile.modal apps/node-agent/deploy/modal-entrypoint.sh
git commit -m "feat(node-agent): Modal-compatible image (python+pip, no ENTRYPOINT, amd64)"
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/OPERATING.md`

- [ ] **Step 1: Add the deployment env block**

In `docs/DEPLOYMENT.md`, in the `── Provisioning ──` block, after the Cloudflare lines:

```bash
# Modal provisioner: leave off unless you have read the cost note in OPERATING.md.
# ENABLE_MODAL_PROVISIONING=false
# The hub refuses to boot with ENABLE_MODAL_PROVISIONING=true and any of these missing.
# MODAL_TOKEN_ID=<from the Modal dashboard>
# MODAL_TOKEN_SECRET=<from the Modal dashboard>
# A registry image Modal can pull: linux/amd64, carrying python and pip.
# Build it with apps/node-agent/deploy/Dockerfile.modal.
# NODE_AGENT_MODAL_IMAGE=ghcr.io/<owner>/agentpod-node-modal:v0.1.0
# MODAL_APP_NAME=agentpod
```

And add to the **Key constraints** list under that block:

```markdown
> - Modal: `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `NODE_AGENT_MODAL_IMAGE` and `PROVISIONING_HUB_URL` are all required whenever `ENABLE_MODAL_PROVISIONING=true`, and the hub refuses to boot without them. `NODE_AGENT_MODAL_IMAGE` must be a *registry* reference — the Docker default `agentpod-node:local` is meaningless to Modal, and a runtime provisioned with it never boots and never says why. `PROVISIONING_HUB_URL` is required because Modal destroys every sandbox at 24 hours and the hub re-creates them on a timer, with no request to take an origin from.
> - On Modal's Starter plan an API token is **workspace-wide**; per-resource scoping requires the $250/month Team plan. Use a Modal workspace dedicated to AgentPod.
```

- [ ] **Step 2: Add the operator section**

In `docs/OPERATING.md`, after the "Cloudflare provisioner" section:

```markdown
### Modal provisioner

**Cost first.** Modal sandbox compute carries roughly a **3× premium over standard Modal rates** and bills **wall-clock for as long as the sandbox exists**, not for work done — about **$21/month for a minimal always-on runtime**. A mostly-idle station is this substrate's worst case. Use Modal for short, bursty, isolated work; use Docker for a station that sits waiting for its operator.

**What a Modal runtime actually is.** A rolling series of sandboxes anchored by one named Volume. The Volume (`agentpod-<runtime id>`) holds the workspace at `/workspace` and outlives every sandbox; the sandbox is disposable. This is not an optimisation — Modal has **no stop/start at all**, `terminate` is irreversible, and every sandbox is destroyed by the platform at **24 hours** however healthy it is.

What that means day to day:

- **Stop** terminates the sandbox for good and leaves the Volume alone. The workspace is safe.
- **Start** creates a *new* sandbox against the same Volume. The runtime keeps its identity and its files; the container is new, and the station re-enrols.
- **Destroy** removes the sandbox *and* the Volume. It is the only action that takes your work.
- **Every runtime re-creates itself roughly once a day**, half an hour before the 24-hour ceiling, and the console shows `starting` with a reason naming the ceiling. Files under `/workspace` carry over; anything written elsewhere does not. A process running inside the sandbox does not survive — treat a Modal station as something that restarts nightly.
- Nothing sleeps a Modal runtime for being idle: the platform's idle timer is opt-in and AgentPod never opts in, so a busy-but-quiet station is not reaped the way a Cloudflare sandbox was.

**Credentials.** `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the hub environment. On Modal's Starter plan these are **workspace-wide** — anything in that Modal workspace is reachable by the hub's token. Per-resource scoping requires Modal's $250/month Team plan. Use a dedicated workspace.

**The image.** Modal pulls from a registry, runs linux/amd64 only, and requires python and pip in the image. Build it from `apps/node-agent/deploy/Dockerfile.modal` and set `NODE_AGENT_MODAL_IMAGE` to the pushed tag; the repository must be public unless you extend the driver to pass a Modal registry Secret.
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOYMENT.md docs/OPERATING.md
git commit -m "docs: Modal provisioner — cost, rolling-sandbox model, configuration"
```

---

### Task 15: Live verification — prove the workspace survives sandbox recreation

The one claim the whole design rests on, checked against real Modal and a real hub. Everything before this ran against a fake.

**Files:** none — this task produces evidence, recorded in the PR.

- [ ] **Step 1: Run the full suites**

```bash
cd packages/contract && bun test
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd apps/console && pnpm check && pnpm test && PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm build
```

Expected: all green. Paste the counts into the PR — an unrun suite is not evidence.

- [ ] **Step 2: Bring up a hub with Modal enabled**

```bash
cd apps/hub
ENABLE_MODAL_PROVISIONING=true \
MODAL_TOKEN_ID=<real> MODAL_TOKEN_SECRET=<real> \
NODE_AGENT_MODAL_IMAGE=ghcr.io/<owner>/agentpod-node-modal:v0.1.0 \
PROVISIONING_HUB_URL=https://<publicly reachable hub url> \
DATABASE_URL=<dev db> bun run dev
```

`PROVISIONING_HUB_URL` must be reachable **from inside a Modal sandbox** — a tunnel or the deployed hub, never `localhost`. Confirm the boot log shows `✅ Configuration validation passed`; a refusal here means Task 11 is doing its job and something is missing.

- [ ] **Step 3: Provision a runtime and watch it enrol**

In the console: **New runtime** → provider **Modal** → tier **small** → Create.

Expected: the runtime goes `provisioning` → (a node enrols) → `online` within about a minute, and a station appears. If it sits in `provisioning` for two minutes and is expired, read the Modal dashboard's sandbox logs — the usual causes are an image without python, an image that is arm64, or a hub URL the sandbox cannot reach.

- [ ] **Step 4: Write a sentinel into the workspace**

Open the station's **Terminal** tab and run:

```sh
echo "modal-workspace-sentinel-$(date +%s)" > /workspace/SENTINEL
cat /workspace/SENTINEL
```

Record the exact value and the runtime's `externalId` (visible in the runtime detail panel — the part after `#` is the sandbox id).

- [ ] **Step 5: Stop, then start — a different sandbox, the same workspace**

Stop the runtime from the console. Expected: it reaches `stopped` (the driver's `poll()` reports the exit code, so this is evidence, not assumption). Confirm in the Modal dashboard that the sandbox is terminated.

Start it. Expected: `starting`, then `online` once the new container enrols. **The `externalId`'s sandbox half must differ from the one recorded in step 4, and the volume half must be identical.**

Open the Terminal again:

```sh
cat /workspace/SENTINEL
```

**Expected: the exact string from step 4.** This is the load-bearing verification — a different sandbox, the same workspace. If it is missing, stop: `workspaceStorage: "volume"` is not true of this deployment and the driver must not ship.

- [ ] **Step 6: Verify rotation without waiting a day**

Restart the hub with `MODAL_MAX_LIFETIME_MS=1800000` (30 minutes) added to the environment. Because `ROTATION_MARGIN_MS` is 30 minutes, every live Modal runtime is immediately due for rotation.

Expected, within one 15-second sweeper tick: the runtime goes to `starting` with a `statusReason` naming the lifetime ceiling, its sandbox id changes, it returns to `online`, and `cat /workspace/SENTINEL` still prints the step-4 value. Check the Modal dashboard: the previous sandbox is terminated, not orphaned.

Then stop a runtime and leave it stopped for two ticks. **Expected: it is NOT rotated** — a resurrected stopped runtime bills wall-clock indefinitely, and this is the guard against it.

- [ ] **Step 7: Destroy, and check Modal is actually empty**

Destroy the runtime from the console. In the Modal dashboard, confirm **both** that the sandbox is gone and that the Volume `agentpod-<runtime id>` no longer exists. A surviving Volume is a bill with no console row to explain it.

- [ ] **Step 8: Record the findings**

Write the results into the PR description: the sentinel value before and after recreation, both sandbox ids, the rotation `statusReason`, and confirmation that the Volume was deleted.

If step 5 revealed that a terminated sandbox raises `NotFoundError` on `poll()` rather than returning an exit code — visible as a runtime stuck in `stopping` that turns to `error` after five minutes — the fix is in `createModalApi`: map not-found on `pollSandbox` to a `stopped` answer **only** for that call, with a regression test named for this finding, and note it in the PR. Do not paper over it in the driver, where the distinction between "gone" and "unreachable" has to stay intact.

- [ ] **Step 9: Commit any fix and open the PR**

```bash
git add -A
git commit -m "fix(provisioner): <what live verification found>"   # only if step 8 found something
git push -u origin modal-driver
```

---

## Self-Review

Run this yourself after writing or before executing; it is not a subagent dispatch.

**1. Spec coverage.** Every requirement in the task brief maps to a task: driver skeleton + manifest (1); credential wiring (2); volume-anchored provisioning (3); stop as terminate (4); status via poll (4); rotation for the 24h cap (7, 9); conformance (6); registry/bootstrap wiring (10); the image (13); config validation (11); docs (14); live verification proving a workspace survives sandbox recreation (15). Provider-scoped image resolution (12) and the `external_started_at` column (7) are not in the brief but are load-bearing: without the first, a hub with Docker and Modal both enabled hands Modal an unpullable local tag; without the second, rotation cannot tell a sandbox's age from a runtime's.

**2. The four design questions** are answered in the header and implemented in Tasks 8 (start is a create), 9 (rotation on the sweeper tick, age-based, live states only), 4 + 9 (`stopped` is honest at the driver and never becomes the hub's word for an expiry) and 3 + 13 (no credential is ever written to the Volume; `HOME` stays on the rootfs).

**3. Type consistency.** `ModalApi` has exactly four methods and they are called by the same names in Tasks 3, 4, 5, and by both fakes. `encodeExternalId(volumeName, sandboxId)` and `decodeExternalId` agree on `#`. `imageForHarness(harness, provider)` is two-argument from Task 12 onward and both call sites are updated there. `reprovisionRuntime(row, reason)` has the same signature in Task 8 (where it is defined) and Task 9 (where it is called). `externalStartedAt` is the schema field and `external_started_at` the column, consistently.

**4. No placeholders.** Every code step contains the code to write; the only `<placeholders>` are deployment values a human must supply (registry owner, real tokens, hub URL), each marked as such.
