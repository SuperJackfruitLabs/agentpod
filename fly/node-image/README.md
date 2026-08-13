# Fly Machines runtime images

What a `fly` provisioned runtime boots: the released `agentpod-node` binary plus
one harness, with its workspace anchored on a mounted Fly Volume.

| Dockerfile | Harness | Published as | Hub variable |
|---|---|---|---|
| `Dockerfile` | OpenCode | `ghcr.io/rakeshgangwar/agentpod-node-opencode-fly` | `NODE_AGENT_FLY_OPENCODE_IMAGE` |
| `Dockerfile.pi` | Pi | `ghcr.io/rakeshgangwar/agentpod-node-pi-fly` | `NODE_AGENT_FLY_PI_IMAGE` |

There is no generic (harness-less) Fly image, so a **Generic** Fly runtime cannot
work; the hub warns about it at boot naming `NODE_AGENT_FLY_IMAGE`.

Both are pinned to the same `AGENTPOD_VERSION`, deliberately: two stations on one
substrate running different node-agent builds makes "it works on the other one"
mean nothing.

## Why the wrapper exists

Measured on a real Fly account on 2026-08-12: a sentinel written to `/` was gone
after a stop→start; the same sentinel on a mounted volume survived. The machine
id and the volume were both preserved.

So `volume-workspace.sh` runs before the fleet entrypoint and points the two
things that must outlive a stop at the mount:

| Path | Why it must persist |
|---|---|
| `/workspace` | the user's files. Hardcoded in the fleet OpenCode entrypoint and in `internal/descriptor/opencode.go`, so it is symlinked rather than configured. |
| `$HOME` | `agentpod-node` keeps `nodeId`/`nodeSecret` under `os.UserConfigDir()`, and opencode keeps session state at `$HOME/.local/share/opencode`. |

`persist_rootfs` is deliberately not used: Fly's own docs disclaim it for
critical data.

If the volume is not mounted the wrapper **exits non-zero** rather than running.
With Fly's `restart.policy = "always"` that is a visible crash loop, which is a
far better failure than a station that looks fine until the work disappears.

Known cost of the symlink: the node-agent's disk-usage probe walks the workspace
with `filepath.WalkDir`, which does not follow symlinks, so a Fly station reports
a workspace of a few bytes on the Health panel. Every other workspace operation
(list, read, `cd`) follows the link normally. Wrong number, not lost work.

Compared with the Cloudflare substrate, which archives to R2 on SIGTERM
(`cloudflare/worker-v2/snapshot-wrapper.sh`): that wrapper carries no node
identity, so a woken Cloudflare station keeps its node row only because the hub
re-enrols its runtime-bound token onto the same node. Here the config file lands
on the volume, so identity survives on disk as well as in the hub.

## Build and push

**Prefer CI**: `.github/workflows/publish-images.yml` (Actions → publish-images →
Run workflow → `fly` or `fly-pi`, or `all`, and a tag). It builds natively on an
amd64 runner, pushes to GHCR, labels the image with the source commit, and then
verifies the image it pushed — `agentpod-node version` runs, and the harness
binary resolves from a *minimal service PATH* with the image's own `ENV`
discarded. That last check is the one that matters here: the node-agent spawns
ACP adapters with a service PATH, not a shell's, which is how a working-in-the-
shell Pi install once produced sessions that died in 500 ms.

By hand, with the build context at the **repository root**:

```bash
docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile \
  -t ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22 --push .

docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile.pi \
  -t ghcr.io/rakeshgangwar/agentpod-node-pi-fly:v0.1.22 --push .
```

`--platform linux/amd64` is required: Fly Machines are amd64, and an arm64 image
built on an Apple laptop fails at boot with an exec format error.

The package must be **public** — Fly pulls anonymously.

`AGENTPOD_VERSION` selects which released binary is baked in, verified against
`SHA256SUMS`.

**A CI publish does not use the Dockerfile default.** `publish-images.yml`
resolves the latest node-agent release at build time and passes it as
`--build-arg AGENTPOD_VERSION=…`, then asserts the pushed image reports that
version — so a published Fly image always carries the newest verified binary.
Its optional `node_agent_version` input pins an older release on purpose.

The `ARG` default is what a hand-build (the `docker buildx` lines above) gets,
so it still matters, and `check-version-pin.sh` fails the node-agent CI job when
either Dockerfile's default falls behind the latest release or the two disagree.
That check exists because they went stale in exactly that way: both sat on
v0.1.22 while the fleet ran v0.1.24, which meant no node-agent fix could reach a
Fly station however often the image was republished (issue #290).

## Pointing the hub at it

`imageForHarness()` resolves the image for every provider, so the tag goes in
the hub's env:

```
NODE_AGENT_FLY_OPENCODE_IMAGE=ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22
NODE_AGENT_FLY_PI_IMAGE=ghcr.io/rakeshgangwar/agentpod-node-pi-fly:v0.1.22
```

The provider-scoped names are the safe choice on a hub that also runs Docker,
because they leave the Docker tags alone. The un-scoped
`NODE_AGENT_OPENCODE_IMAGE` works too — a registry-qualified tag is fine for
Docker, since the daemon pulls it — and is what lets one variable serve both
providers. A bare local tag such as `agentpod-node-opencode:local` cannot work on
Fly: there is no such image in any registry, and the machine create fails on the
pull. The hub warns at boot, per harness, when the image it would hand Fly is a
local tag.

## Tests

`sh fly/node-image/test-volume-workspace.sh` and
`sh fly/node-image/test-version-pin.sh` — both run in CI in the `node-agent`
job, which also runs `sh fly/node-image/check-version-pin.sh` against the live
release list.

The pin test is offline (every case passes an explicit `--latest`) and covers
the comparison that a string compare gets backwards: `v0.1.9` is *older* than
`v0.1.24`. `check-version-pin.sh --compare A B` prints `older|same|newer` if you
want to check a pair by hand.

The `/workspace` half of that test needs a writable `/`, so it skips on macOS.
To run it for real, bind-mount the directory into the built image:

```bash
docker run --rm -v "$PWD/fly/node-image":/t \
  --entrypoint sh agentpod-node-opencode-fly:local /t/test-volume-workspace.sh
```
