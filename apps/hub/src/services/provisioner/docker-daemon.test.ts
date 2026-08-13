/**
 * Unit tests: which Docker daemon the hub talks to, resolved from env.
 *
 * The case that must never regress is the FIRST one. Every deployment today
 * sets none of these variables and gets `/var/run/docker.sock`; a change that
 * makes the local path conditional on anything is a change that breaks every
 * live hub at once.
 *
 * The rest is a security boundary, not a convenience. A Docker socket is root
 * on the machine that owns it, so pointing the hub at a daemon over a network
 * hands the hub a credential to a box it previously could not touch. These
 * tests pin the refusals that keep that from happening by accident.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_DOCKER_SOCKET,
  dockerDaemonSettingsFromEnv,
  resolveDockerDaemon,
  type DockerDaemonSettings,
} from "./docker-daemon";

/** Nothing configured — the shape every current deployment has. */
const UNSET: DockerDaemonSettings = {
  host: "",
  socketPath: DEFAULT_DOCKER_SOCKET,
  port: 2375,
  certPath: "",
  allowInsecureTcp: false,
};

const PEM_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBca\n-----END CERTIFICATE-----\n";
const PEM_CA_SECOND =
  "-----BEGIN CERTIFICATE-----\nMIIBintermediate\n-----END CERTIFICATE-----\n";
const PEM_CERT =
  "-----BEGIN CERTIFICATE-----\nMIIBclient\n-----END CERTIFICATE-----\n";
const PEM_KEY = "-----BEGIN PRIVATE KEY-----\nMIIBkey\n-----END PRIVATE KEY-----\n";

/** Stands in for /etc/agentpod/docker-certs, so no test writes to a disk. */
function fakeCerts(files: Record<string, string>) {
  return (path: string): string => {
    const content = files[path];
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), {
        code: "ENOENT",
      });
    }
    return content;
  };
}

const CERT_DIR = "/etc/agentpod/docker-certs";
const READ_CERTS = fakeCerts({
  [`${CERT_DIR}/ca.pem`]: PEM_CA,
  [`${CERT_DIR}/cert.pem`]: PEM_CERT,
  [`${CERT_DIR}/key.pem`]: PEM_KEY,
});

const fields = (settings: DockerDaemonSettings, readFile = READ_CERTS) =>
  resolveDockerDaemon(settings, { readFile }).problems.map((p) => p.field);

describe("resolveDockerDaemon — the unconfigured default", () => {
  it("uses the local socket when nothing is set", () => {
    const { connection, problems } = resolveDockerDaemon(UNSET);
    expect(problems).toEqual([]);
    expect(connection?.socketPath).toBe("/var/run/docker.sock");
    expect(connection?.host).toBeUndefined();
    expect(connection?.protocol).toBeUndefined();
    expect(connection?.ca).toBeUndefined();
    expect(connection?.remote).toBe(false);
  });

  it("still honours DOCKER_SOCKET on its own", () => {
    // Rootless Docker puts the socket under $XDG_RUNTIME_DIR. That has always
    // worked through DOCKER_SOCKET and must keep working.
    const { connection, problems } = resolveDockerDaemon({
      ...UNSET,
      socketPath: "/run/user/1000/docker.sock",
    });
    expect(problems).toEqual([]);
    expect(connection?.socketPath).toBe("/run/user/1000/docker.sock");
    expect(connection?.remote).toBe(false);
  });

  it("reads the same defaults out of an empty environment", () => {
    expect(dockerDaemonSettingsFromEnv({})).toEqual(UNSET);
  });
});

describe("resolveDockerDaemon — unix:// hosts", () => {
  it("takes the socket path out of a unix:// URL", () => {
    const { connection, problems } = resolveDockerDaemon({
      ...UNSET,
      host: "unix:///run/docker-proxy.sock",
    });
    expect(problems).toEqual([]);
    expect(connection?.socketPath).toBe("/run/docker-proxy.sock");
    expect(connection?.host).toBeUndefined();
    // A socket is a file on THIS machine however it is spelled, so no image or
    // volume assumption changes.
    expect(connection?.remote).toBe(false);
  });
});

describe("resolveDockerDaemon — TLS over TCP", () => {
  const REMOTE_TLS: DockerDaemonSettings = {
    ...UNSET,
    host: "tcp://docker-host.internal:2376",
    certPath: CERT_DIR,
  };

  it("connects over https with the client certificate", () => {
    const { connection, problems } = resolveDockerDaemon(REMOTE_TLS, {
      readFile: READ_CERTS,
    });
    expect(problems).toEqual([]);
    expect(connection?.host).toBe("docker-host.internal");
    expect(connection?.port).toBe(2376);
    expect(connection?.protocol).toBe("https");
    expect(connection?.cert).toBe(PEM_CERT);
    expect(connection?.key).toBe(PEM_KEY);
    // No socketPath: dockerode prefers `host` when both are present, but
    // sending both would leave which daemon we talk to depending on a library
    // detail rather than on this function.
    expect(connection?.socketPath).toBeUndefined();
    expect(connection?.remote).toBe(true);
  });

  it("passes the CA as a list of certificates, not one blob", () => {
    // A CA bundle routinely holds a root and an intermediate. Node's tls `ca`
    // option takes an array; handing it a single concatenated string is the
    // reason docker-modem depends on split-ca at all.
    const { connection } = resolveDockerDaemon(REMOTE_TLS, {
      readFile: fakeCerts({
        [`${CERT_DIR}/ca.pem`]: PEM_CA + PEM_CA_SECOND,
        [`${CERT_DIR}/cert.pem`]: PEM_CERT,
        [`${CERT_DIR}/key.pem`]: PEM_KEY,
      }),
    });
    expect(connection?.ca).toHaveLength(2);
    expect(connection?.ca?.[0]).toContain("MIIBca");
    expect(connection?.ca?.[1]).toContain("MIIBintermediate");
  });

  it("defaults to Docker's TLS port when the URL carries none", () => {
    const { connection } = resolveDockerDaemon(
      { ...REMOTE_TLS, host: "tcp://docker-host.internal" },
      { readFile: READ_CERTS }
    );
    expect(connection?.port).toBe(2376);
  });

  it("never puts key material in the description it logs", () => {
    const { connection } = resolveDockerDaemon(REMOTE_TLS, {
      readFile: READ_CERTS,
    });
    expect(connection?.describe).toContain("docker-host.internal:2376");
    expect(connection?.describe).not.toContain("PRIVATE KEY");
  });

  it("refuses a certificate directory it cannot read", () => {
    const problems = resolveDockerDaemon(REMOTE_TLS, {
      readFile: fakeCerts({ [`${CERT_DIR}/ca.pem`]: PEM_CA }),
    }).problems;
    expect(problems.map((p) => p.field)).toEqual(["DOCKER_CERT_PATH"]);
    expect(problems[0]!.message).toContain("cert.pem");
  });

  it("refuses a ca.pem holding no certificate at all", () => {
    const problems = resolveDockerDaemon(REMOTE_TLS, {
      readFile: fakeCerts({
        [`${CERT_DIR}/ca.pem`]: "# put the CA here\n",
        [`${CERT_DIR}/cert.pem`]: PEM_CERT,
        [`${CERT_DIR}/key.pem`]: PEM_KEY,
      }),
    }).problems;
    expect(problems.map((p) => p.field)).toEqual(["DOCKER_CERT_PATH"]);
  });
});

describe("resolveDockerDaemon — refusing to shout root at the network", () => {
  it("refuses a remote daemon with no TLS material", () => {
    // Plaintext 2375 is an unauthenticated root API. Nothing about the failure
    // is visible afterwards, which is why it has to be visible at boot.
    const { connection, problems } = resolveDockerDaemon({
      ...UNSET,
      host: "tcp://10.0.0.5:2375",
    });
    expect(connection).toBeNull();
    expect(problems.map((p) => p.field)).toEqual(["DOCKER_CERT_PATH"]);
    expect(problems[0]!.message).toMatch(/DOCKER_ALLOW_INSECURE_TCP/);
  });

  it("allows plaintext only when the operator says so in as many words", () => {
    const { connection, problems, warnings } = resolveDockerDaemon({
      ...UNSET,
      host: "tcp://10.0.0.5:2375",
      allowInsecureTcp: true,
    });
    expect(problems).toEqual([]);
    expect(connection?.protocol).toBe("http");
    expect(connection?.host).toBe("10.0.0.5");
    expect(connection?.port).toBe(2375);
    expect(connection?.remote).toBe(true);
    // Permitted is not the same as unremarkable.
    expect(warnings.join(" ")).toMatch(/DOCKER_ALLOW_INSECURE_TCP/);
  });

  it("allows plaintext to a loopback daemon without ceremony", () => {
    // 127.0.0.1:2375 is this machine's own daemon exposed on a port. Nothing
    // leaves the box, so there is nothing to refuse.
    const { connection, problems, warnings } = resolveDockerDaemon({
      ...UNSET,
      host: "tcp://127.0.0.1:2375",
    });
    expect(problems).toEqual([]);
    expect(connection?.protocol).toBe("http");
    expect(connection?.remote).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("refuses ssh://, and says why rather than pretending not to understand", () => {
    // dockerode can do it (docker-modem/lib/ssh.js). The objection is the
    // credential: an SSH key or a forwarded agent is a shell on the target,
    // reusable for everything on it, where a client certificate reaches the
    // Docker API and nothing else.
    const { connection, problems } = resolveDockerDaemon({
      ...UNSET,
      host: "ssh://deploy@10.0.0.5",
    });
    expect(connection).toBeNull();
    expect(problems.map((p) => p.field)).toEqual(["DOCKER_HOST"]);
    expect(problems[0]!.message).toMatch(/ssh/i);
  });

  it("refuses a scheme it does not implement instead of guessing", () => {
    for (const host of ["npipe:////./pipe/docker_engine", "fd://", "10.0.0.5:2375"]) {
      expect(fields({ ...UNSET, host })).toEqual(["DOCKER_HOST"]);
    }
  });

  it("refuses a tcp:// URL with no host in it", () => {
    expect(fields({ ...UNSET, host: "tcp://" })).toEqual(["DOCKER_HOST"]);
  });

  it("refuses certificates configured for a daemon that was never named", () => {
    // The silent half-configuration: certs in place, DOCKER_HOST forgotten, so
    // the hub quietly uses the local socket while the operator believes their
    // runtimes moved off the box.
    const problems = resolveDockerDaemon(
      { ...UNSET, certPath: CERT_DIR },
      { readFile: READ_CERTS }
    ).problems;
    expect(problems.map((p) => p.field)).toEqual(["DOCKER_HOST"]);
  });

  it("refuses two different daemons named at once", () => {
    // DOCKER_HOST and a non-default DOCKER_SOCKET are two answers to "where is
    // the daemon". Picking one silently is how an operator ends up certain
    // their containers are somewhere they are not.
    const problems = resolveDockerDaemon(
      {
        ...UNSET,
        host: "tcp://docker-host.internal:2376",
        socketPath: "/run/user/1000/docker.sock",
        certPath: CERT_DIR,
      },
      { readFile: READ_CERTS }
    ).problems;
    expect(problems.map((p) => p.field)).toEqual(["DOCKER_SOCKET"]);
  });
});

describe("dockerDaemonSettingsFromEnv", () => {
  it("reads every variable the resolver acts on", () => {
    expect(
      dockerDaemonSettingsFromEnv({
        DOCKER_HOST: "tcp://docker-host.internal:2376",
        DOCKER_SOCKET: "/var/run/docker.sock",
        DOCKER_PORT: "2375",
        DOCKER_CERT_PATH: CERT_DIR,
        DOCKER_ALLOW_INSECURE_TCP: "true",
      })
    ).toEqual({
      host: "tcp://docker-host.internal:2376",
      socketPath: "/var/run/docker.sock",
      port: 2375,
      certPath: CERT_DIR,
      allowInsecureTcp: true,
    });
  });

  it("still refuses a DOCKER_PORT that is not a whole number", () => {
    // config.ts read this through getEnvInt, which throws on a non-empty
    // non-integer. Moving the read here must not quietly make it lenient.
    expect(() => dockerDaemonSettingsFromEnv({ DOCKER_PORT: "23a75" })).toThrow(
      /DOCKER_PORT/
    );
  });

  it("treats a present-but-blank variable as unset", () => {
    // Every deployment surface — a .env line, a systemd Environment=, a copied
    // block from docs/DEPLOYMENT.md — turns "I did not set this" into "".
    expect(dockerDaemonSettingsFromEnv({ DOCKER_HOST: "  ", DOCKER_CERT_PATH: "" })).toEqual(
      UNSET
    );
  });
});
