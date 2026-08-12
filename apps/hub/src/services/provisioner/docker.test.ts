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
