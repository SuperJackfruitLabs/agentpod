/**
 * Docker Orchestrator — minimal subset used by DockerRuntimeProvisioner.
 *
 * Extracted from services/orchestrator/docker.ts (OpenCode era) during P2b T2.
 * Only the four lifecycle methods used by DockerRuntimeProvisioner are kept.
 */

import Docker from "dockerode";
import type { Container, ContainerCreateOptions } from "dockerode";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SandboxStatus =
  | "creating" | "running" | "stopped" | "paused"
  | "restarting" | "removing" | "exited" | "dead" | "error" | "unknown";

export interface VolumeMount {
  host: string;
  container: string;
  mode: "rw" | "ro";
  type?: "bind" | "volume";
}

export interface PortMapping {
  container: number;
  host?: number;
  protocol?: "tcp" | "udp";
  label?: string;
  public?: boolean;
}

export interface ResourceLimits {
  cpus?: string;
  memory?: string;
  memorySwap?: string;
  pidsLimit?: number;
  diskQuota?: number;
}

export interface SandboxConfig {
  id: string;
  name: string;
  image: string;
  env: Record<string, string>;
  volumes: VolumeMount[];
  ports: PortMapping[];
  labels: Record<string, string>;
  resources: ResourceLimits;
  network?: string;
  userId?: string;
  workingDir?: string;
  command?: string[];
}

export interface Sandbox {
  id: string;
  containerId: string;
  name: string;
  status: SandboxStatus;
  urls: Record<string, string | undefined>;
  createdAt: Date;
  startedAt?: Date;
  image: string;
  labels?: Record<string, string>;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface DockerOrchestratorConfig {
  socketPath?: string;
  host?: string;
  port?: number;
  containerPrefix?: string;
  hostPathPrefix?: string;
  defaultNetwork?: string;
  defaultResources?: ResourceLimits;
}

const DEFAULT_CONFIG: Required<DockerOrchestratorConfig> = {
  socketPath: "/var/run/docker.sock",
  host: "",
  port: 2375,
  containerPrefix: "agentpod",
  defaultNetwork: "agentpod-net",
  hostPathPrefix: "",
  defaultResources: { cpus: "1.0", memory: "2g", pidsLimit: 256 },
};

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class DockerOrchestrator {
  private docker: Docker;
  private config: Required<DockerOrchestratorConfig>;

  constructor(config: DockerOrchestratorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.host) {
      this.docker = new Docker({ host: this.config.host, port: this.config.port });
    } else {
      this.docker = new Docker({ socketPath: this.config.socketPath });
    }
  }

  async createSandbox(config: SandboxConfig): Promise<Sandbox> {
    const containerName = this.getContainerName(config.id);
    await this.ensureNetwork(config.network ?? this.config.defaultNetwork);
    const createOptions = this.buildContainerOptions(config, containerName);
    const container = await this.docker.createContainer(createOptions);
    await container.start();
    const info = await container.inspect();
    return this.containerInfoToSandbox(config.id, info);
  }

  async startSandbox(id: string): Promise<void> {
    const container = await this.getContainer(id);
    await container.start();
  }

  async stopSandbox(id: string, timeout = 10): Promise<void> {
    const container = await this.getContainer(id);
    await container.stop({ t: timeout });
  }

  async deleteSandbox(id: string, removeVolumes = false): Promise<void> {
    const container = await this.getContainer(id);
    try { await container.stop({ t: 5 }); } catch { /* already stopped */ }
    await container.remove({ v: removeVolumes, force: true });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private getContainerName(sandboxId: string): string {
    return `${this.config.containerPrefix}-${sandboxId}`;
  }

  private async getContainer(sandboxId: string): Promise<Container> {
    const containerName = this.getContainerName(sandboxId);
    const byName = await this.docker.listContainers({
      all: true,
      filters: { name: [containerName] },
    });
    if (byName.length > 0 && byName[0]) {
      return this.docker.getContainer(byName[0].Id);
    }
    const byLabel = await this.docker.listContainers({
      all: true,
      filters: { label: [`agentpod.sandbox.id=${sandboxId}`] },
    });
    if (byLabel.length > 0 && byLabel[0]) {
      return this.docker.getContainer(byLabel[0].Id);
    }
    throw new Error(`Sandbox not found: ${sandboxId}`);
  }

  private async ensureNetwork(networkName?: string): Promise<string> {
    const name = networkName ?? this.config.defaultNetwork;
    try {
      const network = this.docker.getNetwork(name);
      const info = await network.inspect();
      return info.Id;
    } catch {
      const network = await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        CheckDuplicate: true,
      });
      return network.id;
    }
  }

  private buildContainerOptions(
    config: SandboxConfig,
    containerName: string
  ): ContainerCreateOptions {
    const network = config.network ?? this.config.defaultNetwork;
    const resources = { ...this.config.defaultResources, ...config.resources };

    const binds: string[] = config.volumes.map((v) => {
      const mode = v.mode === "ro" ? "ro" : "rw";
      let hostPath = v.host;
      if (this.config.hostPathPrefix && hostPath.startsWith("/data")) {
        hostPath = `${this.config.hostPathPrefix}${hostPath}`;
      }
      return `${hostPath}:${v.container}:${mode}`;
    });

    const exposedPorts: Record<string, object> = {};
    const portBindings: Record<string, { HostPort: string }[]> = {};
    for (const port of config.ports) {
      const key = `${port.container}/${port.protocol ?? "tcp"}`;
      exposedPorts[key] = {};
      if (port.host) portBindings[key] = [{ HostPort: String(port.host) }];
    }

    const env = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
    const memoryBytes = this.parseMemoryLimit(resources.memory);

    return {
      name: containerName,
      Image: config.image,
      Env: env,
      Labels: {
        ...config.labels,
        "agentpod.sandbox.id": config.id,
        "agentpod.sandbox.name": config.name,
        "agentpod.managed": "true",
      },
      ExposedPorts: exposedPorts,
      WorkingDir: config.workingDir,
      Cmd: config.command,
      User: config.userId,
      HostConfig: {
        Binds: binds,
        PortBindings: portBindings,
        NetworkMode: network,
        RestartPolicy: { Name: "unless-stopped" },
        // Docker's built-in init (tini) as PID 1: reaps zombies. Without it,
        // exited children of the entrypoint (e.g. the opencode supervision
        // subshell after a lifecycle Stop) linger as <defunct> and their comm
        // still matches the descriptor's pgrep health check — the station
        // reports "running" forever after its process died (live-fleet
        // finding, 2026-08-09).
        Init: true,
        NanoCpus: resources.cpus
          ? Math.floor(parseFloat(resources.cpus) * 1e9)
          : undefined,
        Memory: memoryBytes,
        MemorySwap: resources.memorySwap
          ? this.parseMemoryLimit(resources.memorySwap)
          : undefined,
        PidsLimit: resources.pidsLimit,
      },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    } as ContainerCreateOptions;
  }

  private parseMemoryLimit(limit?: string): number | undefined {
    if (!limit) return undefined;
    const match = limit.match(/^(\d+(?:\.\d+)?)\s*([kmgKMG])?[bB]?$/);
    if (!match) return undefined;
    const value = parseFloat(match[1] ?? "0");
    const unit = (match[2] ?? "").toLowerCase();
    const mul: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
    return Math.floor(value * (mul[unit] ?? 1));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private containerInfoToSandbox(sandboxId: string, info: any): Sandbox {
    const labels = info.Config?.Labels ?? {};
    const state = info.State;
    let status: SandboxStatus = "unknown";
    if (state) {
      if (state.Running) {
        status = state.Paused ? "paused" : state.Restarting ? "restarting" : "running";
      } else if (state.Dead) status = "dead";
      else if (state.Status === "created") status = "creating";
      else if (state.Status === "exited") status = "exited";
      else if (state.Status === "removing") status = "removing";
      else status = "stopped";
    }
    return {
      id: sandboxId,
      containerId: info.Id,
      name: labels["agentpod.sandbox.name"] ?? info.Name?.replace(/^\//, "") ?? sandboxId,
      status,
      urls: {},
      createdAt: new Date(info.Created),
      startedAt: state?.StartedAt ? new Date(state.StartedAt) : undefined,
      image: info.Config?.Image ?? "",
      labels,
    };
  }
}
