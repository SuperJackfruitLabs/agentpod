# Fly Machines runtime images

What a `fly` provisioned runtime boots: the released `agentpod-node` binary plus
one harness, with its workspace anchored on a mounted Fly Volume.

| Dockerfile | Harness | Published as | Hub variable |
|---|---|---|---|
| `Dockerfile` | OpenCode | `ghcr.io/superjackfruitlabs/agentpod-node-opencode-fly` | `NODE_AGENT_FLY_OPENCODE_IMAGE` |
| `Dockerfile.pi` | Pi | `ghcr.io/superjackfruitlabs/agentpod-node-pi-fly` | `NODE_AGENT_FLY_PI_IMAGE` |

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
  -t ghcr.io/superjackfruitlabs/agentpod-node-opencode-fly:v0.1.22 --push .

docker buildx build --platform linux/amd64 \
  -f fly/node-image/Dockerfile.pi \
  -t ghcr.io/superjackfruitlabs/agentpod-node-pi-fly:v0.1.22 --push .
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
and it is **empty**, so a hand-build downloads `releases/latest/download`. Pass
`--build-arg AGENTPOD_VERSION=v0.1.35` to pin one on purpose.

**There is nothing to bump after a release.** There used to be. The default named
a version, the published images never read it (`publish-images.yml` passes its
own `--build-arg`), so the constant governed only hand-builds — and keeping it
current took a CI guard plus a bot-opened PR per release.

That machinery cost more than it bought:

- the guard failed `node-agent` on **every open PR** from the moment a release
  was cut until the bump landed, so a red CI meant "somebody released", not
  "your branch is broken";
- the PR is created with `GITHUB_TOKEN`, and a PR opened by that token cannot
  trigger `pull_request` workflows — its required checks sat at *Expected*
  forever. This file used to claim the job dispatched `ci.yml` to work around
  that. It did not: `chore/fly-pin-v0.1.35` had **no checks at all** and needed a
  manual `gh workflow run ci.yml --ref <branch>`;
- so the PRs went unmerged. `chore/fly-pin-v0.1.32` sat open for three weeks;
  `chore/fly-pin-v0.1.35` broke CI repo-wide until someone traced it by hand.

The property the pin was protecting is "a hand-build ships a current agent", and
`releases/latest/download` states that directly and cannot drift. The property
worth paying for — a *published* image built against one named, verified release
— is unaffected: `publish-images.yml` still resolves a concrete version, passes
it as a build-arg, and asserts the pushed image reports it.

The original failure this all came from is still worth remembering. On
2026-08-13 both Fly images sat on v0.1.22 while the fleet ran v0.1.24, so the
\#286 Pi fix could not reach a Fly station however often the image was
republished (issue #290). A stale constant caused that. There is no longer a
constant to go stale.

`latest-release.sh --compare A B` prints `older|same|newer` and is the one
comparator anything here uses to decide which of two versions precedes the
other — `v0.1.9` is *older* than `v0.1.24`, which a string comparison gets
backwards. `test-latest-release.sh` pins that, in the `node-agent` CI job.

## Pointing the hub at it

`imageForHarness()` resolves the image for every provider, so the tag goes in
the hub's env:

```
NODE_AGENT_FLY_OPENCODE_IMAGE=ghcr.io/superjackfruitlabs/agentpod-node-opencode-fly:v0.1.22
NODE_AGENT_FLY_PI_IMAGE=ghcr.io/superjackfruitlabs/agentpod-node-pi-fly:v0.1.22
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
`sh fly/node-image/test-latest-release.sh` — both run in CI in the `node-agent`
job, which also runs `sh fly/node-image/test-latest-release.sh` against the live
release list.

The pin test is offline (every case passes an explicit `--latest` or `--to`) and
covers both halves: the comparison that a string compare gets backwards
(`v0.1.9` is *older* than `v0.1.24`), and what the bump did when
the pin is behind, already current, or ahead of the target.
`latest-release.sh --compare A B` prints `older|same|newer` if you want to
check a pair by hand.

The `/workspace` half of that test needs a writable `/`, so it skips on macOS.
To run it for real, bind-mount the directory into the built image:

```bash
docker run --rm -v "$PWD/fly/node-image":/t \
  --entrypoint sh agentpod-node-opencode-fly:local /t/test-volume-workspace.sh
```
