/**
 * Driver conformance suite — declarations checked against behaviour.
 *
 * Not "does this driver work". "Does this driver do what it says." Every rule
 * below is a production incident turned into a question a new driver has to
 * answer before it ships, so that Fly and Modal cost a review rather than an
 * outage:
 *
 *   1. imageBinding   — Cloudflare silently ignored spec.image, and the wrong
 *                       harness booted with nothing in any log to say why.
 *   2. supportedTiers — resourceTier was dropped on the floor for months; the
 *                       console offered three sizes and gave you one.
 *   3. stopSemantics  — Modal's terminate is irreversible. A hub that believes
 *                       there is a start to call leaves a station starting for
 *                       ever.
 *   4. workspaceStorage — the Cloudflare data loss: a container whose disk was
 *                       wiped on sleep looked exactly like Docker's, whose disk
 *                       is not, because the interface had no way to say so.
 *   5. status         — we wrote `stopped` without evidence, which an operator
 *                       reads as "it has stopped costing me money".
 *   6. destroy        — the destroy/archive race returned 200 and left the
 *                       archive behind; the retry that cleans that up is only
 *                       safe if destroy tolerates a resource already gone.
 *
 * **Pass a driver wired to a FAKE substrate.** assertConforms provisions and
 * destroys: against a real one it would create and delete real infrastructure.
 * Both real drivers take their substrate by injection for exactly this reason
 * (`new DockerRuntimeProvisioner(fakeOrchestrator)`,
 * `new CloudflareSandboxProvisioner({ fetchImpl })`), and the fake must be
 * FAITHFUL — a fake that tolerates everything makes every behavioural rule pass
 * for free, which is the same as not having them.
 */

import type {
  DriverManifest,
  ProvisionSpec,
  ResourceTier,
  RuntimeProvisioner,
  RuntimeState,
} from "./types";

// ─── Probe constants ──────────────────────────────────────────────────────────

const ALL_TIERS: readonly ResourceTier[] = ["small", "medium", "large"];

const VALID_STATES: ReadonlySet<string> = new Set<RuntimeState>([
  "running",
  "stopped",
  "unknown",
]);

/**
 * An image no deployment can plausibly be pinned to, used to ask "would you
 * honour this?".
 *
 * The refusal has to NAME it. A driver that simply fails — because its worker
 * URL is empty, or its daemon is down — rejects everything, and reading that as
 * "it enforced its declaration" would pass a driver that enforces nothing.
 */
const DIFFERING_IMAGE = "agentpod.invalid/conformance-probe:not-the-deployed-image";

/** The image used where the probe needs one the driver can accept. */
const PROBE_IMAGE = "agentpod.invalid/conformance-probe:v0";

/** What the probes ask a driver to create, and always then destroy. */
export interface ConformanceProbe {
  /**
   * An image this driver's deployment can actually honour.
   *
   * REQUIRED for an `imageBinding: "fixed"` driver: its image is a deployment
   * fact, not something the manifest carries, so nothing else in the suite can
   * build a spec such a driver would accept. Everything past rule 1 — tiers,
   * status, destroy — needs one.
   */
  image?: string;
  /** Tier to provision with. Defaults to the first the driver declares. */
  tier?: ResourceTier;
}

// ─── Failure reporting ────────────────────────────────────────────────────────

/**
 * A conformance failure names the manifest field it contradicts, because the
 * fix is always one of two things: change the behaviour, or change the
 * declaration to the truth.
 */
function violation(provider: string, field: string, detail: string): never {
  throw new Error(`conformance(${provider}): ${field}: ${detail}`);
}

/** A problem with the harness, not the driver. Distinct so it cannot be read as a pass. */
function harness(provider: string, detail: string): never {
  throw new Error(`conformance(${provider}): probe could not run: ${detail}`);
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: Error };

async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

const messageOf = (err: Error): string => String(err?.message ?? err);

// ─── The suite ────────────────────────────────────────────────────────────────

/**
 * Throw unless this driver behaves the way its manifest says it does.
 *
 * Resolves to `undefined` for a conformant driver; throws an Error naming the
 * violated rule otherwise.
 */
export async function assertConforms(
  driver: RuntimeProvisioner,
  probe: ConformanceProbe = {}
): Promise<void> {
  const manifest = driver.manifest;
  if (!manifest) {
    harness(String(driver.provider ?? "<unnamed>"), "the driver declares no manifest");
  }
  const provider = manifest.provider || String(driver.provider ?? "<unnamed>");
  if (!manifest.provider) {
    violation(provider, "provider", "the manifest declares no provider name");
  }
  if (probe.image === DIFFERING_IMAGE) {
    harness(provider, `probe.image must not be the probe's own sentinel image`);
  }

  assertStopSemantics(provider, manifest, driver);
  assertLifecycleIsImplemented(provider, manifest, driver);
  assertWorkspaceStorageIsCoherent(provider, manifest);

  const tier = probe.tier ?? manifest.supportedTiers[0] ?? "small";
  if (!manifest.supportedTiers.includes(tier) && manifest.supportedTiers.length > 0) {
    harness(provider, `probe.tier "${tier}" is not one this driver declares`);
  }

  await assertImageBinding(provider, manifest, driver, tier);

  // Past this point every probe needs a spec the driver will accept, and for a
  // fixed-image driver only its deployment knows what that is.
  if (manifest.imageBinding === "fixed" && !probe.image) {
    harness(
      provider,
      `imageBinding is "fixed", so the probe needs the image this deployment ` +
        `bakes in — pass it as assertConforms(driver, { image }).`
    );
  }
  const acceptableImage = probe.image ?? PROBE_IMAGE;

  await assertSupportedTiers(provider, manifest, driver, acceptableImage);
  await assertLiveLifecycle(provider, manifest, driver, acceptableImage, tier);
}

// ─── Rule 3: stopSemantics ────────────────────────────────────────────────────

/**
 * `terminal` means stop is the end of the instance — Modal's terminate cannot
 * be undone, and every restart is a new sandbox with a new id and a fresh
 * filesystem. A start verb on such a driver is not a small inaccuracy: the hub
 * calls start on a stopped runtime, and a driver that accepts the call reports
 * success for something that can never happen.
 */
function assertStopSemantics(
  provider: string,
  manifest: DriverManifest,
  driver: RuntimeProvisioner
): void {
  if (manifest.stopSemantics !== "terminal") return;

  if (manifest.lifecycle.includes("start")) {
    violation(
      provider,
      "stopSemantics",
      `declared "terminal", so stop ends the instance — but lifecycle declares ` +
        `"start". There is nothing to start; a terminal driver restarts by ` +
        `provisioning again.`
    );
  }
  if (typeof driver.start === "function") {
    violation(
      provider,
      "stopSemantics",
      `declared "terminal" but the driver implements start(). The hub reaches ` +
        `for start() by method presence, so an undeclared one is still callable.`
    );
  }
}

// ─── Declared verbs must exist ───────────────────────────────────────────────

/**
 * A lifecycle verb is a promise the hub takes literally.
 *
 * `status` is the sharp one: it is the ONLY evidence the hub has for writing
 * `stopped`, and a driver that declares it but does not implement it turns
 * every stop into an unhandled error at the moment an operator is watching.
 * The reverse — implementing a verb without declaring it — is just as wrong,
 * because the console builds what it offers from the manifest.
 */
function assertLifecycleIsImplemented(
  provider: string,
  manifest: DriverManifest,
  driver: RuntimeProvisioner
): void {
  for (const verb of ["start", "stop", "status"] as const) {
    const declared = manifest.lifecycle.includes(verb);
    const implemented = typeof driver[verb] === "function";
    if (declared && !implemented) {
      violation(
        provider,
        "lifecycle",
        `declares "${verb}" but the driver implements no ${verb}().`
      );
    }
    if (!declared && implemented) {
      violation(
        provider,
        "lifecycle",
        `implements ${verb}() but does not declare "${verb}". The console and ` +
          `the hub read the manifest, so an undeclared verb is a capability ` +
          `nobody knows exists.`
      );
    }
  }
}

// ─── Rule 4: workspaceStorage ─────────────────────────────────────────────────

/**
 * Structural half of the hardest rule.
 *
 * `workspaceStorage: "rootfs"` + `stopSemantics: "resumable"` claims the
 * substrate itself carries a station's work across a stop. That is true of
 * exactly one of the four substrates surveyed — Docker, the one this interface
 * was accidentally designed around — and the cost of assuming it elsewhere was
 * a user's workspace.
 *
 * The suite cannot read a substrate's disk through this interface, so it does
 * two things instead. Here it refuses the combinations where the claim is
 * impossible on its face; assertLiveLifecycle() then makes the driver witness
 * what remains by stopping and starting a real (fake-substrate) instance.
 */
function assertWorkspaceStorageIsCoherent(
  provider: string,
  manifest: DriverManifest
): void {
  if (manifest.workspaceStorage !== "rootfs") return;

  if (manifest.stopSemantics === "terminal") {
    violation(
      provider,
      "workspaceStorage",
      `declared "rootfs" with stopSemantics "terminal": the rootfs dies with ` +
        `the instance, so nothing survives there. Anchor the workspace in a ` +
        `volume or an external archive and declare that instead.`
    );
  }

  // Everything below is about the resumable case.
  const canStop = manifest.lifecycle.includes("stop");
  const canStart = manifest.lifecycle.includes("start");
  if (!canStop || !canStart) {
    violation(
      provider,
      "workspaceStorage",
      `declared "rootfs" with stopSemantics "resumable" — a claim about what ` +
        `survives stop→start — but the driver declares ` +
        `${!canStop && !canStart ? "neither stop nor start" : !canStop ? "no stop" : "no start"}. ` +
        `Nobody can ever check that claim, and unchecked it reads as Docker's.`
    );
  }

  if (manifest.idleBehaviour === "platform-inbound") {
    violation(
      provider,
      "workspaceStorage",
      `declared "rootfs" on a substrate that sleeps instances on INBOUND ` +
        `idleness. A node-agent dials out and receives nothing, so the platform ` +
        `reaps a busy station and takes the rootfs with it — no stop is ever ` +
        `called, so no amount of care in this driver protects the workspace. ` +
        `Archive it ("external-archive") or anchor it in a volume.`
    );
  }
}

// ─── Rule 1: imageBinding ─────────────────────────────────────────────────────

/**
 * Ask the driver to provision an image it was not deployed with.
 *
 * `fixed` must refuse, and the refusal must name the image — an unattributed
 * failure is indistinguishable from a broken substrate, and the incident this
 * encodes is precisely a driver that looked fine while ignoring the field.
 * `per-instance` must not refuse for that reason; whether it then really boots
 * that image is beyond this interface, but the console offers a harness choice
 * on the strength of the declaration, so a refusal here is a lie the user pays
 * for.
 */
async function assertImageBinding(
  provider: string,
  manifest: DriverManifest,
  driver: RuntimeProvisioner,
  tier: ResourceTier
): Promise<void> {
  const outcome = await attempt(() =>
    driver.provision(probeSpec("image", DIFFERING_IMAGE, tier))
  );

  if (outcome.ok) {
    await cleanup(driver, outcome.value.externalId);
    if (manifest.imageBinding === "fixed") {
      violation(
        provider,
        "imageBinding",
        `declared "fixed" but provision() accepted image "${DIFFERING_IMAGE}". ` +
          `A driver that cannot honour spec.image must refuse it, not ignore ` +
          `it — silently booting a different harness is invisible until someone ` +
          `opens a terminal.`
      );
    }
    return;
  }

  const message = messageOf(outcome.error);
  const blamesTheImage = message.includes(DIFFERING_IMAGE);

  if (manifest.imageBinding === "fixed" && !blamesTheImage) {
    violation(
      provider,
      "imageBinding",
      `declared "fixed" but provision() refused "${DIFFERING_IMAGE}" without ` +
        `attributing it to the image: "${message}". A refusal that does not ` +
        `name the image it cannot honour proves nothing — an unreachable ` +
        `substrate refuses everything, and the ignored-image bug survives ` +
        `underneath it. (An unconfigured "fixed" driver lands here: it has no ` +
        `deployed image to compare against and enforces nothing.)`
    );
  }

  if (manifest.imageBinding === "per-instance" && blamesTheImage) {
    violation(
      provider,
      "imageBinding",
      `declared "per-instance" but provision() refused the image it was given: ` +
        `"${message}". Declare "fixed" — the console builds its harness choice ` +
        `from this field, and offering a choice the driver rejects is a ` +
        `guaranteed failure with a backend error as the only feedback.`
    );
  }
}

// ─── Rule 2: supportedTiers ───────────────────────────────────────────────────

/**
 * Both directions, because both have failed.
 *
 * A declared tier that provision() refuses is the console offering a size that
 * cannot be created. An undeclared tier that provision() accepts is
 * `resourceTier` being dropped on the floor again — every size producing the
 * same container, which is how it went unnoticed for months.
 */
async function assertSupportedTiers(
  provider: string,
  manifest: DriverManifest,
  driver: RuntimeProvisioner,
  image: string
): Promise<void> {
  for (const declared of manifest.supportedTiers) {
    const outcome = await attempt(() =>
      driver.provision(probeSpec(`tier-${declared}`, image, declared))
    );
    if (outcome.ok) {
      await cleanup(driver, outcome.value.externalId);
      continue;
    }
    const message = messageOf(outcome.error);
    if (message.includes(declared)) {
      violation(
        provider,
        "supportedTiers",
        `declares "${declared}" but provision() refused it: "${message}".`
      );
    }
    harness(
      provider,
      `provision() failed on the declared tier "${declared}" for an unrelated ` +
        `reason: "${message}". Wire the driver to a fake substrate that accepts ` +
        `a valid spec, or the behavioural rules cannot be reached.`
    );
  }

  for (const undeclared of ALL_TIERS) {
    if (manifest.supportedTiers.includes(undeclared)) continue;
    const outcome = await attempt(() =>
      driver.provision(probeSpec(`tier-${undeclared}`, image, undeclared))
    );
    if (outcome.ok) {
      await cleanup(driver, outcome.value.externalId);
      violation(
        provider,
        "supportedTiers",
        `does not declare "${undeclared}" but provision() accepted it. A tier ` +
          `a driver cannot satisfy must be refused, not quietly rounded to the ` +
          `one size it has.`
      );
    }
    const message = messageOf(outcome.error);
    if (!message.includes(undeclared)) {
      violation(
        provider,
        "supportedTiers",
        `refused the undeclared tier "${undeclared}" without attributing it to ` +
          `the tier: "${message}". As with the image, an unattributed refusal ` +
          `is indistinguishable from a substrate that is simply down.`
      );
    }
  }
}

// ─── Rules 4 (witness), 5 and 6: one live instance ───────────────────────────

/**
 * Provision one instance on the fake substrate and put the remaining rules to
 * it, then destroy it — twice.
 */
async function assertLiveLifecycle(
  provider: string,
  manifest: DriverManifest,
  driver: RuntimeProvisioner,
  image: string,
  tier: ResourceTier
): Promise<void> {
  const created = await attempt(() =>
    driver.provision(probeSpec("lifecycle", image, tier))
  );
  if (!created.ok) {
    harness(
      provider,
      `provision() rejected a spec built from the manifest's own declarations: ` +
        `"${messageOf(created.error)}"`
    );
  }
  const id = created.value.externalId;
  if (typeof id !== "string" || !id) {
    violation(
      provider,
      "provision",
      `returned no externalId (${JSON.stringify(id)}). The hub stores it as the ` +
        `only handle it will ever have on this instance.`
    );
  }

  // Rule 5: the substrate has just told us it created this. A status verb that
  // throws or invents a fourth state here is the `stopped`-without-evidence bug
  // in waiting.
  if (manifest.lifecycle.includes("status")) {
    await assertStatusAnswers(provider, driver, id);
  }

  // Rule 4, behavioural half.
  if (
    manifest.workspaceStorage === "rootfs" &&
    manifest.stopSemantics === "resumable"
  ) {
    await assertRootfsSurvivesAStop(provider, manifest, driver, id);
  }

  // Rule 6.
  const first = await attempt(() => driver.destroy(id));
  if (!first.ok) {
    violation(
      provider,
      "destroy",
      `destroy() rejected for an instance this suite had just provisioned: ` +
        `"${messageOf(first.error)}"`
    );
  }
  const second = await attempt(() => driver.destroy(id));
  if (!second.ok) {
    violation(
      provider,
      "destroy",
      `destroy() is not idempotent: destroying an already-destroyed instance ` +
        `threw "${messageOf(second.error)}". destroyRuntime() turns a driver ` +
        `throw into a 502 and leaves the row un-destroyed, so the retry that ` +
        `should clean up a half-finished destroy — the one that left an archive ` +
        `behind after a 200 — wedges the runtime instead.`
    );
  }
}

/** Rule 5, at the one moment the substrate's answer is not in doubt. */
async function assertStatusAnswers(
  provider: string,
  driver: RuntimeProvisioner,
  id: string
): Promise<void> {
  const answered = await attempt(() => driver.status!(id));
  if (!answered.ok) {
    violation(
      provider,
      "status",
      `status() threw for an instance the substrate had just created: ` +
        `"${messageOf(answered.error)}". A driver that cannot reach its ` +
        `substrate may throw; one whose substrate answered may not. "unknown" ` +
        `is the answer for "I do not know".`
    );
  }
  if (!VALID_STATES.has(answered.value as string)) {
    violation(
      provider,
      "status",
      `status() answered ${JSON.stringify(answered.value)}. The only answers ` +
        `are "running", "stopped" and "unknown" — the hub turns "stopped" into ` +
        `a claim an operator reads as "it has stopped costing me money".`
    );
  }
}

/**
 * Rule 4, behavioural half: make the driver witness its own claim.
 *
 * `rootfs` + `resumable` says the substrate keeps the disk across a stop. The
 * one part of that this interface can observe is whether the instance the
 * driver stopped is the instance it starts again: a substrate that cannot
 * resume what it stopped certainly did not keep the disk.
 *
 * NECESSARY, NOT SUFFICIENT, and deliberately so — Cloudflare resumes the same
 * sandbox id onto a wiped disk, which this probe would not catch. That case is
 * caught structurally instead (a rootfs workspace on an inbound-idle substrate
 * is refused outright above), and by the field existing at all: an author who
 * must type `rootfs` has to answer, at that moment, what happens to the files.
 */
async function assertRootfsSurvivesAStop(
  provider: string,
  manifest: DriverManifest,
  driver: RuntimeProvisioner,
  id: string
): Promise<void> {
  const stopped = await attempt(() => driver.stop!(id));
  if (!stopped.ok) {
    violation(
      provider,
      "workspaceStorage",
      `declared "rootfs" + "resumable", but stop() rejected: ` +
        `"${messageOf(stopped.error)}"`
    );
  }

  const started = await attempt(() => driver.start!(id));
  if (!started.ok) {
    violation(
      provider,
      "workspaceStorage",
      `declared "rootfs" + "resumable", but the substrate could not resume the ` +
        `instance it stopped: "${messageOf(started.error)}". An instance that ` +
        `does not survive a stop did not keep a workspace on its rootfs either.`
    );
  }

  if (!manifest.lifecycle.includes("status")) return;
  const after = await attempt(() => driver.status!(id));
  if (!after.ok || after.value !== "running") {
    violation(
      provider,
      "workspaceStorage",
      `declared "rootfs" + "resumable", but after stop→start the instance is ` +
        `${after.ok ? `"${after.value}"` : `unreadable ("${messageOf(after.error)}")`}, ` +
        `not running. Whatever was on that disk is not coming back.`
    );
  }
}

// ─── Probe plumbing ───────────────────────────────────────────────────────────

function probeSpec(
  label: string,
  image: string,
  resourceTier: ResourceTier
): ProvisionSpec {
  return {
    runtimeId: `conformance-probe-${label}`,
    name: `conformance-probe-${label}`,
    resourceTier,
    hubUrl: "https://conformance.invalid",
    enrollToken: "conformance-probe-token",
    image,
  };
}

/**
 * Best effort: a probe that provisioned something must not leave it behind, but
 * a failure to clean up is not the rule under test and must not be reported as
 * one — rule 6 exercises destroy deliberately, a few lines later.
 */
async function cleanup(driver: RuntimeProvisioner, externalId: string): Promise<void> {
  await attempt(() => driver.destroy(externalId));
}
