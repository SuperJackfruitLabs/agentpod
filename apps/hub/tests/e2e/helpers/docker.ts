/**
 * E2E Docker Helper
 * 
 * Provides utilities for managing REAL Docker containers in E2E tests.
 * This uses actual Docker API calls, not a mock.
 * 
 * Key features:
 * - Start/stop real containers
 * - Wait for container health
 * - Execute commands inside containers
 * - Cleanup containers after tests
 * 
 * NOTE: E2E tests require Docker to be running and the agentpod-fullstack:latest
 * image to be available locally.
 */

import Docker from "dockerode";
import type { ContainerCreateOptions, ContainerInfo } from "dockerode";

// =============================================================================
// Types
// =============================================================================

export interface E2EContainerConfig {
  /** Container name (will be prefixed with 'e2e-') */
  name: string;
  /** Docker image to use */
  image: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Port mappings: { hostPort: containerPort } */
  ports?: Record<number, number>;
  /** Labels for the container */
  labels?: Record<string, string>;
  /** Whether to wait for container to be healthy */
  waitForHealth?: boolean;
  /** Health check timeout in ms (default: 60000) */
  healthTimeout?: number;
  /** Network mode (default: bridge) */
  networkMode?: string;
}

export interface E2EContainer {
  id: string;
  name: string;
  status: string;
  ports: Record<number, number>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// =============================================================================
// E2E Docker Client
// =============================================================================

export class E2EDockerClient {
  private docker: Docker;
  private managedContainers: Set<string> = new Set();

  constructor(socketPath: string = "/var/run/docker.sock") {
    this.docker = new Docker({ socketPath });
  }

  /**
   * Check if Docker is available and running
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if an image exists locally
   */
  async imageExists(imageName: string): Promise<boolean> {
    try {
      const image = this.docker.getImage(imageName);
      await image.inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create and start a container for E2E testing
   */
  async createContainer(config: E2EContainerConfig): Promise<E2EContainer> {
    const containerName = `e2e-${config.name}-${Date.now()}`;

    // Build environment array
    const env = config.env
      ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`)
      : [];

    // Build port bindings
    const exposedPorts: Record<string, Record<string, never>> = {};
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};

    if (config.ports) {
      for (const [hostPort, containerPort] of Object.entries(config.ports)) {
        const portKey = `${containerPort}/tcp`;
        exposedPorts[portKey] = {};
        portBindings[portKey] = [{ HostPort: String(hostPort) }];
      }
    }

    // Build container options
    const createOptions: ContainerCreateOptions = {
      name: containerName,
      Image: config.image,
      Env: env,
      Labels: {
        "e2e.test": "true",
        "e2e.created": new Date().toISOString(),
        ...(config.labels || {}),
      },
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        NetworkMode: config.networkMode || "bridge",
        // Add extra hosts for host.docker.internal on Linux
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    };

    // Create container
    const container = await this.docker.createContainer(createOptions);
    this.managedContainers.add(container.id);

    // Start container
    await container.start();

    // Wait for container to be running
    await this.waitForStatus(container.id, "running", 10000);

    // Optionally wait for health
    if (config.waitForHealth) {
      await this.waitForHealth(container.id, config.healthTimeout || 60000);
    }

    // Get container info
    const info = await container.inspect();
    const ports: Record<number, number> = {};

    if (info.NetworkSettings?.Ports) {
      for (const [containerPort, bindings] of Object.entries(info.NetworkSettings.Ports)) {
        const first = bindings?.[0];
        if (first) {
          // "8080/tcp" → 8080: parseInt stops at the slash.
          const port = parseInt(containerPort);
          ports[port] = parseInt(first.HostPort);
        }
      }
    }

    return {
      id: container.id,
      name: containerName,
      status: info.State?.Status || "unknown",
      ports,
    };
  }

  /**
   * Wait for container to reach a specific status
   */
  async waitForStatus(
    containerId: string,
    targetStatus: string,
    timeout: number = 30000
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();

      if (info.State?.Status === targetStatus) {
        return;
      }

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Container ${containerId} did not reach status '${targetStatus}' within ${timeout}ms`);
  }

  /**
   * Wait for container to be healthy (if health check is defined)
   */
  async waitForHealth(containerId: string, timeout: number = 60000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();

      const health = info.State?.Health?.Status;

      // If no health check defined, consider it healthy
      if (!info.Config?.Healthcheck) {
        return;
      }

      if (health === "healthy") {
        return;
      }

      if (health === "unhealthy") {
        const logs = info.State?.Health?.Log || [];
        const lastLog = logs[logs.length - 1];
        throw new Error(`Container ${containerId} is unhealthy: ${lastLog?.Output || "unknown"}`);
      }

      // Wait before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Container ${containerId} did not become healthy within ${timeout}ms`);
  }

  /**
   * Execute a command inside a container using docker CLI
   * This is more reliable than using dockerode's exec with stream handling
   */
  async exec(
    containerId: string,
    command: string[],
    options: { user?: string; workingDir?: string } = {}
  ): Promise<ExecResult> {
    const { spawn } = await import("child_process");

    return new Promise((resolve, reject) => {
      const args = ["exec"];

      if (options.user) {
        args.push("-u", options.user);
      }
      if (options.workingDir) {
        args.push("-w", options.workingDir);
      }

      args.push(containerId, ...command);

      const proc = spawn("docker", args);

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      proc.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * Get container logs
   */
  async getLogs(containerId: string, tail: number = 100): Promise<string> {
    const container = this.docker.getContainer(containerId);

    const stream = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      follow: false,
    });

    // Demux the stream
    let output = "";
    const buffer = stream as unknown as Buffer;

    if (Buffer.isBuffer(buffer)) {
      let offset = 0;
      while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;
        const size = buffer.readUInt32BE(offset + 4);
        offset += 8;
        if (offset + size > buffer.length) break;
        output += buffer.subarray(offset, offset + size).toString("utf8");
        offset += size;
      }
    } else if (buffer) {
      output = String(buffer);
    }

    return output;
  }

  /**
   * Stop a container
   */
  async stopContainer(containerId: string, timeout: number = 10): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: timeout });
    } catch (error: unknown) {
      // Ignore if already stopped
      if (error instanceof Error && !error.message.includes("already stopped")) {
        throw error;
      }
    }
  }

  /**
   * Remove a container
   */
  async removeContainer(containerId: string, force: boolean = true): Promise<void> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force, v: true });
      this.managedContainers.delete(containerId);
    } catch (error: unknown) {
      // Ignore if not found or removal already in progress
      if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        if (msg.includes("no such container") || msg.includes("already in progress") || msg.includes("409")) {
          this.managedContainers.delete(containerId);
          return;
        }
      }
      // Also check for statusCode property (dockerode errors)
      if (typeof error === "object" && error !== null && "statusCode" in error) {
        const statusCode = (error as { statusCode: number }).statusCode;
        if (statusCode === 404 || statusCode === 409) {
          this.managedContainers.delete(containerId);
          return;
        }
      }
      throw error;
    }
  }

  /**
   * Check if a container exists
   */
  async containerExists(containerId: string): Promise<boolean> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get container info
   */
  async getContainerInfo(containerId: string): Promise<ContainerInfo | null> {
    try {
      const container = this.docker.getContainer(containerId);
      return await container.inspect() as unknown as ContainerInfo;
    } catch {
      return null;
    }
  }

  /**
   * List E2E test containers
   */
  async listE2EContainers(): Promise<E2EContainer[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: ["e2e.test=true"],
      },
    });

    return containers.map((c) => ({
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, "") || "",
      status: c.State,
      ports: {},
    }));
  }

  /**
   * Cleanup all managed containers
   * Call this in afterAll() or test teardown
   */
  async cleanup(): Promise<void> {
    const errors: Error[] = [];

    for (const containerId of this.managedContainers) {
      try {
        await this.stopContainer(containerId, 5);
        await this.removeContainer(containerId, true);
      } catch (error) {
        if (error instanceof Error) {
          errors.push(error);
        }
      }
    }

    this.managedContainers.clear();

    if (errors.length > 0) {
      console.warn(`E2E cleanup encountered ${errors.length} errors:`, errors);
    }
  }

  /**
   * Cleanup all E2E containers (including from previous test runs)
   */
  async cleanupAllE2E(): Promise<void> {
    const containers = await this.listE2EContainers();

    for (const container of containers) {
      try {
        await this.stopContainer(container.id, 5);
        await this.removeContainer(container.id, true);
      } catch (error) {
        console.warn(`Failed to cleanup container ${container.name}:`, error);
      }
    }
  }
}

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a shared E2E Docker client for tests
 */
let sharedClient: E2EDockerClient | null = null;

export function getE2EDockerClient(): E2EDockerClient {
  if (!sharedClient) {
    sharedClient = new E2EDockerClient();
  }
  return sharedClient;
}

/**
 * Check if E2E tests can run (Docker available, image exists)
 */
export async function canRunE2ETests(imageName: string = "agentpod-fullstack:latest"): Promise<{
  canRun: boolean;
  reason?: string;
}> {
  const client = getE2EDockerClient();

  // Check Docker availability
  const dockerAvailable = await client.isDockerAvailable();
  if (!dockerAvailable) {
    return { canRun: false, reason: "Docker is not available" };
  }

  // Check if image exists
  const imageExists = await client.imageExists(imageName);
  if (!imageExists) {
    return {
      canRun: false,
      reason: `Image '${imageName}' not found. Build it with: cd docker && ./scripts/build.sh`,
    };
  }

  return { canRun: true };
}

/**
 * Wait for a specific condition in container logs
 */
export async function waitForLogMessage(
  client: E2EDockerClient,
  containerId: string,
  pattern: string | RegExp,
  timeout: number = 30000
): Promise<boolean> {
  const startTime = Date.now();
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

  while (Date.now() - startTime < timeout) {
    const logs = await client.getLogs(containerId, 200);

    if (regex.test(logs)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return false;
}

/**
 * Make an HTTP request from inside a container
 * Useful for testing container-to-host communication
 */
export async function httpFromContainer(
  client: E2EDockerClient,
  containerId: string,
  method: string,
  url: string,
  body?: object,
  headers?: Record<string, string>
): Promise<{ status: number; body: string }> {
  const headerArgs = headers
    ? Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`])
    : [];

  const bodyArgs = body
    ? ["-d", JSON.stringify(body), "-H", "Content-Type: application/json"]
    : [];

  const result = await client.exec(containerId, [
    "curl",
    "-s",
    "-w",
    "\n%{http_code}",
    "-X",
    method,
    ...headerArgs,
    ...bodyArgs,
    url,
  ]);

  // Parse response: body followed by status code on last line
  const lines = result.stdout.split("\n");
  const statusCode = parseInt(lines.pop() || "0");
  const responseBody = lines.join("\n");

  return {
    status: statusCode,
    body: responseBody,
  };
}
