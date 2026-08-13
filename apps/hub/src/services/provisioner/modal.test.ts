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
  MODAL_WORKSPACE_PATH,
} from "./modal";
import type { ModalApi, ModalCreateSandboxParams } from "./modal-api";
import { MODAL_CREDENTIAL_KEYS, ModalNotFoundError } from "./modal-api";
import type { ProvisionSpec, ResourceTier, RuntimeProvisioner } from "./types";

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

/**
 * Deliberately typed as the INTERFACE, not the class.
 *
 * `start` is optional on RuntimeProvisioner and absent from the class, so a
 * concrete-typed view makes `driver().start` a compile error rather than the
 * runtime absence check conformance rule 3 is about — and it is the interface
 * view the hub holds when it reaches for start() by method presence.
 */
const driver = (): RuntimeProvisioner => new ModalRuntimeProvisioner({ api: inertApi });

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
    // Straight from MODAL_RESOURCE_TIERS, so the sizing the sandbox is created
    // with and the sizing the hub reasons about cannot drift apart.
    expect(m.tierMemoryMb).toEqual({ small: 1024, medium: 2048, large: 4096 });
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

  it("mounts the workspace somewhere HOME is not", () => {
    // The Volume carries the workspace and nothing else. HOME stays on the
    // disposable rootfs so the node-agent's config.json — node id and node
    // secret — dies with each sandbox and no credential is ever left at rest in
    // shared storage. A mount at "/" or "/root" would quietly undo that.
    expect(MODAL_WORKSPACE_PATH).toBe("/workspace");
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

  it("keeps distinct runtime ids on distinct volumes", () => {
    // Two runtimes sharing one Volume would have them writing over each other's
    // workspace, and the collision would only ever be visible as corrupted user
    // files — never as an error.
    expect(volumeNameFor("rt_abc")).not.toBe(volumeNameFor("rt_abd"));
  });

  it("never emits a name that ends in the truncation's leftovers", () => {
    // Truncation runs after the character scrub, so a runtime id long enough to
    // be cut at a separator would otherwise yield a trailing dash — a name
    // shape Modal has no reason to accept, produced only by ids long enough
    // that no unit test would normally reach them.
    const long = `rt_${"a".repeat(46)}_tail`;
    const name = volumeNameFor(long);
    expect(name.endsWith("-")).toBe(false);
    expect(name.startsWith("agentpod-")).toBe(true);
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

  // The half-empty cases, each separately, because this is the exact hole the
  // Fly driver shipped: a codec that let an empty half through built a URL
  // addressing nothing, whose 404 the destroy path then read as "already gone"
  // — leaking a machine and its volume with a 200 on the way out. A guard that
  // rejects only the no-separator form would pass the test above and still
  // leave both of these open.
  it("refuses an external id with no volume half", () => {
    expect(() => decodeExternalId("#sb-123")).toThrow(/external id/i);
  });

  it("refuses an external id with no sandbox half", () => {
    expect(() => decodeExternalId("agentpod-rt-abc#")).toThrow(/external id/i);
  });

  it("refuses an empty external id", () => {
    expect(() => decodeExternalId("")).toThrow(/external id/i);
  });

  it("refuses an id carrying a third field rather than guessing which two count", () => {
    expect(() => decodeExternalId("a#b#c")).toThrow(/external id/i);
  });

  it("names the id it rejected", () => {
    // An unattributed refusal is indistinguishable from an unreachable
    // substrate — the same reasoning conformance.ts applies to image and tier
    // refusals.
    expect(() => decodeExternalId("sb-123")).toThrow(/sb-123/);
  });
});

describe("modal credential keys", () => {
  it("declares both tokens, so a half-configured hub is refused naming each", () => {
    // requireCredentials() reports every missing key at once; declaring only
    // one here would cost an operator a redeploy per key.
    expect(MODAL_CREDENTIAL_KEYS).toEqual(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]);
  });
});

describe("ModalRuntimeProvisioner — provision", () => {
  it("anchors the workspace in a volume named after the RUNTIME, not the sandbox", async () => {
    const modal = fakeModal();
    const res = await new ModalRuntimeProvisioner({ api: modal.api }).provision(SPEC);

    expect(modal.created[0]!.volumeName).toBe("agentpod-rt-abc123");
    expect(modal.created[0]!.mountPath).toBe("/workspace");
    // The composite id: the hub stores one string, and this driver needs both
    // the volume that survives and the sandbox that does not. The volume half
    // must be the volume that was actually mounted — destroy() deletes what
    // this string names, and a mismatch would delete a live runtime's anchor.
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

  it("gives two DIFFERENT runtimes two different volumes", async () => {
    // The anchor's other direction. Reusing a volume across runtimes is the
    // same class of silent failure as failing to reuse it within one: two
    // stations writing over each other's workspace, visible only as corrupted
    // user files and never as an error.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);
    await driver.provision({ ...SPEC, runtimeId: "rt_other" });

    expect(modal.created[1]!.volumeName).not.toBe(modal.created[0]!.volumeName);
    expect(modal.volumes.size).toBe(2);
  });

  it("injects the hub url and the enrolment token, and sets no idle timer", async () => {
    const modal = fakeModal();
    await new ModalRuntimeProvisioner({ api: modal.api }).provision(SPEC);
    const params = modal.created[0]!;
    expect(params.env.AGENTPOD_HUB_URL).toBe("https://hub.example");
    expect(params.env.AGENTPOD_ENROLL_TOKEN).toBe("enr_secret");
    expect(params.command).toEqual(["/modal-entrypoint.sh"]);
    expect(params.workdir).toBe("/workspace");
    // Asserted HERE and not only in the adapter's test, because the adapter
    // forwards what it is handed: idle reaping is opt-in on Modal, and opting
    // in would reap a busy station whose agent only ever dials out — the exact
    // trap that tore down live Cloudflare sandboxes on 2026-08-12.
    expect(params).not.toHaveProperty("idleTimeoutMs");
  });

  it("sets the sandbox timeout to the declared ceiling", async () => {
    // Modal's default is five minutes. A station that dies in five minutes is
    // not a station, and nothing in the API warns you.
    const modal = fakeModal();
    await new ModalRuntimeProvisioner({ api: modal.api }).provision(SPEC);
    expect(modal.created[0]!.timeoutMs).toBe(86_400_000);
  });

  it("uses the CONFIGURED lifetime, so timeoutMs and the manifest never disagree", async () => {
    // sweepExpiringRuntimes rotates on manifest.maxLifetimeMs; the sandbox dies
    // on timeoutMs. A hardcoded day here would pass the test above and still
    // let a hub configured for a shorter ceiling — the ten-minute setting that
    // exists so rotation can be verified at all — rotate against a sandbox
    // Modal is keeping alive for twenty-four hours.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api, maxLifetimeMs: 600_000 });
    await driver.provision(SPEC);
    // Both against the same number on purpose: what the sandbox is given and
    // what the manifest promises are the two halves that must not drift.
    expect(modal.created[0]!.timeoutMs).toBe(600_000);
    expect(driver.manifest.maxLifetimeMs).toBe(600_000);
  });

  it("honours the resource tier instead of quietly rounding it", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision({ ...SPEC, resourceTier: "small" });
    await driver.provision({ ...SPEC, runtimeId: "rt_two", resourceTier: "large" });
    expect(modal.created[0]).toMatchObject({ cpu: 0.5, memoryMiB: 1024 });
    expect(modal.created[1]).toMatchObject({ cpu: 2, memoryMiB: 4096 });
  });

  it("refuses a tier it has no sizing for, naming it", async () => {
    // Not reachable through the typed API, but reachable from a DB row written
    // before a tier was renamed. Without the guard the lookup yields undefined
    // and the sandbox is created with cpu: undefined — a sizing decision made
    // by Modal's defaults, silently, for a tier the operator chose.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(
      driver.provision({ ...SPEC, resourceTier: "gigantic" as ResourceTier })
    ).rejects.toThrow(/gigantic/);
    expect(modal.created).toEqual([]);
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

  it("creates NOTHING when it refuses, leaving no volume behind to bill for", async () => {
    // A refusal raised after the volume exists leaves a paid, empty anchor with
    // no runtime row pointing at it — invisible in the console and billed
    // monthly. Refuse first, touch the substrate second.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(
      driver.provision({ ...SPEC, image: "agentpod-node:local" })
    ).rejects.toThrow();
    expect(modal.created).toEqual([]);
    expect(modal.volumes.size).toBe(0);
  });
});

describe("ModalRuntimeProvisioner — stop", () => {
  it("terminates the sandbox in the composite id", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.stop(externalId);
    expect(modal.terminated).toEqual(["sb-1"]);
  });

  it("terminates the sandbox half, never the volume half", async () => {
    // The composite id carries two names and terminateSandbox takes one string.
    // Handing it the volume half would terminate nothing, tolerate the
    // resulting not-found as success, and report a stop that never happened —
    // with the sandbox still running and still billing.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);
    await driver.stop("agentpod-rt-abc123#sb-1");
    expect(modal.terminated).toEqual(["sb-1"]);
    expect(modal.sandboxes.get("sb-1")).not.toBeNull();
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
    // Modal has no start verb, so the sandbox behind an externalId can already
    // be gone by the time an operator presses Stop — the 24-hour ceiling takes
    // one every day. "Already in the state you asked for" is a success.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(driver.stop("agentpod-rt-abc123#sb-never")).resolves.toBeUndefined();
  });

  it("does NOT swallow a substrate failure — only not-found is tolerable", async () => {
    // Tolerating "already gone" must not slide into tolerating everything.
    // stopRuntime() writes `stopping` after stop() resolves and then trusts
    // status() for the rest; a stop() that resolved on a connection reset would
    // hand a runtime that is still running to a path built to confirm one that
    // is not.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.api.terminateSandbox = async () => {
      throw new Error("connection reset");
    };
    await expect(driver.stop(externalId)).rejects.toThrow(/connection reset/);
  });

  it("refuses a malformed external id instead of terminating something else", async () => {
    // A stop that quietly resolved on an unparseable id would report a stop
    // that could not have happened, for a runtime nothing had addressed.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);
    await expect(driver.stop("sb-1")).rejects.toThrow(/external id/i);
    expect(modal.terminated).toEqual([]);
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
    // stop.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    await driver.stop(externalId);
    expect(await driver.status(externalId)).toBe("stopped");
  });

  it("reports stopped for exit code 0 — a clean exit is still an exit", async () => {
    // poll() answers `null` while running and the EXIT CODE once finished, and
    // 0 is both a valid exit code and falsy. A truthiness test here inverts the
    // answer for the one exit that means "the work finished cleanly": the hub
    // would read a finished sandbox as running, leave a stop unconfirmed, and
    // flip the runtime to `error` five minutes later.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.sandboxes.set("sb-1", 0);
    expect(await driver.status(externalId)).toBe("stopped");
  });

  it("reports stopped for a sandbox Modal says does not exist", async () => {
    // A ModalNotFoundError is an ANSWER, not a silence: an authenticated call
    // reached Modal and Modal asserted there is no such sandbox in this
    // workspace. Nothing that does not exist is running, and nothing that does
    // not exist is billing, so `stopped` is the true statement. `unknown` here
    // would put every stop of an already-reaped sandbox — and Modal reaps one
    // per runtime per day — through sweepStalledRuntimeStops' 5-minute timeout
    // and out the other side as `error: check the substrate before assuming
    // this runtime has stopped costing money`, an alarm about a bill nobody is
    // paying.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    expect(await driver.status("agentpod-rt-abc123#sb-never")).toBe("stopped");
  });

  it("propagates a transport failure instead of inventing an answer", async () => {
    // probeState() in runtimes.ts logs it and degrades to `unknown`, which the
    // stop sweeper escalates to `error` after five minutes. Answering `stopped`
    // here would launder an unreachable substrate into the one word an operator
    // reads as "it has stopped costing me money".
    const modal = fakeModal();
    modal.api.pollSandbox = async () => {
      throw new Error("connection reset");
    };
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(driver.status("agentpod-rt-abc123#sb-1")).rejects.toThrow(/connection reset/);
  });

  it("propagates an auth failure rather than reporting the whole fleet stopped", async () => {
    // The failure this rule exists for: an expired MODAL_TOKEN_SECRET makes
    // EVERY call fail at once, so a driver that mapped any error to `stopped`
    // would report every Modal runtime in the fleet as stopped simultaneously
    // while all of them keep running and billing. Only ModalNotFoundError —
    // Modal's positive statement about one sandbox — is an answer.
    const modal = fakeModal();
    modal.api.pollSandbox = async () => {
      throw new Error("401 Unauthorized: invalid token");
    };
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(driver.status("agentpod-rt-abc123#sb-1")).rejects.toThrow(/401/);
  });

  it("refuses a malformed external id instead of guessing at one half", async () => {
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);
    await expect(driver.status("sb-1")).rejects.toThrow(/external id/i);
  });

  it("asks and nothing more — status never terminates or deletes", async () => {
    // status() runs on the sweeper's 15-second tick against every stopping
    // runtime. A verb that mutated anything would be doing it repeatedly, in
    // the background, to runtimes nobody touched.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    expect(await driver.status(externalId)).toBe("running");
    expect(modal.terminated).toEqual([]);
    expect(modal.deletedVolumes).toEqual([]);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);
  });
});

describe("ModalRuntimeProvisioner — destroy", () => {
  it("takes the sandbox AND the volume", async () => {
    // The one verb where forgetting the Volume costs money forever. A Modal
    // Volume outlives every sandbox that mounted it and bills for as long as it
    // exists, so a destroy that only terminated would leave a permanent charge
    // with no console row left to explain it.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);

    await driver.destroy(externalId);

    expect(modal.terminated).toEqual(["sb-1"]);
    expect(modal.deletedVolumes).toEqual(["agentpod-rt-abc123"]);
    // Not just "delete was called": the anchor is actually gone from the
    // substrate. This is the assertion a silently-skipped delete cannot pass.
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(false);
  });

  it("terminates the sandbox BEFORE deleting the volume it has mounted", async () => {
    // Order is not cosmetic here. Deleting a Volume still mounted by a live
    // sandbox is a race Modal is under no obligation to make pleasant, and if
    // the process dies between the two steps the surviving state must be the
    // cheap, retryable one: sandbox down, volume present, externalId still on
    // the row. Reversed, the same crash leaves compute running against a
    // workspace that no longer exists — the larger bill and the unrecoverable
    // half.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);

    const order: string[] = [];
    const terminate = modal.api.terminateSandbox;
    const remove = modal.api.deleteVolume;
    modal.api.terminateSandbox = async (id) => {
      order.push("terminate");
      return terminate(id);
    };
    modal.api.deleteVolume = async (name) => {
      order.push("deleteVolume");
      return remove(name);
    };

    await driver.destroy(externalId);

    expect(order).toEqual(["terminate", "deleteVolume"]);
  });

  it("is idempotent — a second destroy resolves", async () => {
    // Conformance rule 6, and not a theoretical one: destroyRuntime() turns a
    // driver throw into a 502 and leaves the row un-destroyed, so a retry that
    // threw on "already gone" could never finish a half-done destroy — the
    // runtime would be wedged permanently, which is exactly the bug found in
    // the Docker driver.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);

    await driver.destroy(externalId);
    await expect(driver.destroy(externalId)).resolves.toBeUndefined();
    // And the second pass invents no new work.
    expect(modal.deletedVolumes).toEqual(["agentpod-rt-abc123"]);
  });

  it("resolves for a runtime this substrate has never heard of", async () => {
    // The hub can hold an externalId whose sandbox and volume are both long
    // gone — a workspace deleted from Modal's dashboard, a row restored from a
    // backup. Destroying that must reach the state the caller asked for, not a
    // 502 that leaves the row alive for ever.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await expect(
      driver.destroy("agentpod-rt-gone#sb-gone")
    ).resolves.toBeUndefined();
  });

  it("still deletes the volume when the sandbox is already gone", async () => {
    // The likeliest half-done destroy on this substrate: the 24-hour ceiling
    // already took the sandbox and the Volume is all that is left — which is
    // also the only half still billing. A destroy that gave up at the
    // not-found terminate would leak precisely the expensive part.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.sandboxes.delete("sb-1");

    await driver.destroy(externalId);

    expect(modal.deletedVolumes).toEqual(["agentpod-rt-abc123"]);
  });

  it("still terminates the sandbox when the volume is already gone", async () => {
    // The mirror case, and the more expensive one: a Volume removed by hand
    // leaves a sandbox running and billing compute. Tolerating the volume's
    // absence must not come at the price of leaving that sandbox alive.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.volumes.delete("agentpod-rt-abc123");

    await expect(driver.destroy(externalId)).resolves.toBeUndefined();
    expect(modal.terminated).toEqual(["sb-1"]);
  });

  it("does NOT swallow a substrate failure on the volume delete", async () => {
    // Tolerating "already gone" must not become tolerating everything. A
    // destroy that resolved on a connection reset would have destroyRuntime()
    // write `destroyed` and forget the externalId — and the Volume it named
    // would bill for ever with nothing left anywhere that could address it.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.api.deleteVolume = async () => {
      throw new Error("connection reset");
    };

    await expect(driver.destroy(externalId)).rejects.toThrow(/connection reset/);
  });

  it("does NOT swallow an auth failure on the volume delete", async () => {
    // An expired MODAL_TOKEN_SECRET fails every call at once. A bare catch here
    // would report a successful destroy for every Modal runtime in the fleet
    // while none of them were deleted and all of them kept billing.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.api.deleteVolume = async () => {
      throw new Error("401 Unauthorized: invalid token");
    };

    await expect(driver.destroy(externalId)).rejects.toThrow(/401/);
  });

  it("does NOT swallow a substrate failure on the terminate, and leaves the volume alone", async () => {
    // Two rules in one. The throw must surface — a destroy that resolved here
    // would forget a still-running sandbox. And the Volume must survive: with
    // the terminate unconfirmed the sandbox may well still be mounting it, and
    // the retry needs the anchor intact to finish the job properly.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);
    modal.api.terminateSandbox = async () => {
      throw new Error("connection reset");
    };

    await expect(driver.destroy(externalId)).rejects.toThrow(/connection reset/);
    expect(modal.deletedVolumes).toEqual([]);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);
  });

  it("converges on retry after a partial destroy — the volume is really taken", async () => {
    // The money case end to end. First attempt: sandbox terminated, volume
    // delete fails on transport, driver throws, destroyRuntime() 502s and the
    // row keeps its externalId. Second attempt, once the substrate is back: the
    // already-terminated sandbox is tolerated and the Volume — the half that is
    // still billing — is finally gone. If this did not converge, the only way
    // to stop paying would be Modal's dashboard.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    const { externalId } = await driver.provision(SPEC);

    const remove = modal.api.deleteVolume;
    modal.api.deleteVolume = async () => {
      throw new Error("connection reset");
    };
    await expect(driver.destroy(externalId)).rejects.toThrow(/connection reset/);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);

    modal.api.deleteVolume = remove;
    await expect(driver.destroy(externalId)).resolves.toBeUndefined();
    expect(modal.deletedVolumes).toEqual(["agentpod-rt-abc123"]);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(false);
  });

  it("refuses a malformed external id instead of destroying something else", async () => {
    // A bare sandbox id names no volume. Guessing one — or handing the whole
    // string to either call — would either delete another runtime's anchor or
    // resolve on a not-found while the real sandbox kept running.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);

    await expect(driver.destroy("sb-1")).rejects.toThrow(/external id/i);
    expect(modal.terminated).toEqual([]);
    expect(modal.deletedVolumes).toEqual([]);
  });

  it("refuses an id with an empty volume half rather than reporting a false success", async () => {
    // This is the Fly driver's shipped bug, transplanted: a codec that let an
    // empty half through addressed nothing, and the not-found that came back
    // was read by destroy as "already gone" — a 200 on the way out while a
    // machine and its volume kept billing. Tolerating not-found makes the codec
    // the ONLY thing standing between a bypass and a silent leak.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);

    await expect(driver.destroy("#sb-1")).rejects.toThrow(/external id/i);
    expect(modal.terminated).toEqual([]);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);
  });

  it("refuses an id with an empty sandbox half rather than taking the volume anyway", async () => {
    // The other direction, and worse: proceeding would delete a live runtime's
    // workspace while its sandbox kept running, having tolerated the empty
    // sandbox id's not-found as success.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC);

    await expect(driver.destroy("agentpod-rt-abc123#")).rejects.toThrow(/external id/i);
    expect(modal.deletedVolumes).toEqual([]);
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);
  });

  it("deletes the volume half and terminates the sandbox half, never swapped", async () => {
    // Both calls take a bare string, so swapping them is a one-character typo
    // that not-found tolerance would hide completely: every call would raise
    // ModalNotFoundError, both would be swallowed, and destroy would resolve
    // having deleted nothing at all. Two live runtimes make the swap visible.
    const modal = fakeModal();
    const driver = new ModalRuntimeProvisioner({ api: modal.api });
    await driver.provision(SPEC); // agentpod-rt-abc123 # sb-1
    await driver.provision({ ...SPEC, runtimeId: "rt_other" }); // agentpod-rt-other # sb-2

    await driver.destroy(encodeExternalId("agentpod-rt-other", "sb-1"));

    expect(modal.terminated).toEqual(["sb-1"]);
    expect(modal.deletedVolumes).toEqual(["agentpod-rt-other"]);
    // The untouched runtime is untouched.
    expect(modal.volumes.has("agentpod-rt-abc123")).toBe(true);
    expect(modal.sandboxes.get("sb-2")).toBeNull();
  });
});
