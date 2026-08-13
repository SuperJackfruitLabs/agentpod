/**
 * Unit tests: DockerOrchestrator container options.
 *
 * No real Docker daemon. buildContainerOptions is private, so these reach it
 * via a cast — the alternative is exporting a function purely for tests, and
 * the option object is exactly what we need to assert on.
 */

import { describe, it, expect } from "bun:test";
import { DockerOrchestrator } from "./docker-orchestrator";
import type { SandboxConfig } from "./docker-orchestrator";

const CONFIG: SandboxConfig = {
  id: "rt_test",
  name: "test",
  image: "agentpod-node:local",
  env: { AGENTPOD_HUB_URL: "https://hub.example" },
  volumes: [],
  ports: [],
  labels: {},
  resources: { cpus: "1.0", memory: "1g", pidsLimit: 100 },
};

/** buildContainerOptions is private; this is the narrow escape hatch. */
function optionsFor(orch: DockerOrchestrator, cfg: SandboxConfig = CONFIG) {
  return (
    orch as unknown as {
      buildContainerOptions: (c: SandboxConfig, name: string) => Record<string, any>;
    }
  ).buildContainerOptions(cfg, "agentpod-rt_test");
}

describe("DockerOrchestrator container options", () => {
  it("omits HostConfig.Runtime entirely when no runtime is configured", () => {
    // Not "" and not undefined-valued — ABSENT. An unconfigured hub must send
    // exactly the request it sends today, so this change cannot alter the
    // default path even subtly.
    const opts = optionsFor(new DockerOrchestrator());
    expect("Runtime" in opts.HostConfig).toBe(false);
  });

  it("sets HostConfig.Runtime when one is configured", () => {
    const opts = optionsFor(new DockerOrchestrator({ runtime: "runsc", defaultNetwork: "bridge" }));
    expect(opts.HostConfig.Runtime).toBe("runsc");
  });

  it("leaves the rest of HostConfig untouched when a runtime is set", () => {
    // The runtime is an addition, not a replacement: resource limits and the
    // tini init that stops zombie stations must survive it.
    const plain = optionsFor(new DockerOrchestrator());
    const withRt = optionsFor(new DockerOrchestrator({ runtime: "runsc", defaultNetwork: "bridge" }));

    expect(withRt.HostConfig.Init).toBe(plain.HostConfig.Init);
    expect(withRt.HostConfig.NanoCpus).toBe(plain.HostConfig.NanoCpus);
    expect(withRt.HostConfig.Memory).toBe(plain.HostConfig.Memory);
    expect(withRt.HostConfig.RestartPolicy).toEqual(plain.HostConfig.RestartPolicy);
  });

  it("keeps the image and labels identical", () => {
    const withRt = optionsFor(new DockerOrchestrator({ runtime: "runsc", defaultNetwork: "bridge" }));
    expect(withRt.Image).toBe(CONFIG.image);
    expect(withRt.Labels["agentpod.managed"]).toBe("true");
  });
});

// ─── Which daemon it dials ────────────────────────────────────────────────────

/**
 * dockerode keeps its connection settings on `docker.modem`, which is the only
 * place the answer actually lives: the alternative is asserting on the options
 * WE passed, which proves nothing about what the library did with them. It
 * matters here — docker-modem prefers `host` over `socketPath` whenever both
 * are present (lib/modem.js: `if (!this.host) this.socketPath = ...`), so
 * "we passed a socket path" and "it will use the socket" are different claims.
 */
function modemOf(orch: DockerOrchestrator) {
  return (orch as unknown as { docker: { modem: Record<string, any> } }).docker.modem;
}

describe("DockerOrchestrator daemon endpoint", () => {
  it("dials the local socket when no daemon is configured", () => {
    // The case every deployment today runs on. Nothing about a remote daemon
    // may reach this path.
    const modem = modemOf(new DockerOrchestrator());
    expect(modem.socketPath).toBe("/var/run/docker.sock");
    expect(modem.host).toBeUndefined();
  });

  it("dials the resolved socket when one is given", () => {
    const modem = modemOf(
      new DockerOrchestrator({
        daemon: {
          socketPath: "/run/user/1000/docker.sock",
          remote: false,
          describe: "unix:///run/user/1000/docker.sock",
        },
      })
    );
    expect(modem.socketPath).toBe("/run/user/1000/docker.sock");
    expect(modem.host).toBeUndefined();
  });

  it("dials a remote daemon over TLS with the client certificate", () => {
    const modem = modemOf(
      new DockerOrchestrator({
        daemon: {
          host: "docker-host.internal",
          port: 2376,
          protocol: "https",
          ca: ["-----BEGIN CERTIFICATE-----ca-----END CERTIFICATE-----"],
          cert: "-----BEGIN CERTIFICATE-----client-----END CERTIFICATE-----",
          key: "-----BEGIN PRIVATE KEY-----k-----END PRIVATE KEY-----",
          remote: true,
          describe: "tcp://docker-host.internal:2376 (mutual TLS)",
        },
      })
    );
    expect(modem.host).toBe("docker-host.internal");
    expect(modem.port).toBe(2376);
    expect(modem.protocol).toBe("https");
    expect(modem.ca).toHaveLength(1);
    expect(modem.cert).toContain("client");
    expect(modem.key).toContain("PRIVATE KEY");
    // Not merely absent from the options we passed — absent from the modem,
    // which is what decides.
    expect(modem.socketPath).toBeUndefined();
  });

  it("cannot be redirected by a stray DOCKER_HOST in the process env", () => {
    // docker-modem reads process.env.DOCKER_HOST on EVERY construction and
    // merges it underneath the options it is given, so a socket connection has
    // to overwrite the host explicitly or an exported DOCKER_HOST silently wins
    // — the hub would then provision onto a daemon nothing in its config names.
    const original = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "tcp://10.9.9.9:2375";
    try {
      const modem = modemOf(
        new DockerOrchestrator({
          daemon: {
            socketPath: "/var/run/docker.sock",
            remote: false,
            describe: "unix:///var/run/docker.sock",
          },
        })
      );
      expect(modem.host).toBeUndefined();
      expect(modem.socketPath).toBe("/var/run/docker.sock");
    } finally {
      if (original === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = original;
    }
  });
});

describe("DockerOrchestrator.inspectSandbox", () => {
  it("resolves the container by sandbox name and reports the daemon's state", async () => {
    // Reuses the same lookup the lifecycle methods use, so "is it running?" is
    // answered about the same container stop() was sent to — not a second,
    // separately-resolved one.
    const orch = new DockerOrchestrator();
    const listed: Array<Record<string, any>> = [];
    (orch as unknown as { docker: unknown }).docker = {
      listContainers: async (opts: Record<string, any>) => {
        listed.push(opts);
        return [{ Id: "abc123" }];
      },
      getContainer: (id: string) => ({
        inspect: async () => ({
          Id: id,
          Created: new Date().toISOString(),
          State: { Running: false, Status: "exited" },
          Config: { Labels: {}, Image: "agentpod-node:local" },
        }),
      }),
    };

    const sandbox = await orch.inspectSandbox("rt_test");
    expect(sandbox.status).toBe("exited");
    expect(sandbox.containerId).toBe("abc123");
    expect(listed[0]!.filters.name).toEqual(["agentpod-rt_test"]);
  });

  it("reports a running container as running", async () => {
    const orch = new DockerOrchestrator();
    (orch as unknown as { docker: unknown }).docker = {
      listContainers: async () => [{ Id: "abc123" }],
      getContainer: () => ({
        inspect: async () => ({
          Id: "abc123",
          Created: new Date().toISOString(),
          State: { Running: true, Status: "running" },
          Config: { Labels: {} },
        }),
      }),
    };
    expect((await orch.inspectSandbox("rt_test")).status).toBe("running");
  });

  it("throws 'Sandbox not found' when the daemon knows of no such container", async () => {
    const orch = new DockerOrchestrator();
    (orch as unknown as { docker: unknown }).docker = {
      listContainers: async () => [],
      getContainer: () => ({ inspect: async () => ({}) }),
    };
    await expect(orch.inspectSandbox("rt_gone")).rejects.toThrow(/Sandbox not found/);
  });
});

describe("runtime and network compatibility", () => {
  // Root cause of #243: on a USER-DEFINED network Docker injects
  // `nameserver 127.0.0.11` and runs an embedded DNS proxy on that loopback
  // address inside the container's netns. gVisor's netstack cannot reach it,
  // so every lookup times out and the node-agent never enrols — while ICMP,
  // TCP and UDP to real addresses all work, which makes it look like DNS
  // "just broke".
  //
  // `--dns` does NOT help: it only changes what the embedded proxy forwards
  // upstream, and resolv.conf still points at 127.0.0.11.
  //
  // Docker's built-in networks (bridge/host/none) write the host's real
  // resolvers directly, so they are unaffected.

  it("rejects a non-default runtime on a user-defined network", () => {
    // Fail closed. Allowing this produces runtimes that provision "successfully"
    // and then restart-loop forever — the worst kind of failure, because the
    // API reports success.
    expect(() =>
      optionsFor(new DockerOrchestrator({ runtime: "runsc", defaultNetwork: "agentpod-net" }))
    ).toThrow(/runsc/);
  });

  it("names the incompatibility and the fix in the error", () => {
    // An operator hitting this at 2am needs to know what to change, not just
    // that something is wrong.
    let msg = "";
    try {
      optionsFor(new DockerOrchestrator({ runtime: "runsc", defaultNetwork: "agentpod-net" }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/agentpod-net/);
    expect(msg).toMatch(/DOCKER_NETWORK/);
  });

  it("allows a non-default runtime on Docker's built-in bridge", () => {
    // bridge/host/none do not use the embedded resolver, so they are fine.
    const opts = optionsFor(new DockerOrchestrator({ runtime: "runsc", defaultNetwork: "bridge" }));
    expect(opts.HostConfig.Runtime).toBe("runsc");
    expect(opts.HostConfig.NetworkMode).toBe("bridge");
  });

  it("leaves the default runtime free to use any network", () => {
    // runc reaches the embedded resolver fine; this restriction is specific to
    // sandboxed runtimes and must not change existing behaviour.
    const opts = optionsFor(new DockerOrchestrator({ defaultNetwork: "agentpod-net" }));
    expect(opts.HostConfig.NetworkMode).toBe("agentpod-net");
  });
});
