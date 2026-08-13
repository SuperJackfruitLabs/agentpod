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
  /** Set to make startSandbox throw, the way dockerode does. */
  startError: Error | null = null;
  /** Set to make stopSandbox throw, the way dockerode does. */
  stopError: Error | null = null;

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
    if (this.startError) throw this.startError;
  }

  async stopSandbox(id: string, timeout?: number): Promise<void> {
    this.calls.push({ method: "stopSandbox", args: [id, timeout] });
    if (this.stopError) throw this.stopError;
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

/**
 * An error shaped exactly like the one dockerode raises, because the whole fix
 * turns on telling one status apart from every other.
 *
 * docker-modem builds it in `buildPayload`: the message is
 * `"(HTTP code <n>) <reason> - <cause> "`, and it hangs `statusCode` and
 * `reason` off the Error. dockerode's container.start/stop declare
 * `304: "container already started" / "container already stopped"`
 * (dockerode/lib/container.js), which is where the reason text comes from — and
 * that message is verbatim what the live hub logged on 2026-08-13 for the two
 * requests that answered 500 (issue #284).
 */
function dockerError(statusCode: number, reason: string, cause = ""): Error {
  const err = new Error(`(HTTP code ${statusCode}) ${reason} - ${cause} `);
  return Object.assign(err, { statusCode, reason });
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
    // The same 1g/2g/4g the driver hands the daemon, in MB. Declared so the hub
    // can refuse a harness that does not fit — a `small` cgroup OOM-killed an
    // opencode ACP session once already (2026-08-09, at 512m).
    expect(m.tierMemoryMb).toEqual({ small: 1024, medium: 2048, large: 4096 });
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

    it("reports a container that is already running as a no-op, not a failure", async () => {
      // Issue #284, measured on the live hub 2026-08-13: a second Start on an
      // `online` docker runtime answered 500 "An unexpected error occurred",
      // because the daemon's 304 travelled all the way up as an exception. A 304
      // means the end state the caller asked for ALREADY HOLDS — the definition
      // of a no-op. Nothing unexpected happened, so nothing may be reported as
      // unexpected.
      const fake = new FakeDockerOrchestrator();
      fake.startError = dockerError(304, "container already started");

      const outcome = await makeProvisioner(fake).start("c1");
      expect(outcome?.alreadyInTargetState).toBe(true);
    });

    it("still fails when the daemon refuses the start for any other reason", async () => {
      // The tolerance is exactly one status wide. A container the daemon has no
      // record of cannot be "already started" — nothing is running — and a
      // runtime whose container vanished must not read as a successful start.
      const fake = new FakeDockerOrchestrator();
      fake.startError = dockerError(404, "no such container");
      await expect(makeProvisioner(fake).start("c1")).rejects.toThrow(/no such container/);
    });

    it("still fails when the daemon itself cannot be reached", async () => {
      // Silence is not an answer. A socket that will not connect says nothing
      // about whether the container is running, and reporting a successful
      // no-op for it would hide a hub that cannot reach its daemon at all.
      const fake = new FakeDockerOrchestrator();
      fake.startError = new Error("connect ENOENT /var/run/docker.sock");
      await expect(makeProvisioner(fake).start("c1")).rejects.toThrow(/ENOENT/);
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

    it("reports a container that is already stopped as a no-op, not a failure", async () => {
      // The other half of #284: Stop on a `stopped` docker runtime answered 500.
      // The hub logged "(HTTP code 304) container already stopped -" for it.
      const fake = new FakeDockerOrchestrator();
      fake.stopError = dockerError(304, "container already stopped");

      const outcome = await makeProvisioner(fake).stop("c1");
      expect(outcome?.alreadyInTargetState).toBe(true);
    });

    it("still fails when the daemon refuses the stop for any other reason", async () => {
      const fake = new FakeDockerOrchestrator();
      fake.stopError = dockerError(500, "server error");
      await expect(makeProvisioner(fake).stop("c1")).rejects.toThrow(/server error/);
    });

    it("still fails when the daemon itself cannot be reached", async () => {
      const fake = new FakeDockerOrchestrator();
      fake.stopError = new Error("connect ENOENT /var/run/docker.sock");
      await expect(makeProvisioner(fake).stop("c1")).rejects.toThrow(/ENOENT/);
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

// ─── Which daemon the driver dials ────────────────────────────────────────────

describe("DockerRuntimeProvisioner daemon selection", () => {
  const VARS = [
    "DOCKER_HOST",
    "DOCKER_SOCKET",
    "DOCKER_CERT_PATH",
    "DOCKER_ALLOW_INSECURE_TCP",
  ] as const;
  const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
    VARS.map((v) => [v, process.env[v]])
  );

  afterEach(() => {
    for (const v of VARS) {
      const was = ORIGINAL[v];
      if (was === undefined) delete process.env[v];
      else process.env[v] = was;
    }
  });

  /** dockerode's own view of where it will connect — see docker-orchestrator.test.ts. */
  const modemOf = (p: DockerRuntimeProvisioner) =>
    (p as unknown as { orchestrator: { docker: { modem: Record<string, any> } } })
      .orchestrator.docker.modem;

  it("uses the local socket when no daemon is configured", () => {
    // Every deployment today. This is the case that must not regress: a Docker
    // hub with none of these variables set has to keep talking to its own
    // /var/run/docker.sock and nothing else.
    for (const v of VARS) delete process.env[v];
    const modem = modemOf(new DockerRuntimeProvisioner());
    expect(modem.socketPath).toBe("/var/run/docker.sock");
    expect(modem.host).toBeUndefined();
  });

  it("dials the daemon DOCKER_HOST names", () => {
    // The point of the whole exercise: agent workloads on a machine that is not
    // the control plane.
    for (const v of VARS) delete process.env[v];
    process.env.DOCKER_HOST = "tcp://10.0.0.5:2375";
    process.env.DOCKER_ALLOW_INSECURE_TCP = "true";
    const modem = modemOf(new DockerRuntimeProvisioner());
    expect(modem.host).toBe("10.0.0.5");
    expect(modem.port).toBe(2375);
    expect(modem.socketPath).toBeUndefined();
  });

  it("refuses to construct on a daemon configuration it will not use", () => {
    // The backstop behind validate-config's boot refusal — the same rules, at
    // the moment the driver is registered, so a code path that reaches the
    // driver without going through boot validation cannot end up silently
    // provisioning onto the control-plane box after the operator asked for a
    // remote daemon.
    for (const v of VARS) delete process.env[v];
    process.env.DOCKER_HOST = "tcp://10.0.0.5:2375";
    expect(() => new DockerRuntimeProvisioner()).toThrow(/DOCKER_CERT_PATH/);
  });

  it("names the daemon that lacks the image when create 404s", async () => {
    // The #283 trap, one substrate over. The hub never pulls: it creates
    // containers from images the daemon already holds, which is invisible on
    // the local daemon (step 3 of DEPLOYMENT builds them there) and is the
    // first thing to break the moment DOCKER_HOST points somewhere else —
    // `agentpod-node:local` is a tag in one daemon's store and nothing in
    // another's. Docker's own error names neither the daemon nor the fix.
    const fake = new FakeDockerOrchestrator() as unknown as DockerOrchestrator & {
      createError: Error | null;
      describeDaemon: () => string;
    };
    fake.createError = new Error(
      "(HTTP code 404) no such container - No such image: agentpod-node:local"
    );
    fake.describeDaemon = () => "tcp://docker-host.internal:2376 (mutual TLS)";

    const err = (await new DockerRuntimeProvisioner(fake)
      .provision({
        runtimeId: "rt_1",
        name: "n",
        resourceTier: "small",
        hubUrl: "https://hub.example",
        enrollToken: "enr_x",
        image: "agentpod-node:local",
      })
      .catch((e: Error) => e)) as Error;

    expect(err.message).toContain("docker-host.internal");
    expect(err.message).toContain("agentpod-node:local");
    // The daemon's own words survive: a rewritten error that drops the original
    // is a worse error.
    expect(err.message).toMatch(/No such image/);
  });

  it("still accepts an injected orchestrator regardless of the environment", () => {
    // Tests and callers that pass their own orchestrator must not be dragged
    // through env resolution at all.
    for (const v of VARS) delete process.env[v];
    process.env.DOCKER_HOST = "not-a-url";
    const fake = new FakeDockerOrchestrator();
    expect(
      () => new DockerRuntimeProvisioner(fake as unknown as DockerOrchestrator)
    ).not.toThrow();
  });
});
