/**
 * Which Docker daemon the hub talks to.
 *
 * The hub has always used `/var/run/docker.sock`, which means every Docker
 * runtime it provisions shares a kernel, a CPU and a page cache with the
 * control plane that manages it. This module is the seam that lets an operator
 * point the daemon somewhere else — and, much more importantly, the place that
 * refuses to do it badly.
 *
 * WHAT THIS COSTS, STATED PLAINLY. The hub's best security property is that it
 * holds no credentials and can reach nothing that is not already dialling it:
 * node-agents connect outward over WSS, and the hub connects nowhere. A Docker
 * daemon over a network inverts that for one host. A Docker socket is root on
 * the machine that owns it — create a privileged container, bind-mount `/`,
 * done — so whatever we hand the daemon is, in effect, a root credential for
 * that box, sitting in the hub's environment.
 *
 * That is why the transports here are exactly two, and why one of them is
 * absent:
 *
 *   unix://  — a socket file on this machine. No credential, no network, no
 *              change to the property above. Rootless and socket-proxy setups
 *              live here.
 *   tcp://   — with mutual TLS: the hub holds a CLIENT CERTIFICATE AND KEY that
 *              authenticate it to one daemon's API. That is a root-equivalent
 *              credential for that one host and nothing else — it is not a
 *              login, it cannot be replayed against ssh, and it is revocable by
 *              reissuing the daemon's CA.
 *   ssh://   — REFUSED, though dockerode implements it (docker-modem/lib/ssh.js
 *              via ssh2). It would mean the hub holding a private key or a
 *              forwarded agent socket, which is a shell on the target usable
 *              for everything on it — a strictly larger grant than the Docker
 *              API for the same job. If the operator wants SSH transport, an
 *              `ssh -L` tunnel to a loopback port is theirs to run, outside the
 *              hub's credential store.
 *
 * Plaintext tcp:// to anything but loopback is refused: port 2375 is an
 * unauthenticated root API, and it fails silently in the direction that matters
 * — everything works right up until somebody else finds it. The escape hatch
 * exists (DOCKER_ALLOW_INSECURE_TCP) for a private link that is already
 * encrypted, and it warns every boot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Docker's socket path, and the value every deployment today runs on. */
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

/** The three filenames the docker CLI and docker-modem both expect in DOCKER_CERT_PATH. */
const CERT_FILES = { ca: "ca.pem", cert: "cert.pem", key: "key.pem" } as const;

/** Raw settings, exactly as config.ts exposes them. */
export interface DockerDaemonSettings {
  /** DOCKER_HOST — `unix:///path` or `tcp://host[:port]`. Empty means "the socket". */
  host: string;
  /** DOCKER_SOCKET — the socket path used when DOCKER_HOST is unset. */
  socketPath: string;
  /** DOCKER_PORT — fallback port for a plaintext tcp:// URL that carries none. */
  port: number;
  /** DOCKER_CERT_PATH — directory holding ca.pem, cert.pem and key.pem. */
  certPath: string;
  /** DOCKER_ALLOW_INSECURE_TCP — permits unauthenticated tcp:// off-box. */
  allowInsecureTcp: boolean;
}

/** Structurally a `ValidationError`; kept local so this file imports nothing. */
export interface DockerDaemonProblem {
  field: string;
  message: string;
}

/**
 * The dockerode options this resolves to, plus what the rest of the hub needs
 * to know about them.
 */
export interface DockerDaemonConnection {
  socketPath?: string;
  host?: string;
  port?: number;
  protocol?: "http" | "https";
  /** Node's tls `ca` takes a LIST; a bundle with an intermediate needs one. */
  ca?: string[];
  cert?: string;
  key?: string;
  /**
   * True when the daemon is on another machine.
   *
   * Not cosmetic: a remote daemon has its own image store, its own filesystem
   * and its own network stack, so every assumption that the hub's own box is
   * the one running the container stops holding. Boot validation keys the image
   * check off this.
   */
  remote: boolean;
  /** Secret-free, loggable: `tcp://host:2376 (mutual TLS)`. */
  describe: string;
}

export interface DockerDaemonResolution {
  /** Null if and only if `problems` is non-empty. */
  connection: DockerDaemonConnection | null;
  problems: DockerDaemonProblem[];
  /** Configurations that are permitted but worth saying out loud every boot. */
  warnings: string[];
}

/** Injectable so the tests never touch a real certificate directory. */
export interface DockerDaemonIo {
  readFile: (path: string) => string;
}

const DEFAULT_IO: DockerDaemonIo = {
  readFile: (path) => readFileSync(path, "utf8"),
};

/** localhost by any spelling: the daemon is this machine's, over a port. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127\./.test(hostname)
  );
}

/**
 * A PEM bundle as a list of certificates.
 *
 * Node's tls `ca` option accepts an array, and a CA file routinely holds a root
 * plus an intermediate — the reason docker-modem depends on `split-ca` for the
 * same job. Anything outside the BEGIN/END markers (comments, `openssl x509
 * -text` output) is ignored, which is what those files look like in practice.
 */
function splitPemBundle(pem: string): string[] {
  return (
    pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  );
}

function readCertMaterial(
  certPath: string,
  io: DockerDaemonIo
): { ca: string[]; cert: string; key: string } | DockerDaemonProblem {
  const read = (name: string): string | DockerDaemonProblem => {
    try {
      return io.readFile(join(certPath, name));
    } catch (err) {
      return {
        field: "DOCKER_CERT_PATH",
        message:
          `Cannot read ${name} from "${certPath}" (${(err as Error).message}). ` +
          `Mutual TLS to a Docker daemon needs all three of ` +
          `${CERT_FILES.ca}, ${CERT_FILES.cert} and ${CERT_FILES.key} in that ` +
          `directory — the same layout the docker CLI uses. Generate them with ` +
          `Docker's own instructions (https://docs.docker.com/engine/security/protect-access/) ` +
          `and keep the key mode 600, readable only by the hub's user.`,
      };
    }
  };

  const caRaw = read(CERT_FILES.ca);
  if (typeof caRaw !== "string") return caRaw;
  const cert = read(CERT_FILES.cert);
  if (typeof cert !== "string") return cert;
  const key = read(CERT_FILES.key);
  if (typeof key !== "string") return key;

  const ca = splitPemBundle(caRaw);
  if (ca.length === 0) {
    return {
      field: "DOCKER_CERT_PATH",
      message:
        `"${join(certPath, CERT_FILES.ca)}" contains no PEM certificate. ` +
        `Without a CA the hub cannot verify the daemon it is about to hand a ` +
        `root-equivalent client certificate to.`,
    };
  }

  return { ca, cert, key };
}

/**
 * Resolve the daemon, or refuse with problems naming the variable to fix.
 *
 * Pure apart from the injected reader: boot validation and the driver call it
 * with the same settings and must reach the same verdict, or the hub validates
 * one configuration and runs another.
 */
export function resolveDockerDaemon(
  settings: DockerDaemonSettings,
  io: DockerDaemonIo = DEFAULT_IO
): DockerDaemonResolution {
  const refuse = (field: string, message: string): DockerDaemonResolution => ({
    connection: null,
    problems: [{ field, message }],
    warnings: [],
  });

  const host = settings.host.trim();
  const certPath = settings.certPath.trim();
  const socketPath = settings.socketPath.trim() || DEFAULT_DOCKER_SOCKET;

  // ── No DOCKER_HOST: the local socket, exactly as before ────────────────────
  if (!host) {
    if (certPath) {
      // Certificates without a daemon to present them to. The hub would use the
      // local socket while the operator believes their runtimes moved off the
      // box — a belief nothing else in the system would correct.
      return refuse(
        "DOCKER_HOST",
        `DOCKER_CERT_PATH is set to "${certPath}" but DOCKER_HOST is not, so the hub ` +
          `would use the local socket ${socketPath} and the certificates would go ` +
          `unused. Set DOCKER_HOST=tcp://<daemon-host>:2376, or unset DOCKER_CERT_PATH.`
      );
    }
    return {
      connection: {
        socketPath,
        remote: false,
        describe: `unix://${socketPath}`,
      },
      problems: [],
      warnings: [],
    };
  }

  // ── DOCKER_HOST is set: it is the single answer to "where is the daemon" ───
  if (settings.socketPath.trim() && settings.socketPath.trim() !== DEFAULT_DOCKER_SOCKET) {
    return refuse(
      "DOCKER_SOCKET",
      `DOCKER_HOST ("${host}") and DOCKER_SOCKET ("${settings.socketPath}") name two ` +
        `different daemons. Set one. Whichever the hub picked silently, the ` +
        `containers would be on a machine the operator was not looking at.`
    );
  }

  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return refuse(
      "DOCKER_HOST",
      `"${host}" is not a URL the hub accepts. Use unix:///var/run/docker.sock for a ` +
        `local socket or tcp://<host>:2376 for a remote daemon. A bare host:port is ` +
        `refused deliberately: this variable decides which machine gets root-equivalent ` +
        `container access, so it is spelled out in full.`
    );
  }

  if (url.protocol === "unix:") {
    const path = url.pathname;
    if (!path || path === "/") {
      return refuse(
        "DOCKER_HOST",
        `"${host}" names no socket path. Use unix:///var/run/docker.sock.`
      );
    }
    return {
      // Still this machine's kernel, whatever the socket is called: images,
      // volume paths and networks all remain the hub box's.
      connection: { socketPath: path, remote: false, describe: `unix://${path}` },
      problems: [],
      warnings: [],
    };
  }

  if (url.protocol === "ssh:") {
    return refuse(
      "DOCKER_HOST",
      `ssh:// is refused. dockerode supports it, but it would mean this hub holding an ` +
        `SSH private key or a forwarded agent socket for "${url.hostname}" — a shell on ` +
        `that host, usable for everything on it, where a Docker client certificate ` +
        `reaches the daemon API and nothing else. Use tcp://<host>:2376 with ` +
        `DOCKER_CERT_PATH, or run an ssh tunnel yourself and point DOCKER_HOST at the ` +
        `local end of it.`
    );
  }

  if (url.protocol !== "tcp:") {
    return refuse(
      "DOCKER_HOST",
      `"${host}" uses an unsupported scheme. The hub implements unix:// and tcp:// only ` +
        `— npipe:// and fd:// are not wired to anything here, and guessing at one would ` +
        `be inventing transport behaviour nobody tested.`
    );
  }

  const hostname = url.hostname;
  if (!hostname) {
    return refuse(
      "DOCKER_HOST",
      `"${host}" names no host. Use tcp://<host>:2376.`
    );
  }

  const remote = !isLoopback(hostname);

  if (certPath) {
    const material = readCertMaterial(certPath, io);
    if ("field" in material) {
      return { connection: null, problems: [material], warnings: [] };
    }
    const port = url.port ? Number(url.port) : 2376;
    return {
      connection: {
        host: hostname,
        port,
        protocol: "https",
        ca: material.ca,
        cert: material.cert,
        key: material.key,
        remote,
        describe: `tcp://${hostname}:${port} (mutual TLS)`,
      },
      problems: [],
      warnings: [],
    };
  }

  const port = url.port ? Number(url.port) : settings.port;

  if (remote && !settings.allowInsecureTcp) {
    return refuse(
      "DOCKER_CERT_PATH",
      `DOCKER_HOST points at "${hostname}", another machine, with no TLS material. A ` +
        `plaintext Docker daemon is an UNAUTHENTICATED ROOT API: anyone who can reach ` +
        `tcp://${hostname}:${port} can start a privileged container there and own the ` +
        `host, and nothing about that shows up in this hub. Set DOCKER_CERT_PATH to a ` +
        `directory holding ca.pem/cert.pem/key.pem (see ` +
        `https://docs.docker.com/engine/security/protect-access/). If the link is ` +
        `already encrypted and access-controlled — a WireGuard address, an ssh -L ` +
        `tunnel — set DOCKER_ALLOW_INSECURE_TCP=true to say so explicitly.`
    );
  }

  return {
    connection: {
      host: hostname,
      port,
      protocol: "http",
      remote,
      describe: `tcp://${hostname}:${port} (no TLS)`,
    },
    problems: [],
    warnings: remote
      ? [
          `Docker daemon tcp://${hostname}:${port} is used WITHOUT TLS because ` +
            `DOCKER_ALLOW_INSECURE_TCP=true. Anyone who can reach that port has root on ` +
            `that host. This is only defensible on a link that is already encrypted and ` +
            `access-controlled.`,
        ]
      : [],
  };
}

/** Read a variable, treating present-but-blank as unset (see config.ts). */
function str(
  env: Partial<Record<string, string>>,
  key: string,
  fallback: string
): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

/**
 * The env contract, in one place.
 *
 * config.ts spreads this so boot validation and the driver cannot read
 * different variables — the failure mode being a hub that validates the
 * daemon it is not going to use.
 */
export function dockerDaemonSettingsFromEnv(
  env: Partial<Record<string, string>> = process.env
): DockerDaemonSettings {
  // Blank is unset; a non-empty non-integer is a refusal, in the exact words
  // getEnvInt uses — this variable was read through it until now, and quietly
  // becoming lenient about a value an operator got wrong would be a regression
  // in loudness, not a simplification.
  const rawPort = env.DOCKER_PORT?.trim();
  if (rawPort && !/^\d+$/.test(rawPort)) {
    throw new Error("Invalid integer for environment variable: DOCKER_PORT");
  }
  return {
    host: str(env, "DOCKER_HOST", ""),
    socketPath: str(env, "DOCKER_SOCKET", DEFAULT_DOCKER_SOCKET),
    port: rawPort ? Number(rawPort) : 2375,
    certPath: str(env, "DOCKER_CERT_PATH", ""),
    allowInsecureTcp:
      env.DOCKER_ALLOW_INSECURE_TCP?.toLowerCase() === "true" ||
      env.DOCKER_ALLOW_INSECURE_TCP === "1",
  };
}
