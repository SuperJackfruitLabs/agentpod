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
import type { ModalApi } from "./modal-api";
import { MODAL_CREDENTIAL_KEYS } from "./modal-api";
import type { RuntimeProvisioner } from "./types";

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
