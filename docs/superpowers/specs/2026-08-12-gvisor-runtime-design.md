# gVisor runtime for provisioned runtimes — design

**Status:** approved 2026-08-12
**Horizon:** 1 — step 2 of the re-planned driver wave (`docs/strategy/2026-08-10-suite-strategy.md`)
**Validated by a live spike before this spec was written.** See "Evidence".

## Problem

Every provisioned Docker runtime lands **on the hub box**. `DockerRuntimeProvisioner`'s
default constructor calls `new DockerOrchestrator()` with no config, which falls through to
`socketPath: "/var/run/docker.sock"`. Agent workloads therefore share CPU, memory and — the
part that matters here — **a kernel** with the control plane that manages them.

These containers run agent-generated code. A container escape is a hub compromise.

Two separable problems live in that sentence:

- **Isolation** — shared kernel, ordinary `runc` namespaces.
- **Co-location** — the same physical machine, so a runaway agent starves the hub.

This spec fixes the first. **The second is deferred**: fixing it means either exposing a
Docker daemon over the network (a credential granting root on the target, which we refused
for SSH an hour earlier) or putting Tailscale on the hub box, which the operator has
declined for now. Being left with a noisy-neighbour problem rather than a breach is the
better half to keep.

## Why gVisor and not something stronger

Researched 2026-08-12. Every other isolation step demands hardware or a cluster:

| Option | Host requirement |
|---|---|
| **gVisor (`runsc`)** | **Any Linux 4.14.77+. No nested virt, no bare metal.** |
| Kata Containers | KVM / nested virtualisation / bare metal |
| Firecracker direct | Bare metal, plus you build the orchestration |
| k8s `agent-sandbox` | A Kubernetes cluster |

gVisor's default `systrap` platform runs on ordinary cloud VMs and is often *faster* than
KVM inside a VM. Overhead is 5–20% depending on syscall frequency. Integration is a Docker
runtime flag. It is the only option that upgrades isolation on the machine we already have,
without a new driver or a new abstraction.

The hub box qualifies: Ubuntu 24.04.4, kernel 6.8.0, x86_64, Docker 29.6.1.

## Evidence

`runsc` `release-20260803.0` was installed on the hub box and the whole path exercised
before this design was written, because a config flag for a runtime that breaks the agent
would be worse than no flag.

| Check | Result |
|---|---|
| gVisor genuinely intercepting | container kernel `4.19.0-gvisor` vs host `6.8.0-107-generic` |
| `/proc` — pid, memory, cpu (health) | works |
| Process listing (`ps`) | works |
| **PTY: `pty.StartWithSize`, `Setsize`, read/write** | **byte-identical to `runc`** |
| Long-lived child over stdio (ACP shape) | works |
| Signals and child reaping | works — exit 143 on SIGTERM |
| Node-agent enrols and dials the hub | `status: online` |
| Heartbeats sustained over minutes | last seen 3s ago |
| Node capabilities over the wire | `["posture"]` |
| `apn scan` inside the sandbox | grade A, `unknown` for absent `lsof` |

**One finding worth carrying forward.** `docker run -t` *does* behave differently under
gVisor — `tty` cannot resolve `/dev/pts/0`. But the node-agent does not use docker's TTY; it
allocates its own via `creack/pty` in `internal/terminal/session.go`. A probe built against
**that** library was identical to `runc`. Testing the convenient thing rather than the real
thing would have produced a false alarm and possibly killed this slice.

## Design

### Configuration

A single hub-level environment variable, `DOCKER_RUNTIME`. Unset means today's behaviour
exactly — Docker's default, `runc`.

It is **not** a per-request option. The operator decides a host's security posture once;
exposing it per provision would put a dropdown in the console whose other setting is "less
isolation, please", and would let a caller opt out of the protection.

### Fail closed, never fall back

If `DOCKER_RUNTIME` names a runtime Docker does not have, the provision **fails with a clear
error naming the requested runtime and listing what Docker does have**.

It must never silently fall back to `runc`. A silent fallback leaves an operator believing
they have kernel isolation while they have none — the same failure shape as a scanner
reporting grade A on files it never opened, which this codebase shipped once already and
fixed the same week.

### Record what ran, not what was asked

After create, read `HostConfig.Runtime` back via `inspect` and persist it on the
`provisioned_runtimes` row as `runtime`, surfaced in the console.

"We requested `runsc`" is a hope; "Docker reports this container is running under `runsc`"
is a fact. The same reason `changeset.status` reports *which* base rule fired rather than
assuming, and the same reason posture walks the ancestor chain rather than trusting a mode
bit.

`runtime` is nullable: rows created before this change, and any non-Docker provider, have no
value and the console shows nothing rather than guessing.

### What changes

- `DockerOrchestratorConfig` gains `runtime?: string`.
- `buildContainerOptions` sets `HostConfig.Runtime` only when configured — omitted entirely
  when unset, so the request is byte-identical to today's.
- `Sandbox` gains `runtime?: string`, populated from `inspect`.
- `DockerRuntimeProvisioner` reads `DOCKER_RUNTIME` from env and returns the observed runtime
  alongside `externalId`.
- `RuntimeProvisioner.provision` returns `{ externalId, runtime? }`. Optional, so
  `CloudflareRuntimeProvisioner` is unchanged.
- `provisioned_runtimes` gains a nullable `runtime` column; `ProvisionedRuntime` in the
  contract gains the matching optional field.
- The console's runtime list shows the runtime when present.
- `docs/DEPLOYMENT.md` gains the `runsc` install steps. A config flag with no install
  instructions is a trap.

### Out of scope

- Remote Docker host — deferred, see Problem.
- Per-user or per-tier runtime choice.
- Any other isolation technology.
- Changing the default. `runsc` is installed on the hub box but nothing uses it until
  `DOCKER_RUNTIME` is set; enabling it in production is an operator action, taken after this
  ships and a runtime has been provisioned under it deliberately.

## Testing

- **Options builder** — `HostConfig.Runtime` present and correct when configured; **absent
  from the object entirely** when unset, so an unconfigured hub sends exactly what it sends
  today.
- **Fail closed** — a create rejected by Docker for an unknown runtime surfaces an error
  naming the requested runtime; it must not resolve successfully.
- **Observed runtime** — the value stored comes from `inspect`, not from config. A test where
  config says `runsc` and inspect reports `runc` must store `runc`, because that is the case
  the field exists to catch.
- **Provisioner** — reads the env var; omits `runtime` when unset.
- **Route/service** — the column round-trips and appears in the API response.
- **Console** — the runtime is displayed when present and nothing is shown when null.
- Existing docker and cloudflare provisioner tests must pass unchanged, proving the default
  path is untouched.

Per repo convention, every test is written failing first.

## Known limits

**gVisor does not implement every syscall.** The four capabilities this fleet depends on were
verified, but a harness doing something unusual could still break. This is why the default
stays off and the observed runtime is recorded — a station misbehaving under `runsc` must be
diagnosable from the console rather than by guessing.

**Overhead is real**, 5–20% depending on syscall frequency. Not measured for our harnesses;
worth watching after the first production runtime runs under it.

**This does not fix co-location.** A runaway agent can still starve the hub. That needs the
deferred remote-host work.
