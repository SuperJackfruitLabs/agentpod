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
