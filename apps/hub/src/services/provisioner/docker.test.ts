/**
 * Unit tests: DockerRuntimeProvisioner (P4 Task 5)
 *
 * Pure unit test — no real Docker daemon.  All Docker interactions go through
 * a FakeDockerOrchestrator that captures calls and returns controlled responses.
 *
 * RED → GREEN: run `cd apps/hub && bun test provisioner/docker`
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DockerRuntimeProvisioner } from "./docker";
import type { DockerOrchestrator, SandboxConfig, Sandbox } from "./docker-orchestrator";

// ─── Fake container id returned by the fake orchestrator ─────────────────────

const FAKE_CONTAINER_ID = "deadbeef000000000000000000000000";

// ─── Recorded call shape ──────────────────────────────────────────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

// ─── Fake orchestrator ────────────────────────────────────────────────────────

/**
 * Minimal fake that implements only the four methods used by
 * DockerRuntimeProvisioner.  Cast to DockerOrchestrator via `as unknown`.
 */
class FakeDockerOrchestrator {
  readonly calls: RecordedCall[] = [];
  capturedConfig: SandboxConfig | null = null;
  /** What inspect would report as the container's runtime. */
  runtimeToReport: string | undefined = undefined;
  /** Set to make createSandbox throw, as Docker does for an unknown runtime. */
  createError: Error | null = null;
  /** Set to make deleteSandbox throw, as the orchestrator does for a missing container. */
  deleteError: Error | null = null;

  async createSandbox(config: SandboxConfig): Promise<Sandbox> {
    if (this.createError) throw this.createError;
    this.capturedConfig = config;
    this.calls.push({ method: "createSandbox", args: [config] });
    return {
      id: config.id,
      containerId: FAKE_CONTAINER_ID,
      name: config.name,
      status: "running",
      urls: {},
      createdAt: new Date(),
      image: config.image,
      runtime: this.runtimeToReport,
    };
  }

  async startSandbox(id: string): Promise<void> {
    this.calls.push({ method: "startSandbox", args: [id] });
  }

  async stopSandbox(id: string, timeout?: number): Promise<void> {
    this.calls.push({ method: "stopSandbox", args: [id, timeout] });
  }

  async deleteSandbox(id: string, removeVolumes: boolean): Promise<void> {
    this.calls.push({ method: "deleteSandbox", args: [id, removeVolumes] });
    if (this.deleteError) throw this.deleteError;
  }

  /** Helper: find a recorded call by method name */
  callTo(method: string): RecordedCall | undefined {
    return this.calls.find((c) => c.method === method);
  }

  /** Helper: count recorded calls by method name */
  countCalls(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvisioner(fake: FakeDockerOrchestrator): DockerRuntimeProvisioner {
  return new DockerRuntimeProvisioner(fake as unknown as DockerOrchestrator);
}

// Use a sentinel image that differs from the NODE_AGENT_IMAGE fallback — this
// proves the driver reads spec.image, not the env var.
const BASE_SPEC = {
  runtimeId: "rt_1",
  name: "box1",
  image: "agentpod-node-opencode:local",
  resourceTier: "small" as const,
  hubUrl: "http://h:3001",
  enrollToken: "enr_x",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DockerRuntimeProvisioner", () => {
  it('provider === "docker"', () => {
    const p = makeProvisioner(new FakeDockerOrchestrator());
    expect(p.provider).toBe("docker");
  });

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

  describe("provision", () => {
    it("calls createSandbox exactly once", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.countCalls("createSandbox")).toBe(1);
    });

    it("passes spec.runtimeId as the SandboxConfig id (orchestrator lookup key)", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.capturedConfig!.id).toBe(BASE_SPEC.runtimeId);
    });

    it("returns externalId equal to spec.runtimeId (not the hex container id)", async () => {
      const fake = new FakeDockerOrchestrator();
      const result = await makeProvisioner(fake).provision(BASE_SPEC);
      // The orchestrator resolves containers by name "agentpod-<id>" or
      // label agentpod.sandbox.id=<id>, keyed on the sandbox config.id = runtimeId.
      // destroy/start/stop forward externalId directly to those methods.
      expect(result.externalId).toBe(BASE_SPEC.runtimeId);
      expect(result.externalId).not.toBe(FAKE_CONTAINER_ID);
    });

    it("passes spec.image to the createSandbox config (driver is image-agnostic)", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      // The sentinel "agentpod-node-opencode:local" must reach the orchestrator,
      // proving the driver uses spec.image and does NOT read NODE_AGENT_IMAGE.
      expect(fake.capturedConfig!.image).toBe(BASE_SPEC.image);
    });

    it("ignores NODE_AGENT_IMAGE env; always uses spec.image", async () => {
      process.env.NODE_AGENT_IMAGE = "my-registry/agentpod-node:v2";
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      // env override is irrelevant — spec.image wins
      expect(fake.capturedConfig!.image).toBe(BASE_SPEC.image);
      delete process.env.NODE_AGENT_IMAGE;
    });

    it("sets AGENTPOD_HUB_URL in env", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.capturedConfig!.env["AGENTPOD_HUB_URL"]).toBe("http://h:3001");
    });

    it("sets AGENTPOD_ENROLL_TOKEN in env", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.capturedConfig!.env["AGENTPOD_ENROLL_TOKEN"]).toBe("enr_x");
    });

    it("sets agentpod.runtime.id label to spec.runtimeId", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.capturedConfig!.labels["agentpod.runtime.id"]).toBe("rt_1");
    });

    it('sets agentpod.managed label to "true"', async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.capturedConfig!.labels["agentpod.managed"]).toBe("true");
    });

    it("maps resourceTier small to low CPU/memory", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision({ ...BASE_SPEC, resourceTier: "small" });
      expect(fake.capturedConfig!.resources.cpus).toBe("0.5");
      expect(fake.capturedConfig!.resources.memory).toBe("1g");
    });

    it("maps resourceTier medium to 1 CPU / 2g memory", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision({ ...BASE_SPEC, resourceTier: "medium" });
      expect(fake.capturedConfig!.resources.cpus).toBe("1.0");
      expect(fake.capturedConfig!.resources.memory).toBe("2g");
    });

    it("maps resourceTier large to 2 CPU / 4g memory", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision({ ...BASE_SPEC, resourceTier: "large" });
      expect(fake.capturedConfig!.resources.cpus).toBe("2.0");
      expect(fake.capturedConfig!.resources.memory).toBe("4g");
    });

    it("opens no ports (node-agent does not expose a preview port)", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).provision(BASE_SPEC);
      expect(fake.capturedConfig!.ports).toHaveLength(0);
    });
  });

  describe("destroy", () => {
    it("calls deleteSandbox with the given id", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).destroy("c1");
      const call = fake.callTo("deleteSandbox");
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe("c1");
    });

    it("passes removeVolumes=true to deleteSandbox", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).destroy("c1");
      const call = fake.callTo("deleteSandbox");
      expect(call!.args[1]).toBe(true);
    });

    it("succeeds when the container is already gone (conformance rule 6)", async () => {
      // The orchestrator resolves a container by name and then label and throws
      // `Sandbox not found: <id>` when neither matches. destroyRuntime turns a
      // driver throw into a 502 and leaves the row un-destroyed, so a destroy
      // that half-succeeded — container removed, a later step failed — could
      // never be retried to completion and wedged the runtime for good.
      // Nothing to remove is the goal state, not a failure.
      const fake = new FakeDockerOrchestrator();
      fake.deleteError = new Error("Sandbox not found: c1");
      await expect(makeProvisioner(fake).destroy("c1")).resolves.toBeUndefined();
    });

    it("still fails when the daemon itself cannot be reached", async () => {
      // The tolerance above must stay pinned to the daemon's "no such container"
      // answer. A socket that will not connect is silence, not an answer — the
      // container may well be running and billing — and reporting a successful
      // destroy for it is a worse bug than the one being fixed.
      const fake = new FakeDockerOrchestrator();
      fake.deleteError = new Error("connect ENOENT /var/run/docker.sock");
      await expect(makeProvisioner(fake).destroy("c1")).rejects.toThrow(/ENOENT/);
    });
  });

  describe("start", () => {
    it("calls startSandbox with the given id", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).start("c1");
      const call = fake.callTo("startSandbox");
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe("c1");
    });
  });

  describe("stop", () => {
    it("calls stopSandbox with the given id", async () => {
      const fake = new FakeDockerOrchestrator();
      await makeProvisioner(fake).stop("c1");
      const call = fake.callTo("stopSandbox");
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe("c1");
    });
  });
});

// ─── Runtime selection ────────────────────────────────────────────────────────

describe("DockerRuntimeProvisioner runtime selection", () => {
  const ORIGINAL = process.env.DOCKER_RUNTIME;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DOCKER_RUNTIME;
    else process.env.DOCKER_RUNTIME = ORIGINAL;
  });

  const SPEC = {
    runtimeId: "rt_1",
    name: "n",
    resourceTier: "small" as const,
    hubUrl: "https://hub.example",
    enrollToken: "enr_x",
    image: "agentpod-node:local",
  };

  it("returns the runtime the orchestrator observed, not the one configured", async () => {
    // The whole point of the field. If config says runsc and Docker actually
    // ran runc, we must record runc — that mismatch is what this catches, and
    // recording the request instead would hide it forever.
    process.env.DOCKER_RUNTIME = "runsc";

    const fake = new FakeDockerOrchestrator();
    fake.runtimeToReport = "runc"; // Docker disagreed with us

    const res = await makeProvisioner(fake).provision(SPEC);
    expect(res.runtime).toBe("runc");
  });

  it("omits runtime when the orchestrator reports none", async () => {
    delete process.env.DOCKER_RUNTIME;

    const fake = new FakeDockerOrchestrator();
    fake.runtimeToReport = undefined;

    const res = await makeProvisioner(fake).provision(SPEC);
    expect(res.runtime).toBeUndefined();
    // externalId is the runtimeId, NOT the container id — destroy/start/stop
    // look the container up by name "agentpod-<id>", so this is the lifecycle
    // key and must not drift.
    expect(res.externalId).toBe(SPEC.runtimeId);
  });

  it("surfaces an unavailable runtime as a failure, never a silent fallback", async () => {
    // Docker rejects an unknown runtime at create. That must reach the caller:
    // quietly running under runc would leave the operator believing they had
    // kernel isolation when they had none.
    process.env.DOCKER_RUNTIME = "not-installed";

    const fake = new FakeDockerOrchestrator();
    fake.createError = new Error("Unknown runtime specified not-installed");

    await expect(makeProvisioner(fake).provision(SPEC)).rejects.toThrow(/not-installed/);
  });
});

describe("DockerRuntimeProvisioner.status", () => {
  /** Fake that answers inspectSandbox with whatever the test wants. */
  class InspectingFake extends FakeDockerOrchestrator {
    statusToReport: Sandbox["status"] = "running";
    inspectError: Error | null = null;

    async inspectSandbox(id: string): Promise<Sandbox> {
      this.calls.push({ method: "inspectSandbox", args: [id] });
      if (this.inspectError) throw this.inspectError;
      return {
        id,
        containerId: FAKE_CONTAINER_ID,
        name: id,
        status: this.statusToReport,
        urls: {},
        createdAt: new Date(),
        image: "img",
      };
    }
  }

  const answerFor = async (status: Sandbox["status"]) => {
    const fake = new InspectingFake();
    fake.statusToReport = status;
    return makeProvisioner(fake).status!("rt_1");
  };

  it("reports a live container as running", async () => {
    expect(await answerFor("running")).toBe("running");
  });

  it("counts paused and restarting as running — both still hold the resources", async () => {
    // Neither is "stopped": a paused container still owns its memory, and a
    // restarting one is on its way back up. Calling either stopped would tell
    // the operator the meter had stopped when it had not.
    expect(await answerFor("paused")).toBe("running");
    expect(await answerFor("restarting")).toBe("running");
  });

  it("reports an exited or dead container as stopped", async () => {
    expect(await answerFor("exited")).toBe("stopped");
    expect(await answerFor("dead")).toBe("stopped");
    expect(await answerFor("stopped")).toBe("stopped");
  });

  it("reports a container gone from the daemon as stopped", async () => {
    // The daemon answered and there is no such container: it cannot be running
    // and it cannot be billing. That IS evidence, unlike silence.
    const fake = new InspectingFake();
    fake.inspectError = new Error("Sandbox not found: rt_1");
    expect(await makeProvisioner(fake).status!("rt_1")).toBe("stopped");
  });

  it("refuses to answer when the daemon itself cannot be reached", async () => {
    // No answer is not an answer. The service layer degrades this to "unknown"
    // rather than letting it read as confirmation.
    const fake = new InspectingFake();
    fake.inspectError = new Error("connect ENOENT /var/run/docker.sock");
    await expect(makeProvisioner(fake).status!("rt_1")).rejects.toThrow(/ENOENT/);
  });
});

describe("DockerRuntimeProvisioner network selection", () => {
  const ORIGINAL = process.env.DOCKER_NETWORK;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DOCKER_NETWORK;
    else process.env.DOCKER_NETWORK = ORIGINAL;
  });

  it("passes DOCKER_NETWORK through to the orchestrator", () => {
    // config.ts exposed DOCKER_NETWORK for a long time but nothing passed it
    // here, so setting it did nothing. That silent no-op is what made the #243
    // guard fire on a hub that was, as far as its operator knew, configured
    // correctly.
    process.env.DOCKER_NETWORK = "bridge";
    const p = new DockerRuntimeProvisioner();
    const cfg = (p as unknown as { orchestrator: { config: { defaultNetwork: string } } })
      .orchestrator.config;
    expect(cfg.defaultNetwork).toBe("bridge");
  });

  it("defaults to agentpod-net when unset", () => {
    delete process.env.DOCKER_NETWORK;
    const p = new DockerRuntimeProvisioner();
    const cfg = (p as unknown as { orchestrator: { config: { defaultNetwork: string } } })
      .orchestrator.config;
    expect(cfg.defaultNetwork).toBe("agentpod-net");
  });
});
