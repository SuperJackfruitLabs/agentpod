# Provisioner registry and driver manifests — design

**Date:** 2026-08-12
**Status:** approved
**Roadmap:** Horizon 1 — "Open the provisioner registry", plus driver-wave step 4

## Goal

Make adding a substrate a bounded, checkable exercise rather than an act of archaeology.

Two more drivers are coming — **Fly** and **Modal** — and the current interface cannot express what
they need. Its provider names are a hardcoded union, its optional methods are discovered by reading
other drivers, and everything a substrate might do differently is either assumed or found out in
production.

## What the spike found

Read-only research against Fly's and Modal's current documentation, 2026-08-12. Put the four
substrates side by side and one column matters more than the rest:

| | disk across stop/start | idle reaping | image | sizing | stop evidence |
|---|---|---|---|---|---|
| Docker | **persists** | never | per-container | per-container | inspect |
| Cloudflare | wiped | forced, inbound-keyed | baked at deploy | fixed | `container.running` |
| Fly Machines | **wiped** (rootfs) | none without `services` | per-machine | per-machine | `wait?state=` + state |
| Modal | **no stop/start at all** | opt-in, off by default | per-sandbox | per-sandbox | `poll()` |

**Three of four destroy the workspace on the rootfs. Docker is the outlier — and Docker is the
substrate this interface was designed around.** That is the whole reason Cloudflare cost a user
their work: the interface had no way to say "my disk does not survive", so nobody had to think
about it.

Specific findings that change the design:

- **Fly Sprites are unusable for this workload**, despite looking ideal. Idle detection counts
  inbound activity, and "open TCP connections do not survive a pause" — websockets named
  explicitly. Our agent dials out and receives nothing, so it would read as idle while busy and
  have its uplink torn down. Cloudflare's failure in a different costume. **Fly Machines**, not
  Sprites.
- **Fly Machines avoid idle reaping by construction**: autostop is Fly-Proxy-driven and only
  touches machines with inbound `services` configured. The driver defines none, so the problem
  cannot arise. The hub drives stop/start itself, which it already does.
- **Fly can honour image and resource tier per machine** — the two inputs the Cloudflare driver
  had to refuse.
- **Fly repeats the trap subtly**: `persist_rootfs` exists, and Fly's own docs disclaim it as
  unreliable for critical data. The spike could not resolve whether it survives a full stop→start.
  Use a Volume; do not bet a workspace on it.
- **Modal has a hard 24-hour lifetime and no stop/start at all** — `terminate` is irreversible.
  Every restart is a new sandbox with a new id and a fresh filesystem. It also carries a ~3×
  compute premium billed on wall-clock, making mostly-idle fleets its worst case. It is workable
  only as "a rolling series of sandboxes anchored by a Volume".

## The reframe

The R2 snapshot machinery built for Cloudflare **is the general case, not a special case.** Fly's
answer is a Volume, Modal's is a Volume, Cloudflare's is our R2 archive, Docker's is the container
filesystem. So the manifest does not ask "is the disk persistent?" — a boolean that flatters
Docker. It asks **where the workspace lives and what carries identity across a restart.**

## Architecture

### 1. Driver manifest — required declarations

Every driver declares a `manifest`, and the type makes omission a compile error. Each field below
exists because its absence has already cost something:

```ts
interface DriverManifest {
  /** Stable provider name. Replaces the hardcoded union. */
  readonly provider: string;

  /** Where a station's workspace survives, if anywhere. */
  readonly workspaceStorage: "rootfs" | "volume" | "external-archive";

  /** Does stop→start preserve the instance, or is stop the end of it? */
  readonly stopSemantics: "resumable" | "terminal";

  /** Platform-imposed ceiling after which the substrate destroys a healthy runtime. */
  readonly maxLifetimeMs: number | null;

  /** Can ProvisionSpec.image be honoured, or is it fixed at deploy time? */
  readonly imageBinding: "per-instance" | "fixed";

  /** Tiers this driver can actually satisfy. Empty means it refuses all but its default. */
  readonly supportedTiers: readonly ResourceTier[];

  /** Who sleeps an idle runtime, and on what signal. */
  readonly idleBehaviour: "never" | "platform-inbound" | "hub-driven";

  /** Lifecycle verbs beyond provision/destroy that this driver implements. */
  readonly lifecycle: readonly ("start" | "stop" | "status")[];
}
```

`stopSemantics` is the field that matters most. Had it been required, **the Cloudflare workspace
loss would have been a compile-time question rather than a production discovery** — the author
would have had to type `"terminal"` and then answer what happens to the files.

`imageBinding` and `supportedTiers` turn today's ad-hoc refusals into declarations. The Cloudflare
driver currently refuses a mismatched image and a wrong tier with hand-written errors; those become
generic, enforced above the driver.

### 2. Registry — names become data

`RuntimeProviderName` stops being `"docker" | "cloudflare"`. The contract validates a provider
string against the registry's registered manifests at runtime rather than pinning the set at
compile time. The console's New Runtime dialog already builds its tier list from hub-reported
capabilities (PR #250); it extends to build its **provider** list the same way.

This is what "open the registry" actually means. Adding a fifth driver must not require edits in
the contract, the hub and the console.

### 3. Conformance suite

An executable suite, run in CI, that checks a driver's **declarations against its behaviour** using
a fake or recorded substrate. Not "does the driver work" — "does the driver do what it says".

Checks, each derived from a real incident:

| Check | Incident it encodes |
|---|---|
| A driver declaring `imageBinding: "fixed"` refuses a differing `spec.image` | Cloudflare silently ignored it |
| A driver refuses any tier outside `supportedTiers` | `resourceTier` was dropped on the floor |
| `stopSemantics: "terminal"` implies `start` is absent from `lifecycle` | Modal has no start to call |
| `workspaceStorage: "rootfs"` + `stopSemantics: "resumable"` requires an archive mechanism | the Cloudflare data loss |
| A declared `status` verb returns one of the three states and never throws past the boundary | the `stopped`-without-evidence bug |
| Destroy is idempotent and leaves no substrate-side residue | the destroy/archive race |

**The worker has no CI coverage at all today** — `cloudflare/worker-v2`'s tests only ever run in a
developer's checkout, which is precisely why the frozen-`envVars` bug survived. Wiring it into CI
is part of this work.

### 4. Credential resolver

Both new drivers need an API token in the hub. That is **a different property from the standing
rule** that the hub holds nothing that can reach the existing fleet — enrolment is outbound-dialled
and SSH runs from the operator's local agent. A Fly or Modal token creates *new* infrastructure; it
does not reach a node.

Credentials stay env-based, behind a `CredentialResolver` interface, so the per-org encrypted store
can land with the orgs work in Horizon 3 without touching drivers. Each driver declares the keys it
needs; a missing key is a startup-time refusal to register, not a runtime failure on first use.

Scoping, from the spike: Fly supports **app-scoped deploy tokens** (one app, its resources) and
defaults token expiry to twenty years — set it explicitly. Modal's RBAC requires the **$250/mo Team
plan**; on Starter a token is workspace-wide. That is a cost of doing business with Modal and
should be stated before anyone is surprised by it.

## Sequencing

1. **Manifest + registry + conformance suite**, with Docker and Cloudflare retrofitted to declare
   what they already do. Their declarations are known-true, so the suite is validated against
   reality before it gates anything new.
2. **Fly Machines driver.** Volume-anchored workspace, no `services` block, hub-driven stop/start,
   `status` via `wait?state=` plus a confirming read.
3. **Modal driver.** Second, deliberately: its constraints — terminal stop, 24-hour ceiling — are
   the hardest test of whether the manifest generalises. Discovering it does not is much cheaper
   here than in a fifth driver.

## Verification

Nothing in the table above was observed; it is all documentation, and this project has been wrong
about documentation four times today. **Before the Fly driver is written**, run the empirical probe
on a real account: create an instance, write a sentinel file, stop it, start it, look for the file.
Then leave one idle past its documented window with only outbound traffic and see whether it
survives.

Those two probes settle `workspaceStorage` and `idleBehaviour` — the two fields whose being wrong
costs a user their work. Accounts exist for both providers.

## Out of scope

- Per-org credential storage (Horizon 3, with orgs).
- Operated substrate as a paid tier (needs multi-tenancy).
- Fly Sprites — ruled out above, and worth revisiting only if outbound connections ever count as
  activity.
- Pause/resume as a distinct verb from stop/start. No substrate we are adding needs it: Fly's
  suspend is an optimisation of start, and Modal has neither.
