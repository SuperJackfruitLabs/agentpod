# Pi harness — design

**Date:** 2026-08-12
**Status:** approved (ad hoc request)
**Harness:** Pi — https://pi.dev · `@earendil-works/pi-coding-agent` · MIT · v0.84.1

## Goal

Make Pi the sixth harness: detected on any enrolled machine that runs it, conversable from the
Chat tab, and available as a provisionable container image.

Requested ad hoc on 2026-08-12, not from the roadmap.

## Observed facts

**Everything in this section was read off a real Pi 0.84.1 install on the operator's Mac on
2026-08-12. Nothing here comes from Pi's documentation.** That distinction is the whole reason
this section exists — see *Detection-path discipline* below.

```
~/.pi/agent/
  auth.json           -rw-------   credentials (API keys + OAuth tokens)
  models-store.json   -rw-------   cached model catalogs
  settings.json       -rw-r--r--
  bin/rg                           pi-managed ripgrep
  sessions/
    --Users-rakeshgangwar-Projects-research--/   2026-08-12T08-10-23-796Z_<uuid>.jsonl
    --Users-rakeshgangwar-Projects-idea-bank--/  <ts>_<uuid>.jsonl
    --private-tmp--/                             (no .jsonl at all)
```

Two of those three directories settle design decisions on their own:

- **`--Users-rakeshgangwar-Projects-idea-bank--`** decodes naively to
  `/Users/rakeshgangwar/Projects/idea/bank`, which does not exist. Its header says
  `/Users/rakeshgangwar/Projects/idea-bank`. A decode-the-directory-name strategy would have
  filtered this station out **silently** — a real project, invisible. This is the hyphen
  ambiguity `opencode.go` documents, observed live on the second project that existed.
- **`--private-tmp--`** was created by a `pi --mode rpc` probe that never wrote a session, so the
  directory exists with no `.jsonl` inside. It also shows Pi stores the **resolved** path
  (`/tmp` → `/private/tmp`), which is why detection dedupes through `filepath.EvalSymlinks`.

Findings that shape the design:

1. **`models.json` and `trust.json` do not exist.** Pi's docs list both; they are created on
   demand. A path list written from the documentation would have named files that exist on no
   machine we own — precisely the failure that graded molt-bot an "A" without opening anything.
2. **The session file's first line carries the workspace path verbatim:**
   `{"type":"session","version":3,"id":"…","timestamp":"…","cwd":"/Users/rakeshgangwar/Projects/research"}`
   So discovery never has to decode the sanitised directory name.
3. **`comm` is `node`, not `pi`.** `ps -o comm,args` gives `node  node /opt/homebrew/bin/pi --mode rpc`;
   `pgrep -x pi` matches nothing. Pi is a JS entrypoint (`/opt/homebrew/bin/pi` symlinks to
   `dist/cli.js`), installed by npm under the Homebrew prefix — it is **not** a Homebrew formula.
4. **No daemon.** Pi is invoked per command. There is no `pi serve` and no port.
5. `pi-debug.log` is the only log file, and it is written only when the hidden `/debug` is enabled.

Unverified and deliberately left so: Pi documents that it sets `AI_AGENT=pi` and
`PI_CODING_AGENT=true`. The reading taken on this machine was contaminated — Pi inherited the
environment of the Claude Code shell that spawned it — so this design does not rely on those
markers. Re-check in a clean shell before using them for anything.

## Architecture

### Detect — session directories, path read from the header

Enumerate `~/.pi/agent/sessions/*/`. For each, read the first line of any `*.jsonl` and take
`cwd` **verbatim**. Filter paths that no longer exist. Deduplicate by `filepath.EvalSymlinks`,
as `opencode.go` does.

This is strictly better than OpenCode's fallback, which decodes `-` back to `/` and therefore
mis-decodes any path component containing a hyphen. Pi's header removes the ambiguity entirely,
so **the decode path is not implemented at all** — if a directory has no readable session file,
it is skipped rather than guessed at.

The session directory is overridable by `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or
`sessionDir` in `settings.json`. The descriptor reads `PI_CODING_AGENT_DIR` and
`PI_CODING_AGENT_SESSION_DIR` when set, and otherwise uses the default. A machine that moved its
session directory via `settings.json` will under-report; that is accepted and documented rather
than guessed at.

**One Pi install yields many stations** — one per workspace, like OpenCode and Claude Code.

**Amended 2026-08-13 (issue #286): the node's own workspace is a station too.** Deriving stations
from existing sessions alone means a machine where Pi has never run reports none — which is every
freshly provisioned Pi runtime. Measured live on Modal: the runtime reached `online` and
`GET /api/nodes/<id>/stations` returned `[]`, so there was no station id for Chat, Files or
Terminal to be scoped to. `Detect` therefore reports the workspace directory itself
(`AGENTPOD_WORKSPACE_PATH`, default `/workspace`) as a station whenever that directory exists
**and** Pi is installed on the node — the second condition because every node-agent registers
every descriptor and every provisioned image has a `/workspace`, OpenCode's included. Sessions are
added to that station list, never substituted for it, so a fleet host (which has no `/workspace`)
detects exactly what it detected before. The workspace station uses the same
`pi:<hash-of-path>` key, so the session Pi writes on the first chat dedupes into the station the
hub already adopted instead of creating a second one.

### Key scheme

`pi:<first 8 hex of SHA256(workspacePath)>` — matching `opencode.go` and `codex.go`. The key is
the hub's primary identity for a station and cannot be changed after adoption.

`Harness()` returns `"pi"`, which **must** equal the provisioning enum value, or auto-adoption
silently fails to match (`runtime-autoadopt.ts` matches on harness string equality).

### Capabilities

```
health, logs, fs.read, fs.write, terminal, cleanup   always
acp                                                  only when the pi-acp adapter resolves
changeset                                            via AppendChangesetCap (git probe)
lifecycle                                            NEVER
```

`lifecycle` is never advertised: Pi has no persistent process to stop or start. Unlike
`opencode.go`, this descriptor does not implement `Lifecycle` at all, so there is nothing to
guard.

`terminal` and `changeset` need no descriptor code — the gateway serves both from
`WorkspacePath`.

### Health

`DiskBytes` from the shared async `diskUsage()` cache; never walk on the request path.

`Running` via `pgrep -f`. **This line has produced two live-fleet bugs already** (the broad
`opencode` pattern matched docker-init's own cmdline), so: match on the resolved Pi entry path
plus `--mode rpc`, never on the bare string `pi`, which appears in countless unrelated command
lines. Because `comm` is `node`, `pgrep -x` is useless here.

Pi having no daemon means `Running` is normally **false**, and that is correct rather than a
fault. The console must not present a Pi station as unhealthy for having no process.

`LastActivity` — newest mtime across the station's session directory.

### Logs

`~/.pi/agent/pi-debug.log`, global rather than per-station, and usually absent. `TailLogs` uses
the existing `waitForLogFiles` helper so a station with no log file does not close the stream
immediately.

### ACP — via the pinned `pi-acp` adapter

Pi does not speak ACP. The maintainer declined it
([earendil-works/pi#175](https://github.com/earendil-works/pi/issues/175)); the source has
`interactive/`, `json-event.ts`, `print-mode.ts`, `rpc/` and no ACP mode.

`ACPCommand` therefore returns the community adapter `pi-acp` (npm, MIT, bin `pi-acp`, requires
Node ≥ 20, depends on `@agentclientprotocol/sdk`), which speaks ACP outward and spawns
`pi --mode rpc` inward. **This is the third instance of a pattern already in the codebase** —
`claude-code` and `codex` both resolve external Node adapters through `binary.go` with version
floors.

Three rules, each mirroring existing practice:

- **Pin the version** (`pi-acp@0.0.33`), as `opencode-ai@1.18.15` is pinned.
- **Gate the `acp` capability on the adapter resolving.** No adapter → the station simply does
  not advertise `acp`, and the Chat tab does not appear. A Chat tab that fails on click is worse
  than no Chat tab.
- **Resolve it like the other adapters** rather than shelling out to `npx` on the request path,
  which would make the first prompt of every session wait on a network fetch.

The adapter's documented limitation — no filesystem or terminal delegation — does not affect us.
That is ACP's mechanism for an agent to ask its *client* to perform file operations; AgentPod
serves `fs.read`, `fs.write` and `terminal` through the node-agent directly, and Pi's own tools
operate on disk. The gap Zed users feel is one this architecture routes around.

Residual risk, stated plainly: a 0.0.x package with a single maintainer sits on the Chat path.
It sits on *only* the Chat path — detection, health, logs, files, terminal and changeset never
touch it.

### Posture

`creds.go` gains a dated `"pi"` entry: `auth.json` (observed `0600`), `models-store.json`
(observed `0600`), `settings.json` (observed `0644`, not a credential file but read for
completeness), and `models.json` **recorded as conditional** — it can legitimately hold literal
API keys but does not exist until the user defines a custom provider.

`posture_test.go` gains the matching pair of pins used for every other harness: one asserting the
real layout, one asserting the paths that must never come back.

`StationCredentialLayouts` gains **nothing** — Pi is not composite; it has no per-station
profile directories with their own secrets.

`HarnessProcessNames` gains nothing unless Pi is observed binding a port. It is stdio-only.

## Container image — base + per-harness layers

**The refactor lands with Pi, not after it.** An earlier draft deferred it; that was wrong, and
the reason is simple arithmetic: deferring does not avoid the refactor, it makes it touch three
harness images instead of the two that exist today. The cheapest moment to do it is always now.

```
Dockerfile.base   → agentpod-node:base   verified agentpod-node binary + shared entrypoint
Dockerfile        → FROM base            generic, no harness
Dockerfile.opencode → FROM base          + bun, opencode-ai@1.18.15, supervision entrypoint
Dockerfile.pi     → FROM base            + node 24, pi@0.84.1, pi-acp@0.0.33
```

Rejected alternatives, recorded so they are not re-proposed:

- **One Dockerfile with `ARG HARNESS`** — fewer files, but every harness's install logic lands in
  one script and they start interfering.
- **Installing the harness at container start from env** — needs network at boot, makes start
  time depend on npm, and makes the running image non-deterministic. That is the opposite of what
  the SHA256-verified binary buys us.

The refactor touches the working OpenCode image and, through it, the Cloudflare path. It
therefore gets its own task and its own verification: **the OpenCode image must be rebuilt from
the new base and a station provisioned from it before Pi's layer is written.** Pi must not be the
thing that discovers a regression in OpenCode's image.

Pi's image is the boring one, because **Pi needs no supervision loop**. All the entrypoint
complexity in `node-opencode-entrypoint.sh` — the double-fork, the stop sentinel,
`AGENTPOD_OPENCODE_SUPERVISED` — exists because `opencode serve` is a daemon. Pi is
per-invocation, so its container uses the simple entrypoint: enrol, then run.

Consequence worth stating: **no second entrypoint-parity pair and no second parity test.** The
fork flagged during research does not arise.

```dockerfile
FROM node:24-bookworm-slim          # Pi requires Node >= 22.19
RUN apt-get install -y --no-install-recommends bash ca-certificates git ripgrep procps
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
RUN npm install -g --ignore-scripts pi-acp@0.0.33
# agentpod-node binary: built from source (fleet image) or pulled from a
# release and verified against SHA256SUMS (Cloudflare image), as today.
```

`--ignore-scripts` matches Pi's own installer. `procps` provides the `pgrep` the health check
needs.

**Cloudflare keeps its constraint**: one worker bakes one image, so a Pi station on that
substrate is a second worker deployment, not a dropdown choice. A single image carrying both
harnesses would avoid that, but it muddies auto-adoption — which matches a runtime's `harness`
against detected stations — so it is out of scope here.

## Provisioning

- `packages/contract/src/runtime.ts` — `RuntimeHarness` enum gains `"pi"` (+ its contract test).
  No DB migration: `harness` is a plain text column.
- `apps/hub/src/services/runtimes.ts` — `imageForHarness` gains a Pi branch and
  `NODE_AGENT_PI_IMAGE`.
- `apps/console/.../NewRuntimeDialog.svelte` — harness option `{ value: "pi", label: "Pi" }`.
- `apps/console/src/routes/nodes/[id]/+page.svelte` — the empty state enumerates the five
  harnesses by name and must gain Pi.

Detected stations need **none** of the above: `station.harness` is a free-form string, and the
console has no harness icon or label map.

The resource-tier floor is an empirical number, not a guess — OpenCode's `small` had to rise to
1g after a live runtime OOM-killed its ACP session at 513MB RSS. Pi's floor is measured under a
real ACP session before it is written down.

## Testing

| Layer | Test |
|---|---|
| Detect | fixture with two session dirs; `cwd` read from header; non-existent path filtered; missing data dir → empty slice; a session dir with no readable jsonl is skipped, not guessed |
| Health | disk usage, last-activity mtime; `Running` false with no process is not an error |
| fs | `ListDir`/`ReadFile` happy path, `..` escape rejected, truncation |
| Logs | absent log file does not close the stream immediately |
| ACP | `acp` advertised **only** when the adapter resolves; `acp_command_test.go` gains its sixth `t.Run` subtest |
| Posture | the two pins every harness carries |
| Live | detected on a real machine running Pi, and a prompt answered in the Chat tab |

The live row is the acceptance criterion. Everything above it is scaffolding.

## Detection-path discipline

`creds.go` states the rule this spec is written under:

> Every entry below was checked against a running machine on 2026-08-11, and the date matters:
> the first version of this map was written from assumption and named five files that exist on
> no machine we own. **Adding a harness means adding a line here AND verifying it on a real
> host.**

Every external path in this design carries a dated observation, and the `models.json` /
`trust.json` finding above is what that rule catches when followed.

**Open gap, stated rather than hidden:** the Pi installation available today is a Mac with two
real projects — enough to exercise multi-station detection, and it already produced the
hyphen-path and empty-session-dir cases above. What it cannot show is **Linux process naming**:
`comm` is `node` here, and the Linux binary may differ. That must be verified on a Linux host
running Pi before this is called done.

## Out of scope

- A Pi Cloudflare worker deployment.
- A multi-harness image.
- Pi's experimental `@earendil-works/pi-server` (Unix-socket CBOR, published 6 days ago, marked
  "may change or be removed without notice"). Re-evaluate if it stabilises into a real daemon —
  it would change the health and lifecycle design.
