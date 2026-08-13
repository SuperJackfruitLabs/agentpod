# Fly Machines runtime image

The image a `fly` provisioned runtime boots: the released `agentpod-node` binary
plus the OpenCode harness, with its workspace anchored on a mounted Fly Volume.

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

Build context is the **repository root**:

```bash
docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile \
  -t ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22 --push .
```

`--platform linux/amd64` is required: Fly Machines are amd64, and an arm64 image
built on an Apple laptop fails at boot with an exec format error.

The package must be **public** — Fly pulls anonymously.

`AGENTPOD_VERSION` selects which released binary is baked in; it defaults to the
fleet version in the Dockerfile and is verified against `SHA256SUMS`.

No CI workflow builds this image — like every other image in this repo it is
built by hand, and the tag the hub points at is the record of which build is
live.

## Pointing the hub at it

`imageForHarness()` resolves the image for every provider, so the tag goes in
the hub's env:

```
NODE_AGENT_OPENCODE_IMAGE=ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22
```

A registry-qualified tag works for Docker provisioning too (the daemon pulls
it), which is what lets one hub run both providers. A bare local tag such as
`agentpod-node-opencode:local` cannot work on Fly — there is no such image in
any registry, and the machine create fails on the pull.

## Tests

`sh fly/node-image/test-volume-workspace.sh` — runs in CI in the `node-agent`
job.

The `/workspace` half of that test needs a writable `/`, so it skips on macOS.
To run it for real, bind-mount the directory into the built image:

```bash
docker run --rm -v "$PWD/fly/node-image":/t \
  --entrypoint sh agentpod-node-opencode-fly:local /t/test-volume-workspace.sh
```
