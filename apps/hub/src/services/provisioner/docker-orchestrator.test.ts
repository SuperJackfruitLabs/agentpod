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
    const opts = optionsFor(new DockerOrchestrator({ runtime: "runsc" }));
    expect(opts.HostConfig.Runtime).toBe("runsc");
  });

  it("leaves the rest of HostConfig untouched when a runtime is set", () => {
    // The runtime is an addition, not a replacement: resource limits and the
    // tini init that stops zombie stations must survive it.
    const plain = optionsFor(new DockerOrchestrator());
    const withRt = optionsFor(new DockerOrchestrator({ runtime: "runsc" }));

    expect(withRt.HostConfig.Init).toBe(plain.HostConfig.Init);
    expect(withRt.HostConfig.NanoCpus).toBe(plain.HostConfig.NanoCpus);
    expect(withRt.HostConfig.Memory).toBe(plain.HostConfig.Memory);
    expect(withRt.HostConfig.RestartPolicy).toEqual(plain.HostConfig.RestartPolicy);
  });

  it("keeps the image and labels identical", () => {
    const withRt = optionsFor(new DockerOrchestrator({ runtime: "runsc" }));
    expect(withRt.Image).toBe(CONFIG.image);
    expect(withRt.Labels["agentpod.managed"]).toBe("true");
  });
});
