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
  resourceTier: "large",
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
    callbackToken: "cbtok",
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

  it("sends the hub url, enrolment token and callback token", async () => {
    const { impl, calls } = fakeFetch({ sandboxId: "rt_abc" });
    await make(impl).provision(SPEC);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.hubUrl).toBe(SPEC.hubUrl);
    expect(body.enrollToken).toBe(SPEC.enrollToken);
    expect(body.id).toBe(SPEC.runtimeId);
    // Without this the container cannot tell the hub it slept, and every
    // sleeping station would read as offline.
    expect(body.callbackToken).toBe("cbtok");
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

  /**
   * Issue #284's question, asked of this substrate: what does Cloudflare answer
   * for a start on a container that is already running?
   *
   * ESTABLISHED FROM THE CODE, not assumed: the worker's `/start` route calls
   * `Container.wake()` → `start()`, and `@cloudflare/containers`
   * (dist/lib/container.js, the version this repo's worker builds against)
   * implements that as `startContainerIfNotRunning`, whose fast path is
   * `if (this.container.running) return 0`. `stop()` is the same shape:
   * `if (this.container.running) this.container.signal(...)`. Neither raises.
   *
   * So this substrate is already idempotent one layer down: the worker answers
   * 200 and the driver sees a plain success. There is nothing for the driver to
   * map, and inventing a mapping here would be a claim about a response
   * Cloudflare does not send.
   */
  it("has no already-in-target-state error to map: the substrate is idempotent", async () => {
    const started = fakeFetch({ started: "rt_abc" }, 200);
    // Repeat the call the console repeats. Nothing throws, and the driver adds
    // no no-op flag, because the substrate never said one thing or the other.
    await make(started.impl).start!("rt_abc");
    const outcome = await make(started.impl).start!("rt_abc");
    expect(outcome ?? undefined).toBeUndefined();

    const stopped = fakeFetch({ stopped: "rt_abc" }, 200);
    await make(stopped.impl).stop!("rt_abc");
    expect((await make(stopped.impl).stop!("rt_abc")) ?? undefined).toBeUndefined();
  });

  it("still fails when the worker refuses a start or a stop", async () => {
    // The tolerance elsewhere must not become a habit here. A worker that
    // answers 500 has not told us the container is running or stopped, and this
    // driver has no `status` on the error to narrow a benign case with — its
    // call() throws one shape for every non-2xx.
    const failed = fakeFetch({ error: "boom" }, 500);
    await expect(make(failed.impl).start!("rt_abc")).rejects.toThrow(/500/);
    await expect(make(failed.impl).stop!("rt_abc")).rejects.toThrow(/500/);
  });

  it("touches the activity route so an in-use station does not idle out", async () => {
    const { impl, calls } = fakeFetch({ touched: "rt_abc" }, 200);
    await make(impl).touch("rt_abc");
    expect(calls[0]!.url).toBe("https://w.example/sandbox/rt_abc/touch");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("REFUSES a resource tier the deployed worker cannot provide", async () => {
    // Cloudflare fixes instance_type per container class, so a tier this worker
    // was not deployed with cannot be honoured. Refusing is the same rule the
    // image already follows — silently ignoring an input is how the dead driver
    // failed, and today this driver drops resourceTier on the floor.
    const { impl } = fakeFetch({ sandboxId: "rt_abc" });
    await expect(
      make(impl).provision({ ...SPEC, resourceTier: "small" })
    ).rejects.toThrow(/resource tier/i);
  });

  it("accepts the tier the worker was deployed with", async () => {
    const { impl } = fakeFetch({ sandboxId: "rt_abc" });
    const res = await make(impl).provision({ ...SPEC, resourceTier: "large" });
    expect(res.externalId).toBe("rt_abc");
  });

  // ── status(): the only evidence the hub has for writing "stopped" ──────────

  it("reports the container state the worker gives it", async () => {
    const { impl, calls } = fakeFetch({ sandboxId: "rt_abc", state: "stopped" }, 200);
    expect(await make(impl).status!("rt_abc")).toBe("stopped");
    expect(calls[0]!.url).toBe("https://w.example/sandbox/rt_abc");
  });

  it("reports running while the container is still up", async () => {
    const { impl } = fakeFetch({ sandboxId: "rt_abc", state: "running" }, 200);
    expect(await make(impl).status!("rt_abc")).toBe("running");
  });

  it("says unknown against a worker that does not report state yet", async () => {
    // The pre-deploy shape: GET /sandbox/:id answered {sandboxId} and nothing
    // else. Reading a missing field as "stopped" would recreate the exact bug
    // this exists to fix, on a worker that had simply not been redeployed.
    const { impl } = fakeFetch({ sandboxId: "rt_abc" }, 200);
    expect(await make(impl).status!("rt_abc")).toBe("unknown");
  });

  it("says unknown for a state it does not recognise", async () => {
    const { impl } = fakeFetch({ sandboxId: "rt_abc", state: "sleeping-ish" }, 200);
    expect(await make(impl).status!("rt_abc")).toBe("unknown");
  });

  it("fails clearly when the worker url is not configured", async () => {
    const p = new CloudflareSandboxProvisioner({ workerUrl: "", apiToken: "tok" });
    await expect(p.provision(SPEC)).rejects.toThrow(/CLOUDFLARE_WORKER_URL/);
  });

  // ── manifest: the refusals above, said out loud ────────────────────────────

  it("declares the constraints that made this driver refuse things", () => {
    const m = new CloudflareSandboxProvisioner({ deployedTier: "large" }).manifest;
    // Every value here is a fact this driver already enforces by hand.
    expect(m.workspaceStorage).toBe("external-archive"); // R2, because the disk is wiped on sleep
    expect(m.stopSemantics).toBe("resumable");
    expect(m.imageBinding).toBe("fixed"); // baked at worker deploy time
    expect(m.supportedTiers).toEqual(["large"]); // instance_type is fixed per class
    expect(m.idleBehaviour).toBe("platform-inbound"); // sleepAfter, fed by inbound requests only
    expect(m.maxLifetimeMs).toBeNull();
    expect(m.lifecycle).toEqual(
      expect.arrayContaining(["start", "stop", "status"])
    );
  });

  it("declares the tier the worker was actually deployed with, not a constant", () => {
    // provision() refuses anything but deployedTier. If the manifest hardcoded
    // "large", a worker deployed at another instance type would advertise a tier
    // it then refuses — two sources of one truth, drifting.
    const p = new CloudflareSandboxProvisioner({ deployedTier: "small" });
    expect(p.manifest.supportedTiers).toEqual(["small"]);
  });

  it("declares memory for the deployed tier only, and for no other", () => {
    // A fixed-instance substrate is the case that makes harness-aware tiers
    // more than a filter: a worker deployed `small` cannot run opencode AT ALL,
    // and the manifest has to be able to say that. Declaring sizes for tiers
    // this worker does not offer would invent an answer for a machine that does
    // not exist.
    const large = new CloudflareSandboxProvisioner({ deployedTier: "large" }).manifest;
    expect(large.tierMemoryMb).toEqual({ large: 4096 });

    const small = new CloudflareSandboxProvisioner({ deployedTier: "small" }).manifest;
    expect(small.tierMemoryMb).toEqual({ small: 1024 });
  });
});
