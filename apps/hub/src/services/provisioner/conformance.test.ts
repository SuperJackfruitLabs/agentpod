/**
 * Tests for the driver conformance suite.
 *
 * Two halves, and both matter:
 *
 *  1. Fake drivers that LIE — each one declares a manifest field and then
 *     behaves as if it had declared something else. Every lie here is a real
 *     incident replayed: the suite exists so those become checkable rather than
 *     remembered.
 *
 *  2. The real drivers, against fake substrates. Their declarations are
 *     known-true, so this is what validates the suite against reality before it
 *     gates anything new. If a real driver fails, suspect the suite first.
 *
 * NOTHING here touches a real substrate: the Docker driver is handed a fake
 * orchestrator, the Cloudflare driver a fake fetch and the Modal driver a fake
 * ModalApi, exactly as their own unit tests do. A conformance check that needed
 * a daemon or an API token would run nowhere, which is how the Cloudflare worker
 * went a year without CI.
 */

import { describe, it, expect } from "bun:test";
import { assertConforms } from "./conformance";
import { DockerRuntimeProvisioner } from "./docker";
import { CloudflareSandboxProvisioner } from "./cloudflare-sandbox";
import { ModalRuntimeProvisioner } from "./modal";
import { ModalNotFoundError } from "./modal-api";
import type { ModalApi } from "./modal-api";
import { FlyMachinesProvisioner } from "./fly";
import { createFlyFakeSubstrate } from "./fly-fake-substrate";
import { noPacer } from "./fly-api";
import type {
  DockerOrchestrator,
  Sandbox,
  SandboxConfig,
} from "./docker-orchestrator";
import type {
  DriverManifest,
  ProvisionSpec,
  ResourceTier,
  RuntimeProvisioner,
  RuntimeState,
} from "./types";

// ─── A conformant baseline to mutate ─────────────────────────────────────────

const base: DriverManifest = {
  provider: "fake",
  workspaceStorage: "rootfs",
  stopSemantics: "resumable",
  maxLifetimeMs: null,
  imageBinding: "per-instance",
  supportedTiers: ["small"],
  tierMemoryMb: { small: 1024 },
  idleBehaviour: "never",
  lifecycle: ["start", "stop", "status"],
};

/** The image a fixed-image fake was "deployed" with. */
const FAKE_DEPLOYED_IMAGE = "fake-registry/agentpod-node:deployed";

// ─── The fake driver ──────────────────────────────────────────────────────────

/**
 * What the fake's substrate does behind the manifest it declares.
 *
 * Every flag makes the fake contradict its own declaration in exactly one way,
 * which is what each rule is supposed to catch.
 */
interface FakeBehaviour {
  /** Ignores spec.image the way the Cloudflare driver used to. */
  provisionAcceptsAnyImage?: boolean;
  /** Refuses a tier it declares in supportedTiers. */
  refusesTier?: ResourceTier;
  /** Refuses spec.image although it declares imageBinding "per-instance". */
  refusesAnyImageBut?: string;
  /** stop() destroys the instance: the rootfs, and the workspace on it, are gone. */
  rootfsWipedOnStop?: boolean;
  /** status() answers something outside the three states. */
  statusReturns?: unknown;
  /** status() throws instead of answering. */
  statusThrows?: boolean;
  /** destroy() rejects once the instance is already gone. */
  destroyThrowsWhenGone?: boolean;
  /** start() rejects for an instance that is already running — Docker's 304. */
  startThrowsWhenRunning?: boolean;
  /** stop() rejects for an instance that is already stopped — Docker's 304. */
  stopThrowsWhenStopped?: boolean;
  /** Declares a lifecycle verb it does not implement. */
  omitMethods?: ReadonlyArray<"start" | "stop" | "status">;
}

/**
 * A driver whose behaviour is dictated by `behaviour`, and whose declarations
 * are dictated by `manifest` — the two can therefore disagree, which is the
 * entire point.
 */
function fakeDriver(
  manifest: DriverManifest,
  behaviour: FakeBehaviour = {}
): RuntimeProvisioner {
  const instances = new Map<string, { running: boolean }>();
  const omitted = new Set(behaviour.omitMethods ?? []);

  const driver: RuntimeProvisioner = {
    manifest,
    provider: manifest.provider,

    async provision(spec: ProvisionSpec) {
      const fixedImage =
        behaviour.refusesAnyImageBut ??
        (manifest.imageBinding === "fixed" && !behaviour.provisionAcceptsAnyImage
          ? FAKE_DEPLOYED_IMAGE
          : null);
      if (fixedImage && spec.image !== fixedImage) {
        throw new Error(
          `fake: deployed with image "${fixedImage}" and cannot provision "${spec.image}"`
        );
      }
      if (
        !manifest.supportedTiers.includes(spec.resourceTier) ||
        behaviour.refusesTier === spec.resourceTier
      ) {
        throw new Error(
          `fake: cannot provision resource tier "${spec.resourceTier}"`
        );
      }
      instances.set(spec.runtimeId, { running: true });
      return { externalId: spec.runtimeId };
    },

    async destroy(externalId: string) {
      if (!instances.has(externalId) && behaviour.destroyThrowsWhenGone) {
        throw new Error(`fake: no such instance ${externalId}`);
      }
      instances.delete(externalId);
    },
  };

  if (manifest.lifecycle.includes("start") && !omitted.has("start")) {
    driver.start = async (externalId: string) => {
      const found = instances.get(externalId);
      if (!found) throw new Error(`fake: no such instance ${externalId}`);
      if (found.running && behaviour.startThrowsWhenRunning) {
        throw new Error("fake: container already started");
      }
      found.running = true;
    };
  }
  if (manifest.lifecycle.includes("stop") && !omitted.has("stop")) {
    driver.stop = async (externalId: string) => {
      const found = instances.get(externalId);
      if (!found) throw new Error(`fake: no such instance ${externalId}`);
      if (!found.running && behaviour.stopThrowsWhenStopped) {
        throw new Error("fake: container already stopped");
      }
      // A wiped rootfs is not "the instance is asleep": everything the instance
      // was lives on that disk, so stopping it ends it.
      if (behaviour.rootfsWipedOnStop) instances.delete(externalId);
      else found.running = false;
    };
  }
  if (manifest.lifecycle.includes("status") && !omitted.has("status")) {
    driver.status = async (externalId: string): Promise<RuntimeState> => {
      if (behaviour.statusThrows) throw new Error("fake: substrate unreachable");
      if (behaviour.statusReturns !== undefined) {
        return behaviour.statusReturns as RuntimeState;
      }
      const found = instances.get(externalId);
      if (!found) return "stopped";
      return found.running ? "running" : "stopped";
    };
  }

  return driver;
}

// ─── A fake Docker substrate ──────────────────────────────────────────────────

/**
 * Stateful stand-in for DockerOrchestrator.
 *
 * Faithful on purpose, including the unfriendly parts: the real orchestrator
 * resolves a container by name/label and throws `Sandbox not found: <id>` when
 * nothing matches, so this does too. A lenient fake would make every lifecycle
 * rule pass for free, which is the same as not checking them.
 */
/** docker-modem's error for a 304, carrying the status the driver branches on. */
function dockerNotModified(reason: string): Error {
  return Object.assign(new Error(`(HTTP code 304) ${reason} -  `), {
    statusCode: 304,
    reason,
  });
}

class FakeDockerSubstrate {
  private readonly containers = new Map<string, Sandbox>();

  /**
   * Only ever set by the diagnostic test that isolates Docker's one gap. The
   * real orchestrator does NOT forgive this, which is the whole finding.
   */
  constructor(private readonly tolerateRepeatDestroy = false) {}

  async createSandbox(config: SandboxConfig): Promise<Sandbox> {
    const sandbox: Sandbox = {
      id: config.id,
      containerId: `fake-${config.id}`,
      name: config.name,
      status: "running",
      urls: {},
      createdAt: new Date(),
      image: config.image,
      runtime: "runc",
    };
    this.containers.set(config.id, sandbox);
    return sandbox;
  }

  /**
   * Refuses a redundant start exactly as the daemon does.
   *
   * dockerode declares `304: "container already started"` for
   * `POST /containers/{id}/start` and docker-modem raises it as an Error with
   * `statusCode` on it. Modelling it is what makes rule 7 mean anything here:
   * before the driver mapped that status, this fake would have failed the rule —
   * and the live hub DID, answering 500 to a second click on Start (#284).
   */
  async startSandbox(id: string): Promise<void> {
    const sandbox = this.get(id);
    if (sandbox.status === "running") {
      throw dockerNotModified("container already started");
    }
    sandbox.status = "running";
  }

  /** The same, for `POST /containers/{id}/stop` on a container already down. */
  async stopSandbox(id: string): Promise<void> {
    const sandbox = this.get(id);
    if (sandbox.status !== "running") {
      throw dockerNotModified("container already stopped");
    }
    sandbox.status = "exited";
  }

  async inspectSandbox(id: string): Promise<Sandbox> {
    return this.get(id);
  }

  async deleteSandbox(id: string): Promise<void> {
    if (this.tolerateRepeatDestroy && !this.containers.has(id)) return;
    this.get(id);
    this.containers.delete(id);
  }

  private get(id: string): Sandbox {
    const found = this.containers.get(id);
    if (!found) throw new Error(`Sandbox not found: ${id}`);
    return found;
  }
}

const dockerDriver = ({ tolerateRepeatDestroy = false } = {}) =>
  new DockerRuntimeProvisioner(
    new FakeDockerSubstrate(tolerateRepeatDestroy) as unknown as DockerOrchestrator
  );

// ─── A fake Cloudflare substrate ──────────────────────────────────────────────

const CLOUDFLARE_IMAGE = "agentpod-node-opencode:v0.1.22";

/**
 * Stand-in for `cloudflare/worker-v2`, route for route.
 *
 * DELETE answers 200 whatever the id, because the worker's handleDestroy does:
 * it revokes the snapshot token, destroys the container and deletes the archive,
 * and none of that needs the sandbox to have existed.
 */
function fakeWorkerFetch(): typeof globalThis.fetch {
  const sandboxes = new Map<string, { running: boolean }>();

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const parts = url.pathname.split("/").filter(Boolean); // ["sandbox", id?, verb?]
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (parts[0] !== "sandbox") return json({ error: "not found" }, 404);

    const id = parts[1];
    if (!id) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: string };
      if (!body.id) return json({ error: "id required" }, 400);
      sandboxes.set(body.id, { running: true });
      return json({ sandboxId: body.id }, 201);
    }

    if (method === "GET") {
      const found = sandboxes.get(id);
      const state = !found ? "unknown" : found.running ? "running" : "stopped";
      return json({ sandboxId: id, state });
    }
    if (method === "DELETE") {
      sandboxes.delete(id);
      return json({ destroyed: id });
    }
    if (parts[2] === "start") {
      sandboxes.set(id, { running: true });
      return json({ started: id });
    }
    if (parts[2] === "stop") {
      const found = sandboxes.get(id);
      if (found) found.running = false;
      return json({ stopped: id });
    }
    if (parts[2] === "touch") return json({ touched: id });
    return json({ error: "not found" }, 404);
  }) as unknown as typeof globalThis.fetch;
}

const cloudflareDriver = (overrides: Record<string, unknown> = {}) =>
  new CloudflareSandboxProvisioner({
    workerUrl: "https://worker.example",
    apiToken: "tok",
    // The image the worker was deployed with. Passed explicitly because the
    // driver's refusal is conditional on knowing it — see the test below that
    // pins what an UNSET image does.
    deployedImage: CLOUDFLARE_IMAGE,
    callbackToken: "cbtok",
    deployedTier: "large",
    fetchImpl: fakeWorkerFetch(),
    ...overrides,
  });

// ─── A fake Modal substrate ───────────────────────────────────────────────────

/**
 * Faithful stand-in for Modal, and a self-contained copy rather than an import
 * from `modal.test.ts` — a shared helper would let one file's convenience
 * quietly weaken another file's rule, and this file has to stay runnable on its
 * own.
 *
 * The unfriendly parts are the load-bearing ones, mirroring exactly what the
 * adapter maps `NotFoundError` to:
 *
 *   - an unknown sandbox id throws from terminate and poll;
 *   - deleting a volume that is already gone throws.
 *
 * Both of those are what make rule 6 mean something here: destroy() takes the
 * sandbox AND the volume, so a fake that shrugged at a repeat delete would hand
 * Modal destroy idempotency for free. A terminated sandbox is RETAINED and
 * reports its exit code, which is what Modal does — the sandbox record outlives
 * the sandbox, and only the volume is really removable twice.
 */
function fakeModalApi(): ModalApi {
  /** sandboxId → exit code; null means still running. */
  const sandboxes = new Map<string, number | null>();
  const volumes = new Set<string>();
  let counter = 0;

  return {
    async createSandbox(params) {
      // createIfMissing: the same runtime always reaches the same volume.
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

// ─── Rule 1: imageBinding ─────────────────────────────────────────────────────

describe("assertConforms — imageBinding", () => {
  it("rejects a driver that declares a fixed image but accepts any image", async () => {
    // Cloudflare silently ignored spec.image until we made it refuse by hand,
    // and the wrong harness booted with nothing in any log to say why.
    const driver = fakeDriver(
      { ...base, imageBinding: "fixed" },
      { provisionAcceptsAnyImage: true }
    );
    await expect(assertConforms(driver)).rejects.toThrow(/imageBinding/i);
  });

  it("rejects a driver that declares a per-instance image but refuses one", async () => {
    // The mirror image, and the one that makes the rule non-vacuous: a driver
    // that cannot honour spec.image must SAY so, because the console offers a
    // harness choice on the strength of this field.
    const driver = fakeDriver(
      { ...base, imageBinding: "per-instance" },
      { refusesAnyImageBut: FAKE_DEPLOYED_IMAGE }
    );
    await expect(assertConforms(driver)).rejects.toThrow(/imageBinding/i);
  });

  it("rejects a fixed-image driver whose refusal is not about the image", async () => {
    // A refusal the driver cannot attribute to the image is not evidence of
    // anything: an unreachable substrate rejects everything, and reading that
    // as "it enforced its declaration" would pass a driver that enforces
    // nothing the moment its config is wrong.
    const driver = fakeDriver({ ...base, imageBinding: "fixed" });
    // Deployed image unknown to the probe, so the fake refuses the probe image
    // AND the deployed one — the refusal names the image, so it conforms.
    await expect(
      assertConforms(driver, { image: FAKE_DEPLOYED_IMAGE })
    ).resolves.toBeUndefined();

    const opaque: RuntimeProvisioner = {
      ...driver,
      manifest: { ...base, imageBinding: "fixed" },
      async provision() {
        throw new Error("substrate unreachable");
      },
    };
    await expect(assertConforms(opaque)).rejects.toThrow(/imageBinding/i);
  });
});

// ─── Rule 2: supportedTiers ───────────────────────────────────────────────────

describe("assertConforms — supportedTiers", () => {
  it("rejects a driver that declares a tier it will not provision", async () => {
    // resourceTier was dropped on the floor for months: the console offered
    // three sizes and every one of them produced the same container.
    const driver = fakeDriver(
      // Sized, so the manifest is otherwise well-formed and the rule under test
      // is the behavioural one below rather than the static tierMemoryMb check.
      { ...base, supportedTiers: ["small", "large"], tierMemoryMb: { small: 1024, large: 4096 } },
      { refusesTier: "large" }
    );
    await expect(assertConforms(driver)).rejects.toThrow(/supportedTiers/i);
  });

  it("rejects a driver that provisions a tier outside supportedTiers", async () => {
    const driver = fakeDriver({ ...base, supportedTiers: ["small"] });
    // Declares small only, but the fake below accepts anything.
    const permissive: RuntimeProvisioner = {
      ...driver,
      async provision(spec: ProvisionSpec) {
        return { externalId: spec.runtimeId };
      },
    };
    await expect(assertConforms(permissive)).rejects.toThrow(/supportedTiers/i);
  });

  it("rejects a driver that offers a tier without saying how big it is", async () => {
    // Issue #279: the hub decides whether a harness fits a tier by comparing the
    // harness's measured requirement against what the tier gives. A driver that
    // declares a tier but no size for it opts itself out of that check silently
    // — and the combination that cannot work is offered anyway.
    const driver = fakeDriver({
      ...base,
      supportedTiers: ["small", "large"],
      tierMemoryMb: { small: 1024 },
    });
    await expect(assertConforms(driver)).rejects.toThrow(/tierMemoryMb/i);
  });
});

// ─── Rule 3: stopSemantics ────────────────────────────────────────────────────

describe("assertConforms — stopSemantics", () => {
  it("rejects a terminal-stop driver that also claims a start verb", async () => {
    // Modal's terminate is irreversible. There is no start to call, and a hub
    // that believed there was would leave a station "starting" forever.
    const driver = fakeDriver({
      ...base,
      workspaceStorage: "volume",
      stopSemantics: "terminal",
      lifecycle: ["start", "stop"],
    });
    await expect(assertConforms(driver)).rejects.toThrow(/stopSemantics/i);
  });

  it("rejects a terminal-stop driver that implements start without declaring it", async () => {
    const driver = fakeDriver({
      ...base,
      workspaceStorage: "volume",
      stopSemantics: "terminal",
      lifecycle: ["stop"],
    });
    (driver as { start?: unknown }).start = async () => {};
    await expect(assertConforms(driver)).rejects.toThrow(/stopSemantics/i);
  });

  it("rejects a resumable driver that implements no start()", async () => {
    // The other direction, and the one that had no rule until startRuntime
    // started BRANCHING on this field. "terminal" now routes a start into a
    // re-provision; "resumable" routes it into driver.start(). A driver that
    // declares resumable and implements no start() is therefore a runtime that
    // can be stopped and never started again — the manifest promising the
    // opposite of what the substrate can do, in the one place the hub now
    // trusts it. Until this rule existed the field was inert and the lie was
    // free.
    const driver = fakeDriver({
      ...base,
      workspaceStorage: "volume",
      stopSemantics: "resumable",
      lifecycle: ["stop", "status"],
    });
    await expect(assertConforms(driver)).rejects.toThrow(
      /stopSemantics:.*implements no start\(\)/s
    );
  });

  it("accepts a resumable driver that implements start() — the rule is not vacuous", async () => {
    // Same manifest but for the one field under test, so a rule that rejected
    // everything (or that fired on the wrong field) cannot pass unnoticed.
    const driver = fakeDriver({
      ...base,
      workspaceStorage: "volume",
      stopSemantics: "resumable",
      lifecycle: ["start", "stop", "status"],
    });
    await expect(assertConforms(driver)).resolves.toBeUndefined();
  });
});

// ─── Rule 4: workspaceStorage ─────────────────────────────────────────────────

describe("assertConforms — workspaceStorage", () => {
  it("rejects a resumable driver whose rootfs does not survive a stop", async () => {
    // The Cloudflare data loss, as a checkable rule: the claim "the workspace
    // is on the rootfs AND survives a stop" is witnessed by stopping and
    // starting the instance. A substrate that cannot resume what it stopped did
    // not keep the disk either.
    const driver = fakeDriver(
      { ...base, workspaceStorage: "rootfs", stopSemantics: "resumable" },
      { rootfsWipedOnStop: true }
    );
    await expect(assertConforms(driver)).rejects.toThrow(/workspaceStorage/i);
  });

  it("rejects a rootfs workspace on a substrate that reaps on inbound idleness", async () => {
    // Not witnessable by stopping anything: the platform destroys the instance
    // on a signal our fleet never produces, so the workspace vanishes without
    // anyone having called stop. That is what actually happened on 2026-08-12.
    const driver = fakeDriver({
      ...base,
      workspaceStorage: "rootfs",
      stopSemantics: "resumable",
      idleBehaviour: "platform-inbound",
    });
    await expect(assertConforms(driver)).rejects.toThrow(/workspaceStorage/i);
  });

  it("rejects a rootfs+resumable driver that cannot stop or start at all", async () => {
    // "Survives stop→start" from a driver with no stop and no start is a claim
    // nobody can ever check, and it reads as Docker's — the assumption that
    // cost a user their work.
    const driver = fakeDriver({
      ...base,
      workspaceStorage: "rootfs",
      stopSemantics: "resumable",
      lifecycle: ["status"],
    });
    await expect(assertConforms(driver)).rejects.toThrow(/workspaceStorage/i);
  });

  it("accepts a rootfs+resumable driver whose instance really does resume", async () => {
    await expect(assertConforms(fakeDriver(base))).resolves.toBeUndefined();
  });
});

// ─── Rule 5: status ───────────────────────────────────────────────────────────

describe("assertConforms — status", () => {
  it("rejects a status verb that answers outside the three states", async () => {
    // We shipped `stopped` without evidence once. The three states exist so a
    // driver that does not know can say so instead of guessing.
    const driver = fakeDriver(base, { statusReturns: "sleeping" });
    await expect(assertConforms(driver)).rejects.toThrow(/status/i);
  });

  it("rejects a status verb that throws when the substrate answered", async () => {
    const driver = fakeDriver(base, { statusThrows: true });
    await expect(assertConforms(driver)).rejects.toThrow(/status/i);
  });

  it("rejects a driver declaring a status verb it does not implement", async () => {
    const driver = fakeDriver(base, { omitMethods: ["status"] });
    await expect(assertConforms(driver)).rejects.toThrow(/lifecycle|status/i);
  });
});

// ─── Rule 6: destroy ──────────────────────────────────────────────────────────

describe("assertConforms — destroy", () => {
  it("rejects a driver whose second destroy throws", async () => {
    // The destroy/archive race left an archive behind after a 200, and the
    // retry that would have cleaned it up is only safe if destroy tolerates a
    // resource that is already gone. destroyRuntime turns a driver throw into a
    // 502 and leaves the row un-destroyed, so a driver that cannot be retried
    // wedges the runtime for good.
    const driver = fakeDriver(base, { destroyThrowsWhenGone: true });
    await expect(assertConforms(driver)).rejects.toThrow(/destroy/i);
  });
});

// ─── Rule 7: a redundant start/stop ───────────────────────────────────────────

describe("assertConforms — redundant start/stop", () => {
  it("rejects a driver that throws when asked to start what is already running", async () => {
    // The live defect, in one flag: Docker's 304 travelled up as an exception
    // and the hub answered 500 for a second click on Start (#284). A caller
    // cannot retry sensibly against that, and the error log stops being a place
    // where a REAL start failure is visible.
    const driver = fakeDriver(base, { startThrowsWhenRunning: true });
    await expect(assertConforms(driver)).rejects.toThrow(/start/i);
  });

  it("rejects a driver that throws when asked to stop what is already stopped", async () => {
    const driver = fakeDriver(base, { stopThrowsWhenStopped: true });
    await expect(assertConforms(driver)).rejects.toThrow(/stop\(\) is not idempotent/i);
  });
});

// ─── The load-bearing test ────────────────────────────────────────────────────

describe("assertConforms — the real drivers", () => {
  /**
   * FINDING, 2026-08-13, FIXED 2026-08-13: the real Docker driver satisfies
   * every declaration it makes. It used to fail rule 6, the one rule that
   * checks something no manifest field declares.
   *
   * assertConforms is fail-fast and destroy idempotency is the LAST thing it
   * probes, so reaching the end is itself the proof that imageBinding,
   * supportedTiers, stopSemantics, workspaceStorage (including the stop→start
   * witness) and status all passed too.
   *
   * The gap was real, not an artefact of the fake: DockerOrchestrator.deleteSandbox
   * resolves the container by name and then label and throws
   * `Sandbox not found: <id>` when neither matches, and the driver forwarded that
   * to the caller. destroyRuntime() turned it into a 502 and left the row
   * un-destroyed — so a destroy that half-succeeded (container gone, DB update
   * or a later step failed) could never be retried to completion, and the
   * runtime was wedged for good.
   *
   * The fix is one tolerance in DockerRuntimeProvisioner.destroy, pinned to that
   * exact message and to nothing else: the substrate below still throws it, and
   * a daemon that cannot be reached still fails loudly (see docker.test.ts).
   */
  it("holds the real Docker driver to every declaration, including destroy idempotency", async () => {
    await expect(assertConforms(dockerDriver())).resolves.toBeUndefined();
  });

  it("accepts the real Docker driver where the substrate itself tolerates a repeat destroy", async () => {
    // Diagnostic kept from the investigation: with the substrate forgiving a
    // delete of something already gone, the driver passed all six rules even
    // before the fix. It isolated the gap to one line and proved nothing else
    // about Docker's declarations was in question. It must keep passing — the
    // driver's own tolerance is additional to this, not a replacement for it.
    await expect(
      assertConforms(dockerDriver({ tolerateRepeatDestroy: true }))
    ).resolves.toBeUndefined();
  });

  it("accepts the real Cloudflare driver", async () => {
    await expect(
      assertConforms(cloudflareDriver(), { image: CLOUDFLARE_IMAGE })
    ).resolves.toBeUndefined();
  });

  it("REFUSES a Cloudflare driver that was never told its deployed image", async () => {
    // `imageBinding: "fixed"` is a claim about the deployment, not only about
    // the code: the driver refuses a differing image only when it knows which
    // image it was deployed with (`CLOUDFLARE_SANDBOX_IMAGE`). Unset — which is
    // how it is set nowhere in this repo — it declares "fixed" and honours
    // whatever it is handed, which is the original incident intact behind a
    // missing env var. The suite must not call that conformant.
    await expect(
      assertConforms(cloudflareDriver({ deployedImage: "" }))
    ).rejects.toThrow(/imageBinding/i);
  });

  /**
   * The point of the whole manifest exercise: Modal is the first substrate whose
   * constraints the interface was NOT accidentally designed around. Terminal
   * stop, a 24-hour ceiling, no start verb, a workspace that lives in a Volume
   * rather than on the rootfs — if the manifest generalises at all, it
   * generalises here.
   *
   * assertConforms is fail-fast and destroy idempotency is the LAST thing it
   * probes, so reaching the end is itself the proof that imageBinding,
   * supportedTiers, stopSemantics (no start verb, and none implemented),
   * workspaceStorage and status all held too.
   *
   * NO `{ image }` IS PASSED, deliberately. That argument exists for a `fixed`
   * driver, whose deployed image is a fact only its deployment knows; Modal
   * declares `imageBinding: "per-instance"` and honours any registry reference,
   * so the suite's own PROBE_IMAGE is exactly what a real caller would hand it.
   * Handing a per-instance driver a pre-vetted image would also be the one way
   * to hide a real defect: Modal refuses an image with no registry host, and if
   * the suite's probe image ever lost its host, this test passing an image of
   * its own would keep going green while the driver rejected what the suite
   * actually builds. Let it break there instead.
   */
  it("holds the real Modal driver to every declaration", async () => {
    await expect(assertConforms(modalDriver())).resolves.toBeUndefined();
  });

  it("REFUSES a Modal driver that grew a start() method", async () => {
    // stopSemantics "terminal" means terminate cannot be undone: every restart
    // is a NEW sandbox with a new id and a fresh rootfs. The hub reaches for
    // start() by method presence, so a well-meaning start() added later — not
    // declared in the manifest, so invisible to review — would have the hub
    // reporting success for something that can never happen, and a station
    // "starting" for ever. The refusal must name the field AND the method, or
    // it proves nothing about which rule fired.
    const grown = modalDriver() as RuntimeProvisioner;
    grown.start = async () => {};
    await expect(assertConforms(grown)).rejects.toThrow(
      /stopSemantics:.*implements start\(\)/s
    );
  });

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
    // No probe.image and no probe.tier: the manifest declares imageBinding
    // "per-instance" and all three tiers, so the suite builds its own spec and
    // the driver must honour it — the opposite of Cloudflare, whose fixed image
    // is a deployment fact no manifest can carry and so must be passed in.
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
});
