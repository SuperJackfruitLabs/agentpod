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

  it("fails clearly when the worker url is not configured", async () => {
    const p = new CloudflareSandboxProvisioner({ workerUrl: "", apiToken: "tok" });
    await expect(p.provision(SPEC)).rejects.toThrow(/CLOUDFLARE_WORKER_URL/);
  });
});
