# AgentPod — Production Deployment Guide

This guide covers a full production deployment of all three AgentPod tiers (node-agent images, hub, console) on a Linux host running nginx + certbot. It supersedes the P3-only runbook at `deploy/README-deploy.md`.

> **Safety constraints (read first)**
> - All steps are **additive only**. The reference box hosts `hub.<your-domain>` (+ Synapse's `id.<your-domain>`); the **console is on Cloudflare Pages at `console.<your-domain>`** and is not served from the box. The existing `id.<your-domain>` nginx vhost (Matrix/Synapse) must **never** be touched.
> - **`nginx -t` before every `systemctl reload nginx`**. A bad reload would take any co-hosted services offline.
> - Run steps one at a time; verify existing services stay up after each nginx reload.
> - Use `<HUB_HOST>` / `<your-domain>` placeholders below — substitute your actual hostname.

---

## Prerequisites

On the target box:

| Requirement | Notes |
|-------------|-------|
| **Docker** | Required for the Docker provisioner and image builds |
| **Postgres + pgvector** | Hub's database. See step 2. |
| **bun** | Runs the hub (`curl -fsSL https://bun.sh/install \| bash`) |
| **Node.js 20+** | pnpm is a Node program and the console build is `vite build`; a box with only bun cannot run step 5's `pnpm install`. CI uses Node 20. |
| **pnpm** | Builds the console. `corepack enable` is enough — the repo pins `packageManager: pnpm@10.18.2` in the root `package.json` and corepack honours the pin, so do **not** `corepack prepare pnpm@latest`: it can install a different major than the lockfile was written with. |
| **Go** | Only required when building the node-agent from source. The curl installer downloads prebuilt binaries — no Go needed on target hosts. |
| **nginx + certbot** | Existing reverse proxy; certbot for TLS |

The hub repo is assumed checked out at `/opt/agentpod` on the box (adjust paths as needed).

---

## 1. DNS

Configure two DNS records:

**`hub.<your-domain>`** — A-record pointing to your VPS IP. Use **DNS-only (grey cloud)** so nginx terminates TLS and WebSocket connections directly (avoids proxy timeout quirks on long-lived WS streams).

**`console.<your-domain>`** — add this as a **Cloudflare Pages custom domain** inside the Pages project settings (orange/proxied is fine — it's a static site). Do **not** add a separate A-record; Pages manages the routing.

Do **not** add an `app.<your-domain>` A-record — the console is no longer served from the VPS.

Wait for propagation: `dig +short hub.<your-domain>` should return the VPS IP.

---

## 2. Postgres

```bash
apt-get update && apt-get install -y postgresql postgresql-contrib postgresql-16-pgvector
sudo -u postgres psql -c "CREATE ROLE agentpod LOGIN PASSWORD '<STRONG_PASSWORD>';"
sudo -u postgres psql -c "CREATE DATABASE agentpod OWNER agentpod;"
sudo -u postgres psql -d agentpod -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

Tune for a shared box (optional): set `shared_buffers = 256MB` in `/etc/postgresql/16/main/postgresql.conf`, then `systemctl restart postgresql`.

---

## 3. Build the node-agent Docker images

Build the images on the Docker host from the repo root. The context path is `apps/node-agent`; the Dockerfiles live in `apps/node-agent/deploy/`.

`Dockerfile.base` carries everything shared — the Go build stage, the runtime distro, `ca-certificates curl git procps`, and the `agentpod-node` binary — and every harness image is `FROM agentpod-node:base`. **Build the base first**, or the harness builds fail to resolve their `FROM`. Rebuild it (and then the harness images) whenever the node-agent source changes.

```bash
cd /opt/agentpod

# Shared base image — build this first
docker build \
  -t agentpod-node:base \
  -f apps/node-agent/deploy/Dockerfile.base \
  apps/node-agent

# Generic node-agent image (no harness preloaded)
docker build \
  -t agentpod-node:local \
  -f apps/node-agent/deploy/Dockerfile \
  apps/node-agent

# OpenCode harness image (bun + opencode-ai@1.18.15 preloaded)
docker build \
  -t agentpod-node-opencode:local \
  -f apps/node-agent/deploy/Dockerfile.opencode \
  apps/node-agent

# Pi harness image (Node 24 + @earendil-works/pi-coding-agent@0.84.1 + pi-acp@0.0.33)
docker build \
  -t agentpod-node-pi:local \
  -f apps/node-agent/deploy/Dockerfile.pi \
  apps/node-agent
```

Verify: `docker images | grep agentpod-node`

---

## 4. Hub — environment file

Create `/etc/agentpod/hub.env` (mode `600`):

```bash
mkdir -p /etc/agentpod
chmod 700 /etc/agentpod
cat > /etc/agentpod/hub.env <<'EOF'
# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgres://agentpod:<STRONG_PASSWORD>@localhost:5432/agentpod

# NODE_ENV: `production` turns the boot checks below from warnings into
# refusals (dev secrets, weak entropy). The systemd unit also sets it; set it
# here too so the hub behaves the same when run by hand.
NODE_ENV=production

# ── Auth ──────────────────────────────────────────────────────────────────────
# BETTER_AUTH_SECRET: read by config.ts and passed explicitly to betterAuth().
# In production it must be ≥32 chars AND mix at least two character classes —
# 32 lowercase letters is refused (validate-config.ts: hasMinimumEntropy).
BETTER_AUTH_SECRET=<run: openssl rand -hex 32>

# ENCRYPTION_KEY: exactly 32 characters (AES-256-GCM for stored credentials).
# `openssl rand -hex 16` gives 32 hex characters. Keep the value alone on its
# line: the pre-flight below (and bun's own .env parser) do not strip trailing
# comments, so `KEY=abc  # note` makes the key 32+len(note) and fails a check
# that is not really failing.
ENCRYPTION_KEY=<run: openssl rand -hex 16>

# API_TOKEN: NOT just a server-to-server convenience. Presented as
# `Authorization: Bearer`, it authenticates as DEFAULT_USER_ID on every /api/*
# route (auth/middleware.ts) — a full console-equivalent credential. Treat it
# like a root password; enrollment and /health do not use it.
API_TOKEN=<run: openssl rand -hex 24>

# ── Browser origins and the session cookie ────────────────────────────────────
# REQUIRED on any domain other than agentpod.dev. The built-in origin allowlist
# is only http://localhost:5173, https://console.agentpod.dev and
# https://app.agentpod.dev (config.ts); ALLOWED_ORIGINS ADDS to it. Without
# your console's origin here, every mutating /api/* request is rejected by the
# CSRF middleware and the terminal WebSocket fails its CSWSH check — the
# console loads and cannot log in.
ALLOWED_ORIGINS=https://console.<your-domain>

# Session cookie attributes (config.ts: sessionCookieOptions). Unset, the
# cookie is host-only and not Secure, which is right for http://localhost and
# wrong for a TLS deployment — and the smoke test in §9 cannot pass.
COOKIE_DOMAIN=.<your-domain>
COOKIE_SECURE=true

# ── Provisioning ──────────────────────────────────────────────────────────────
# Enable the Docker provisioner.
ENABLE_DOCKER_PROVISIONING=true

# Docker image tags built in step 3.
NODE_AGENT_IMAGE=agentpod-node:local
NODE_AGENT_OPENCODE_IMAGE=agentpod-node-opencode:local

# Which Docker daemon the hub provisions on. UNSET = /var/run/docker.sock on
# this box, which is what every deployment has always done — and which means
# every agent container shares this machine's CPU, RAM and kernel with the hub.
# Setting it moves the workloads off the control plane; read "Remote Docker
# daemon" below FIRST, because it also gives this hub a root-equivalent
# credential for another machine.
# DOCKER_HOST=tcp://docker-host.internal:2376
# DOCKER_CERT_PATH=/etc/agentpod/docker-certs   # ca.pem, cert.pem, key.pem
# Non-default socket path (rootless Docker, a socket proxy). Mutually exclusive
# with DOCKER_HOST — setting both is refused at boot.
# DOCKER_SOCKET=/run/user/1000/docker.sock

# Hub URL reachable from inside provisioned containers (used for auto-enrollment).
# Must be the container-reachable public URL of the hub, not 127.0.0.1.
PROVISIONING_HUB_URL=https://hub.<your-domain>

# Cloudflare provisioner: leave off unless you have a verified CF Sandbox setup.
# ENABLE_CLOUDFLARE_SANDBOXES=false
# If you turn it on, these are required alongside it — see cloudflare/worker-v2/README.md.
# The hub refuses to boot with ENABLE_CLOUDFLARE_SANDBOXES=true and no CLOUDFLARE_SANDBOX_IMAGE.
# CLOUDFLARE_WORKER_URL=https://<worker-url>
# CLOUDFLARE_WORKER_TOKEN=<the AGENTPOD_WORKER_TOKEN secret set on the worker>
# CLOUDFLARE_SANDBOX_IMAGE=agentpod-node-opencode:local
# RUNTIME_CALLBACK_TOKEN=<shared secret for the sleep callback>
# CLOUDFLARE_INSTANCE_TIER=large

# Modal provisioner: leave off unless you have read the cost note in OPERATING.md.
# Modal bills wall-clock at roughly 3x standard Modal rates for as long as a
# sandbox exists, which makes a mostly-idle station its worst case.
# ENABLE_MODAL_PROVISIONING=false
# The hub refuses to boot with ENABLE_MODAL_PROVISIONING=true and any of
# MODAL_TOKEN_ID / MODAL_TOKEN_SECRET / PROVISIONING_HUB_URL / the THREE image
# variables below missing. The refusal names the variable.
# MODAL_TOKEN_ID=<from the Modal dashboard>
# MODAL_TOKEN_SECRET=<from the Modal dashboard>
# PUBLIC registry images Modal can pull: linux/amd64, carrying python and pip.
# One per harness the console offers, because the console offers all three for
# every provider — a missing one is a 502 the first time somebody picks it.
# Built by .github/workflows/publish-images.yml from Dockerfile.modal,
# Dockerfile.modal.opencode and Dockerfile.modal.pi.
# NODE_AGENT_MODAL_IMAGE=ghcr.io/<owner>/agentpod-node-modal:<release>
# NODE_AGENT_MODAL_OPENCODE_IMAGE=ghcr.io/<owner>/agentpod-node-modal-opencode:<release>
# NODE_AGENT_MODAL_PI_IMAGE=ghcr.io/<owner>/agentpod-node-modal-pi:<release>
# Modal App the sandboxes are grouped under. Grouping only; carries no state.
# MODAL_APP_NAME=agentpod
# Shortens the lifetime ceiling for a rotation drill. Optional, clamped to 24h,
# and not validated at boot — see "Modal provisioner" in docs/OPERATING.md
# before setting it.
# MODAL_MAX_LIFETIME_MS=86400000

# Fly Machines provisioner: leave off unless you have a Fly account with a
# payment method. Fly's free tier is gone, and a Fly runtime keeps billing for
# its volume while it is stopped — see docs/OPERATING.md for the shape of the
# bill before you turn this on.
# The hub REFUSES TO BOOT with ENABLE_FLY_PROVISIONING=true and no FLY_API_TOKEN.
# ENABLE_FLY_PROVISIONING=false
# Org-scoped, and the BARE macaroon: flyctl prints a "FlyV1 " prefix that must
# be stripped. See "Fly Machines settings" below — this one has a trap.
# FLY_API_TOKEN=<flyctl tokens create org <org> --expiry 720h | sed 's/^FlyV1 //'>
# FLY_ORG_SLUG=personal
# FLY_REGION=sin
# FLY_APP_PREFIX=agentpod
# FLY_VOLUME_SIZE_GB=3
# Fly pulls from a registry, so the local Docker tags above are meaningless to
# it. Provider-scoped names win over the un-scoped ones, which lets one hub run
# Docker and Fly on different images. See "Fly Machines settings" below.
# A harness with no registry image here is REPORTED at boot (⚠️ naming the
# variable) rather than refused, because no generic Fly image is published —
# a hub that serves only OpenCode and Pi on Fly is a working hub.
# NODE_AGENT_FLY_IMAGE=<no image published yet: a Generic Fly runtime cannot work>
# NODE_AGENT_FLY_OPENCODE_IMAGE=ghcr.io/<owner>/agentpod-node-opencode-fly:<release>
# NODE_AGENT_FLY_PI_IMAGE=ghcr.io/<owner>/agentpod-node-pi-fly:<release>

# ── kaambaan bridge ───────────────────────────────────────────────────────────
# See "kaambaan bridge" below before enabling. OFF unless this is the literal
# lowercase string "true" — `1` and `TRUE` read as off.
# ENABLE_KAAMBAAN_BRIDGE=false
# KAAMBAAN_BASE_URL=https://kaambaan.dev
# KAAMBAAN_BRIDGE_AGENTS=[{"key":"codex-mac","boardId":"brd_...","token":"kbn_...","stationId":"station_...","hubUserId":"...","mode":"full-auto"}]
EOF
chmod 600 /etc/agentpod/hub.env
```

> **Key constraints**
> - `ALLOWED_ORIGINS`, `COOKIE_DOMAIN`, `COOKIE_SECURE`: required on any domain that is not `agentpod.dev`. The built-in origin allowlist covers only `localhost:5173`, `console.agentpod.dev` and `app.agentpod.dev`; `ALLOWED_ORIGINS` **adds** to that list rather than replacing it. Skip them and the console loads, then fails every mutating request.
> - `BETTER_AUTH_SECRET`: ≥ 32 characters **and** at least two character classes when `NODE_ENV=production`.
> - `ENCRYPTION_KEY`: **exactly** 32 bytes. Using `openssl rand -hex 16` produces 32 hex characters = 32 ASCII bytes.
> - `CLOUDFLARE_SANDBOX_IMAGE`: required whenever `ENABLE_CLOUDFLARE_SANDBOXES=true`, and it must be the image the worker was deployed with (what `imageForHarness` returns for the harness you provision). The Cloudflare driver advertises a **fixed** image and refuses a spec asking for a different one — but only when it knows this value. Unset, it advertises "fixed" and provisions whatever it is handed. Boot validation now fails instead.
> - Modal: `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `NODE_AGENT_MODAL_IMAGE`, `NODE_AGENT_MODAL_OPENCODE_IMAGE`, `NODE_AGENT_MODAL_PI_IMAGE` and `PROVISIONING_HUB_URL` are **all** required whenever `ENABLE_MODAL_PROVISIONING=true`, and the hub exits at startup without them, naming each one. That is deliberate: most of them would otherwise fail silently, later, on somebody else's runtime.
> - `NODE_AGENT_MODAL_IMAGE` must be a **public registry** reference. The driver pulls it with `images.fromRegistry(tag)` and no Modal Secret, so a private repository cannot be authenticated to and a local Docker tag like `agentpod-node:local` gives Modal nothing to pull. Boot validation rejects any value without a registry host in it; a private-but-well-formed tag passes validation and then fails at provision time.
> - `NODE_AGENT_MODAL_IMAGE` covers the **Generic** harness only. A Modal runtime created with the OpenCode or Pi harness resolves `NODE_AGENT_MODAL_OPENCODE_IMAGE` / `NODE_AGENT_MODAL_PI_IMAGE` first, then the un-scoped `NODE_AGENT_OPENCODE_IMAGE` / `NODE_AGENT_PI_IMAGE`, then the local Docker default. **Boot validation now checks all three** (issue #283): the console offers every harness for every provider, so a Modal hub that can only serve Generic is a hub advertising two runtimes it cannot create. Whatever the resolved image is — provider-scoped variable, un-scoped variable, or default — it must contain a registry host, or the hub exits naming the variable that would fix it. Pointing the un-scoped `NODE_AGENT_OPENCODE_IMAGE` at a registry reference satisfies both Docker and Modal and is a legitimate way to answer it.
> - `PROVISIONING_HUB_URL` is required for Modal (not merely recommended, as it is for Docker) because Modal destroys every sandbox at 24 hours and the hub re-creates them on a timer, with no incoming request to take an origin from. It must be reachable **from inside a Modal sandbox** — a public URL or a tunnel, never `localhost`.
> - On Modal's Starter plan an API token is **workspace-wide**; scoping a token per environment requires Modal's Team plan (~$250/month). Use a Modal workspace dedicated to AgentPod.
> - Never commit this file to source control.

### Remote Docker daemon

Optional, and off by default: with none of these variables set the hub uses
`/var/run/docker.sock` on its own box, exactly as it always has. Nothing in this
section applies to a hub that leaves them unset.

**What it is for.** Every Docker runtime the hub provisions currently runs on
the hub's own machine — agent workloads sharing CPU, memory and a kernel with
the control plane that manages them. `DOCKER_HOST` moves them to another
machine, which is the cheapest way to get that separation without adopting a
new substrate.

> **What this costs, before the how.** The hub's strongest security property is
> that it holds **no credentials** and can reach **nothing that is not already
> dialling it** — node-agents connect outward over WSS and the hub connects
> nowhere. A remote Docker daemon inverts that for one host. **A Docker socket is
> root on the machine that owns it**: anyone who can talk to it can start a
> privileged container and bind-mount `/`. So a hub configured this way holds a
> **root-equivalent credential for the daemon's host**, in `/etc/agentpod/hub.env`
> and `DOCKER_CERT_PATH`. Compromise the hub, and you have that machine. Use a
> host dedicated to running agent containers, not one that does anything else.

**Supported transports — and one that is deliberately not.**

> - `unix:///path/to/docker.sock` — a socket on this machine. No credential, no
>   network. Rootless Docker and socket proxies live here. Equivalent to
>   `DOCKER_SOCKET`; set one or the other, never both (the hub refuses to boot on
>   both, because they are two answers to "where is the daemon" and picking one
>   silently is how containers end up on a machine nobody is looking at).
> - `tcp://host:2376` **with `DOCKER_CERT_PATH`** — mutual TLS. `DOCKER_CERT_PATH`
>   is a directory holding `ca.pem`, `cert.pem` and `key.pem`, the same layout the
>   `docker` CLI uses; generate them with
>   [Docker's own instructions](https://docs.docker.com/engine/security/protect-access/),
>   and keep `key.pem` mode `600` owned by the hub's user. The credential is scoped
>   to that daemon's API and is revoked by reissuing the daemon's CA.
> - `tcp://host:2375` **without TLS** — refused unless the host is loopback. Port
>   2375 is an *unauthenticated* root API; there is no failure to notice, because
>   everything works right up until somebody else finds it. If the link is already
>   encrypted and access-controlled (a WireGuard address, an `ssh -L` tunnel to a
>   loopback port), set `DOCKER_ALLOW_INSECURE_TCP=true` to say so explicitly. The
>   hub then warns on every boot, by design.
> - `ssh://user@host` — **not implemented, on purpose.** dockerode can do it, but
>   it would mean the hub holding an SSH private key or a forwarded agent socket:
>   a shell on the target, usable for everything on it, where a Docker client
>   certificate reaches the daemon API and nothing else. Run the tunnel yourself
>   and point `DOCKER_HOST` at the local end of it.

**What changes once the daemon is somebody else's machine.** These are not
theoretical; each one is an assumption the local-socket setup was quietly making.

> - **Images. The hub never pulls.** It creates containers from images the daemon
>   already holds, which is invisible locally because step 3 of this guide builds
>   them on the hub box. On a remote daemon, **step 3 has to happen on that host**
>   — `agentpod-node:local` is a tag in one daemon's store and nothing in
>   another's. Either build the same tags there, or point
>   `NODE_AGENT_DOCKER_IMAGE` / `NODE_AGENT_DOCKER_OPENCODE_IMAGE` /
>   `NODE_AGENT_DOCKER_PI_IMAGE` at registry references **and `docker pull` them on
>   that host**. The hub reports (`⚠️ WARNING`, naming the variable) at boot when
>   a remote daemon is configured and a harness still resolves to a bare local tag;
>   it is a report rather than a refusal because a tag you built on the remote host
>   is perfectly valid and the hub cannot tell from here. A container that gets
>   this wrong fails at create with `No such image`, and the hub rewrites that
>   error to name the daemon.
> - **The hub URL.** Containers on the remote host dial `PROVISIONING_HUB_URL` to
>   enrol. It must be reachable **from that machine** — a Docker-network name or a
>   `127.0.0.1` address that worked when the container was a neighbour will not
>   resolve from another box.
> - **`DOCKER_NETWORK` and `DOCKER_RUNTIME` name things on the daemon's host.** The
>   hub creates `agentpod-net` on the remote daemon, and `DOCKER_RUNTIME=runsc`
>   requires gVisor installed *there* — `runsc` on the hub box says nothing about
>   it. The #243 guard still applies unchanged: a sandboxed runtime needs a
>   built-in network (`DOCKER_NETWORK=bridge`), whichever daemon it runs on.
> - **`HOST_PATH_PREFIX` and bind mounts** resolve on the daemon's filesystem, not
>   the hub's. The runtime driver mounts nothing today, so nothing breaks now —
>   but any future volume is a path on the other machine.
> - **The hub box no longer needs a Docker socket at all** once every runtime is
>   remote, which is worth taking: it is one fewer root-equivalent handle on the
>   control plane.

**Failure modes the hub refuses to boot on** (each names the variable):
`DOCKER_HOST` in a form it does not implement, a remote `tcp://` with no TLS
material and no explicit opt-out, a `DOCKER_CERT_PATH` it cannot read all three
files from, `DOCKER_CERT_PATH` set with no `DOCKER_HOST` (the certificates would
sit unused while the hub quietly kept using the local socket), and `DOCKER_HOST`
alongside a non-default `DOCKER_SOCKET`. All of them are conditional on
`ENABLE_DOCKER_PROVISIONING=true`, like every other substrate's rules.

### Fly Machines settings

Only relevant with `ENABLE_FLY_PROVISIONING=true`; a hub that never talks to Fly
is not stopped from booting by any of them. Operating a Fly runtime — what it
costs, how to cross-check it with `flyctl` — is in
[docs/OPERATING.md](./OPERATING.md#fly-machines-provisioner).

If you have not used Fly before: install `flyctl` on your **workstation**
(`brew install flyctl`, or `curl -L https://fly.io/install.sh | sh`), run
`flyctl auth login`, and add a payment method to the organisation. `flyctl` is
how you mint the token below and how you audit what is running; the hub itself
never shells out to it — it talks to `https://api.machines.dev` directly, so the
hub box needs no `flyctl` install and no Fly login.

> - `FLY_API_TOKEN`: **required** whenever `ENABLE_FLY_PROVISIONING=true`. The hub refuses to boot without it — `❌ CONFIGURATION VALIDATION FAILED` naming `FLY_API_TOKEN` — rather than accepting the flag and failing on a user's first provision. The token must be **org-scoped**: `flyctl tokens create org <org> --name agentpod --expiry 720h`. Fly's app-scoped deploy tokens can do everything except *create* an app, and this driver creates one app per runtime. Pass `--expiry` explicitly; Fly defaults it to twenty years.
> - **The token trap — measured 2026-08-13.** `flyctl tokens create org` prints the macaroon **already prefixed with `FlyV1 `**. `FLY_API_TOKEN` should hold the **bare macaroon, with that prefix stripped**. Pasting the flyctl output verbatim produces the literal header `Authorization: Bearer FlyV1 <macaroon>` — which Fly was measured to accept (200) on that date, so a doubled prefix does not fail visibly today and will sit in your env file being quietly load-bearing until the day Fly stops tolerating it. Strip it: `flyctl tokens create org personal --expiry 720h | sed 's/^FlyV1 //'`.
> - **Auth scheme — measured 2026-08-13.** The driver sends `Authorization: Bearer <token>`. Fly's own documentation gives both `Bearer` and `FlyV1`, on different pages, with no indication that either is deprecated, so it was settled by probing `GET https://api.machines.dev/v1/apps?org_slug=personal`: `Bearer` → 200, `FlyV1` → 200, **no** `Authorization` header → 401, `Bearer garbage` → 401. Both schemes work; the two 401 controls are what rule out an endpoint that ignores auth altogether. `Bearer` is the one in `fly-api.ts`, because it is the standard scheme and needs no explanation to any HTTP tool.
> - `FLY_REGION` (default `sin`): **measured 2026-08-12 on a real account** — `bom` is refused with `region ... is not available to legacy or non-paid plan accounts`, and `sin` is accepted, on the same account with the same token. The plan an organisation is on, not the token, decides which regions it may use. The driver rewrites that refusal into a sentence naming `FLY_REGION` and suggesting `sin`, so it does not read as a Fly outage.
> - `FLY_VOLUME_SIZE_GB` (default `3`): the size of the volume each runtime gets. **The workspace lives on this volume**, because the Fly rootfs is wiped on every stop→start (measured 2026-08-12). Minimum 1; the hub refuses to boot below that. A **blank** value (`FLY_VOLUME_SIZE_GB=`) means the default, exactly as leaving the line out does — an unfilled variable is not a configured one. Anything else that is not a whole number — `3.5`, `12gb`, `three` — is an error: the hub throws `Invalid integer for environment variable: FLY_VOLUME_SIZE_GB` at startup rather than truncating it, and it does that whether or not Fly is enabled, because config is parsed before anything knows which substrates you use. Fly sizes volumes in whole gigabytes.
> - `FLY_ORG_SLUG` (default `personal`) and `FLY_APP_PREFIX` (default `agentpod`): the organisation apps are created in, and the app-name prefix. A runtime `rt_3f2a…` becomes the Fly app `agentpod-rt-3f2a…` — that prefix is what makes `flyctl apps list` legible and what the cost audit in OPERATING greps for, so change it only if you must.
> - **The Fly image must be registry-qualified** — e.g. `ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:<release>`. Fly pulls from a registry, so the default bare tag `agentpod-node-opencode:local` exists only on your Docker host and the machine create fails on the pull. `imageForHarness()` resolves it provider-first: `NODE_AGENT_FLY_OPENCODE_IMAGE`, then the un-scoped `NODE_AGENT_OPENCODE_IMAGE`, then the local default. Setting the **provider-scoped** name is the safe choice on a hub that also runs Docker, because it leaves the Docker tag alone. Setting the un-scoped `NODE_AGENT_OPENCODE_IMAGE` also works — a registry-qualified tag is fine for Docker too, since the daemon pulls it — and is what lets one variable serve both providers.
> - **Which Fly images exist.** `agentpod-node-opencode-fly` (`fly/node-image/Dockerfile`) and `agentpod-node-pi-fly` (`fly/node-image/Dockerfile.pi`) — OpenCode and Pi. There is **no generic (harness-less) Fly image**, so a Fly runtime created with the **Generic** harness cannot work; the hub says so at boot with a `⚠️ WARNING` naming `NODE_AGENT_FLY_IMAGE`, and reports the same for any other harness whose resolved image is a local Docker tag. It is a report rather than a refusal precisely because of that gap: a fatal rule would make `ENABLE_FLY_PROVISIONING=true` unbootable no matter what you set, taking down a substrate that serves OpenCode and Pi perfectly well.
> - **The images are published by CI, not by hand:** `.github/workflows/publish-images.yml` (manual dispatch — pick the image and the tag). It builds `linux/amd64` on an amd64 runner and then verifies the image it pushed: the `agentpod-node` binary runs, and the harness binary is resolvable from a *minimal service PATH*. Building by hand still works (`fly/node-image/README.md` has the `docker buildx … --push` line) and the same two things will not let you skip them: `--platform linux/amd64` (Fly Machines are amd64; an arm64 image built on an Apple laptop dies at boot with `exec format error`) and making the registry package **public** (Fly pulls anonymously). The tag in `NODE_AGENT_FLY_OPENCODE_IMAGE` / `NODE_AGENT_FLY_PI_IMAGE` is the record of which build the fleet is running.

### Who may dispatch which agent — the control pair

The first real authorization check in this suite. Two switches and a table.

**Grants live in the database**, in `principal_grants`, and the hub puts them
into every token it issues as the `mayDispatch` / `mayGrantReach` claims. They
are no longer environment configuration: `CONTROL_PAIR_GRANTS` was the interim
and is **no longer read**. A deployment still carrying it gets a boot warning,
because somebody believing grants live in the environment is an authorization
gap.

**Enforcement is off until you turn it on:**

```sh
ENFORCE_CONTROL_PAIR=true      # literal lowercase "true"; anything else is off
```

Off is the default and the hub says so at boot:

```
⚠️  WARNING: ENFORCE_CONTROL_PAIR is not "true" — any principal may dispatch any agent.
```

An explicit switch rather than "are there any grants", because those two differ
in exactly the dangerous case: a deployment that *meant* to enforce and whose
grants failed to load would silently enforce nothing.

**Populate grants before switching it on.** With enforcement on and no grants,
every dispatch is refused — which is correct, and is also an outage.

| Field | Meaning |
|---|---|
| `mayDispatch` | Namespaced patterns. AgentPod's name a **node and a station**: `agentpod:<nodeName>/<stationKey>`. `kaambaan:<agentId>` is matched by kaambaan and **ignored** here. |
| `mayGrantReach` | Whether this principal may **change what an agent is**. Required, and enforced — see the table below. Dispatch control alone is decorative: anyone who can grant an agent production credentials does not need permission to dispatch it. |

**What `mayGrantReach` gates**, as of #345. `mayDispatch` asks whether you may
ask an agent to work; this asks whether you may rewrite it:

| Act | Guarded |
|---|---|
| `fs/write`, `fs/mkdir`, `fs/move`, `fs/delete` | **yes** — one request writes a credential file |
| Terminal attach | **yes** — arbitrary shell as the agent's user |
| `cleanup/apply` | **yes** — deletes workspace files (`cleanup/plan` is a read, and is not) |
| `POST /api/enrollment-tokens` | **yes**, and additionally requires a fleet-wide (`agentpod:*/…`) dispatch value |
| `changeset/status`, `changeset/diff`, `lifecycle`, every read | no |

A station-scoped act needs `mayGrantReach` **and** a `mayDispatch` value matching
that station — one scope, shared with dispatch, so narrowing what someone may
dispatch narrows what they may rewrite. Growing the fleet names no station, so it
asks the narrower question instead: your authority must already span the fleet.

Refusals are `403` on HTTP and a `1008` close on the terminal socket, and each is
written to the station's activity trail as well as the hub log — an attempt
refused and recorded nowhere is indistinguishable from an attempt nobody made.

**If you lock yourself out**, `/api/admin/grants` is guarded by *admin*, not by
the control pair: an admin can always restore their own grant from **Admin →
Grants**. The control cannot lock you out of the control.

```sh
agentpod:molt-bot/hermes:analyst-echo   # exactly one agent, on one host
agentpod:molt-bot/hermes:*              # every Hermes agent on molt-bot
agentpod:*/hermes:*                     # every Hermes agent, anywhere
```

**Why a node, not just a station.** Station keys are **not unique across the
fleet** — uniqueness is `(node, key)`, and `opencode:c52ddf65` exists on two
nodes right now. A grant naming only the key would let a permission written for
a staging box silently cover production. Node **names** are unique within a
tenant by construction: enrolment suffixes a hostname collision (`molt-bot`,
`molt-bot-2`) and a unique index enforces it.

**Two retired forms are refused when written**: an unprefixed `hermes:*` (the
old `CONTROL_PAIR_GRANTS` format) and a two-part `agentpod:hermes:*`, which
cannot say which node it meant. Both used to store happily and match nothing,
which reads exactly like a working grant — the writer now answers `400` instead,
while a *reader* still ignores anything it does not recognise. `[]` denies — it
is what you write to suspend someone without deleting their grant.

**Manage them in the console: Admin → Grants.** It lists every principal with
their values, marks grants whose principal is no longer a user here, and — read
this before trusting a narrow grant — says at the top whether
`ENFORCE_CONTROL_PAIR` is actually on. With it off the page is a plan, not a
control. `GET|PUT|DELETE /api/admin/grants[/:principalId]` is the same surface
for scripts; `PUT` replaces the whole grant rather than merging, so narrowing is
never harder than widening.

Why values are namespaced, and where that ends:
`charter` → `decisions/2026-08-15-a-grant-names-an-agent-per-plane.md`.

Enforced at `acp.createSession`, the one choke point both the console and the
kaambaan bridge pass through — a check living only in the bridge would leave
provisioning straight at this API unguarded.

### kaambaan bridge

Off by default, and **nothing is inferred from a credential being present** — a `kbn_` token
sitting in an env file is not a decision to start claiming work on someone's board. A hub
that has not opted in constructs nothing, opens no session and makes no request. Day-2
operation — reading the ledger, spotting a halted loop — is
[docs/OPERATING.md → The kaambaan bridge](./OPERATING.md#8-the-kaambaan-bridge).

Three variables, all required together:

| Variable | Meaning |
|---|---|
| `ENABLE_KAAMBAAN_BRIDGE` | The gate. `isBridgeEnabled()` compares against the **literal lowercase `true`** — `1`, `TRUE` and `yes` are off. Boot validation uses the looser `getEnvBool`, so `=1` is the one value that passes validation *and* starts nothing. |
| `KAAMBAAN_BASE_URL` | Origin of the kaambaan deployment, e.g. `https://kaambaan.dev`. Trailing slashes are stripped. |
| `KAAMBAAN_BRIDGE_AGENTS` | The roster: a **JSON array**, one entry per agent identity. |

One process, many identities. Each roster entry is a separate principal with its own token,
board and station — "the bridge's credential" is not a thing that exists:

```json
[
  {
    "key": "codex-mac",
    "boardId": "brd_9c1d4e5f6a7b8c9d",
    "token": "kbn_…",
    "stationId": "station_4a1482de-9c3f-4b17-8a55-0d6e2f7c1b90",
    "hubUserId": "usr-local-1",
    "mode": "full-auto",
    "permissionWaitMs": 1800000,
    "maxConcurrency": 1,
    "profileKey": "reviewer"
  }
]
```

| Field | Required | Notes |
|---|---|---|
| `key` | yes | Stable name. Lands in `bridge_dispatches.agent_key` and every log line, so it must be unique — a duplicate is refused at boot. |
| `boardId` | yes | The kaambaan board to claim from. |
| `token` | yes | This agent's own kaambaan credential, minted under "Connect an agent". Must start `kbn_`. |
| `stationId` | yes | The station its work runs on. |
| `hubUserId` | yes | The hub user the ACP session belongs to. Sessions are authorized by user id, so a background worker needs a real owning principal — it cannot invent one. |
| `mode` | no (default `full-auto`) | `full-auto` never asks a human. `accept-edits` — the supervised setting — auto-approves file writes and **asks about anything that executes**. `ask` asks about every tool call, which is a great deal of asking; it suits a board somebody is watching, which is why it is not the default. Anything `accept-edits` or `ask` asks about parks the card in `input-required` until a person answers — see `permissionWaitMs`. |
| `permissionWaitMs` | no (default **30 minutes**) | How long a human has to answer before the run gives up. Must be a positive integer. |
| `maxConcurrency` | no | How many of this agent's runs may be in flight. kaambaan defaults to 1. |
| `profileKey` | no | Claim under a profile, when the board routes by profile. |

**What `permissionWaitMs` actually buys you.** When an agent asks for permission, the run keeps
the card and keeps heartbeating, so kaambaan's 15-minute reclaim never fires — the wait is
bounded by *this setting*, not by the lease. If it expires, the run is **`fail`ed and the card is
re-queued** with the reason and a failure count. It is not silently dropped, and it is not
`release`d either: a session had started, so the workspace may hold partial work, and `fail` is
the verb that records that. The next attempt asks the question again, and a card nobody ever
answers eventually trips kaambaan's own circuit breaker and parks for a human. Nothing is ever
approved or declined on a human's behalf when the wait runs out.

Set it per agent, because attendance is a property of a deployment: a board watched during
office hours wants minutes, and one that runs unattended overnight wants the harness released
quickly rather than a station pinned until morning.

**A roster that fails to parse refuses the boot**, naming `KAAMBAAN_BRIDGE_AGENTS`. That is
deliberate: a bridge that silently claimed nothing because its roster was malformed looks
exactly like a quiet board. The refusals are a missing base URL, unparseable JSON, an empty
array, a token that does not start `kbn_`, a `permissionWaitMs` of zero or less, and a
duplicate `key`.

> **Quoting.** The roster is JSON on one line, which makes it the value most likely to be
> quoted in an env file, and the value quoting most often breaks. systemd's
> `EnvironmentFile=` strips one surrounding layer, so both `KAAMBAAN_BRIDGE_AGENTS=[{…}]`
> and `KAAMBAAN_BRIDGE_AGENTS='[{…}]'` reach the hub identically — but a pre-flight that
> parses the file differently will disagree with the hub about which one works. See the
> pre-flight notes under [Re-deploy](#re-deploy-upgrade); this variable is why they exist.

---

## 5. Hub — build + deploy

```bash
cd /opt/agentpod
git fetch origin main && git checkout main && git merge --ff-only FETCH_HEAD
pnpm install --frozen-lockfile
```

> Production deploys from **`main`**. Note: on a checkout whose fetch refspec
> does not update `origin/main`, a plain `git pull` can under-shoot — the
> `merge --ff-only FETCH_HEAD` form above is reliable either way.

Install the systemd unit (already in the repo):

```bash
cp /opt/agentpod/deploy/agentpod-hub.service /etc/systemd/system/
# Verify ExecStart bun path: `which bun` (default /root/.bun/bin/bun)
# Edit if different: ExecStart=/usr/local/bin/bun run src/index.ts
systemctl daemon-reload
systemctl enable --now agentpod-hub
```

> **The unit hardcodes `agentpod.dev`.** Three `Environment=` lines in the shipped file name
> that domain — `COOKIE_DOMAIN=.agentpod.dev`, `ALLOWED_ORIGINS=https://app.agentpod.dev`,
> and `PUBLIC_URL=https://hub.agentpod.dev`. On any other domain, **edit them** (or delete
> them and keep the values in `hub.env`, which the same unit loads via `EnvironmentFile=`).
> Note `PUBLIC_URL` is read by nothing in the hub — the config field is
> `MANAGEMENT_API_PUBLIC_URL` — so it is inert either way.
>
> **The unit's comment says the hub is "bound to 127.0.0.1:3001". It is not.** `src/index.ts`
> exports `{port, fetch, websocket}` with no `hostname`, so Bun binds `0.0.0.0` and
> `http://<VPS-IP>:3001` serves the API without TLS alongside nginx. Firewall the port:
>
> ```bash
> ufw allow 22/tcp && ufw allow 80,443/tcp && ufw deny 3001/tcp && ufw enable
> curl -s --max-time 5 http://<VPS-IP>:3001/health   # expect a timeout, not {"status":"ok"}
> ```

The hub auto-runs Drizzle migrations on startup. Watch the log:

```bash
systemctl status agentpod-hub --no-pager
journalctl -u agentpod-hub -n 50 --no-pager
# Expected: "migrations completed" and "Provisioners registered: docker..."
```

Health check:

```bash
curl -s http://127.0.0.1:3001/health
# {"status":"ok",...}
```

> If you need to run migrations manually: `cd /opt/agentpod/apps/hub && bun run db:migrate`

### Optional: gVisor isolation for provisioned runtimes

Provisioned runtimes run on the hub box and execute agent-generated code. Under
Docker's default `runc` they share the host kernel, so a container escape is a
hub compromise. gVisor (`runsc`) gives each container its own userspace kernel.

It needs **no nested virtualisation and no bare metal** — Linux 4.14.77+ is the
only requirement, so it works on an ordinary cloud VM.

```bash
ARCH=$(uname -m)
URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
curl -fsSL -o runsc "${URL}/runsc" -o runsc.sha512 "${URL}/runsc.sha512" \
     -o containerd-shim-runsc-v1 "${URL}/containerd-shim-runsc-v1" \
     -o containerd-shim-runsc-v1.sha512 "${URL}/containerd-shim-runsc-v1.sha512"
sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
chmod a+rx runsc containerd-shim-runsc-v1
sudo mv runsc containerd-shim-runsc-v1 /usr/local/bin/
sudo /usr/local/bin/runsc install
sudo systemctl reload docker      # reload, NOT restart — running containers keep running
```

Verify Docker sees it, then enable it for newly provisioned runtimes:

```bash
docker info --format '{{range $k,$v := .Runtimes}}{{$k}} {{end}}'   # expect runsc listed
printf 'DOCKER_RUNTIME=runsc\nDOCKER_NETWORK=bridge\n' >> /etc/agentpod/hub.env
systemctl restart agentpod-hub
```

> **`DOCKER_NETWORK=bridge` is required, not optional** ([#243](https://github.com/rakeshgangwar/agentpod/issues/243)).
> Every user-defined Docker network injects `nameserver 127.0.0.11` and runs an
> embedded DNS proxy on that loopback address inside the container. A sandboxed
> runtime cannot reach it, so the container never resolves the hub and never
> enrols — while ICMP, TCP and UDP to real addresses all work, which makes it
> read as "DNS randomly broke". `--dns` does **not** help: it only changes what
> the embedded proxy forwards upstream.
>
> The hub refuses this combination rather than provisioning a runtime that would
> restart-loop forever, so a misconfiguration fails at provision time with an
> error naming the fix.

Existing runtimes keep whatever they were created with; this affects new ones.
The console's **Isolation** column shows each runtime's actual runtime, read back
from Docker rather than from config, so you can confirm rather than assume.

**If `runsc` is not installed and `DOCKER_RUNTIME=runsc` is set, provisioning
fails loudly.** It never falls back to `runc` — a silent fallback would leave you
believing you had kernel isolation when you had none.

Verified on the reference box (Ubuntu 24.04, kernel 6.8, Docker 29.6.1): the
node-agent enrols, heartbeats, allocates PTYs for the terminal capability, and
runs ACP stdio children under `runsc` identically to `runc`. Verified end to end
on 2026-08-12 by provisioning through `createRuntime`: the runtime came back
`status=online runtime=runsc` with its node heartbeating. Expect 5–20% CPU
overhead depending on syscall frequency.

---

## 6. Console — build + deploy to Cloudflare Pages

Build the static SPA (build locally — the VPS does not need to run this step):

```bash
cd /path/to/agentpod   # local checkout
PUBLIC_HUB_URL=https://hub.<your-domain> pnpm --filter @agentpod/console build
# Output: apps/console/build/
```

**Deploy to Cloudflare Pages** (choose one method):

- **Git integration (recommended):** Create a Pages project in the Cloudflare dashboard → connect your repo → set monorepo build settings:
  - Root directory: `apps/console`
  - Build command: `pnpm build`
  - Build output directory: `build`
  - Environment variable: `PUBLIC_HUB_URL=https://hub.<your-domain>`

- **Direct upload (Wrangler):**
  ```bash
  wrangler pages deploy apps/console/build --project-name agentpod-console
  ```

**SPA fallback:** adapter-static requires a catch-all redirect so client-side routing works. `apps/console/static/_redirects` is already committed with exactly this — confirm it is there rather than adding it:
```
/* /index.html 200
```
Cloudflare Pages picks this up automatically. Alternatively, enable the "SPA" setting in the Pages project dashboard.

**Custom domain:** In the Pages project → Custom domains, add `console.<your-domain>`. Cloudflare provisions TLS automatically — no certbot needed for the console.

> **Same-site cookie warning:** auth only works via the custom domain `console.<your-domain>`. Opening the raw `*.pages.dev` URL is a **different registrable domain** from `hub.<your-domain>` — the session cookie (`Domain=.<your-domain>; SameSite=Lax; Secure`) will not be sent cross-site and login will silently break. **Always use the custom domain.**

---

## 7. nginx vhosts (hub only)

The console is hosted on Cloudflare Pages and does **not** require an nginx vhost on the VPS. Only the hub vhost is wanted here.

> **The repo's vhost file contains two server blocks, not one.** `deploy/nginx/hub.agentpod.dev.conf`
> carries `hub.agentpod.dev` **and** an `app.agentpod.dev` block serving
> `/opt/agentpod/apps/console/build` from disk — a leftover from the pre-Pages deploy.
> Copying it as-is installs a vhost for a hostname this guide never creates. `nginx -t`
> passes either way (a missing `root` directory is not a config error), so nothing tells you.
> **Delete the second `server { … }` block after copying**, or serve the console from it
> instead of Cloudflare Pages — but pick one.

**7a. WebSocket upgrade map** (add once to the `http{}` context):

```bash
cat > /etc/nginx/conf.d/agentpod-upgrade.conf <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
EOF
```

**7b. Hub vhost** (copy from the repo):

```bash
cp /opt/agentpod/deploy/nginx/hub.agentpod.dev.conf \
   /etc/nginx/sites-available/agentpod-hub
# If your domain is not agentpod.dev, edit the server_name line:
#   server_name hub.<your-domain>;
ln -sf /etc/nginx/sites-available/agentpod-hub \
       /etc/nginx/sites-enabled/agentpod-hub
nginx -t   # MUST pass before reloading
systemctl reload nginx
```

The vhost config (`deploy/nginx/hub.agentpod.dev.conf`) sets:
- `proxy_pass http://127.0.0.1:3001` for the hub, with WS upgrade headers
- `proxy_read_timeout 3600s` / `proxy_send_timeout 3600s` for long-lived streams
- `client_max_body_size 64m` for large file uploads

---

## 8. TLS (certbot)

Certbot covers the **hub only**. Cloudflare provides TLS for the console automatically via the Pages custom domain.

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d hub.<your-domain>
nginx -t && systemctl reload nginx
```

Verify:

```bash
curl -s https://hub.<your-domain>/health      # {"status":"ok",...}
curl -sI https://console.<your-domain>        # 200, console HTML (via Cloudflare Pages)
```

On the co-hosted Matrix box, also confirm: `curl -sI https://id.<your-domain>` should still 200/redirect (Synapse untouched).

---

## 9. Smoke test

1. Open `https://console.<your-domain>` in a browser (the custom domain — not `*.pages.dev`); sign up (first user auto-becomes admin; signup closes immediately after).
2. Confirm the session cookie is `Domain=.<your-domain>; Secure; SameSite=Lax` in DevTools.
3. Navigate to **Settings → Nodes** and generate an enrollment token.
4. Enroll a real host (curl one-liner — see [docs/OPERATING.md](./OPERATING.md) Option A).
5. Check startup log for `"Provisioners registered: docker…"`.

---

## Rollback

```bash
systemctl disable --now agentpod-hub
rm /etc/nginx/sites-enabled/agentpod-hub \
   /etc/nginx/conf.d/agentpod-upgrade.conf
nginx -t && systemctl reload nginx
# Database: sudo -u postgres dropdb agentpod  (only if abandoning entirely)
```

Synapse / `id.agentpod.dev` are never modified, so rollback cannot affect Matrix.

---

## Re-deploy (upgrade)

```bash
cd /opt/agentpod
git fetch origin main -q && git merge --ff-only FETCH_HEAD
# REQUIRED whenever dependencies changed — see below.
export PATH=/root/.bun/bin:$PATH   # bun is here and is NOT on the SSH PATH.
                                   # If pnpm came from corepack it is on Node's
                                   # shim path instead — check `which pnpm` once.
pnpm install --frozen-lockfile
# Restart hub (auto-migrates):
systemctl restart agentpod-hub
systemctl status agentpod-hub --no-pager
curl -s http://127.0.0.1:3001/health
```

**Do not skip `pnpm install`.** The hub runs from source (`bun run src/index.ts`),
so a merge that adds a dependency leaves the previous `node_modules` in place and
the new import fails at runtime, not at deploy. The Modal driver is the first
case: it `require("modal")` lazily, so a Modal-**disabled** hub still boots and
only a hub with `ENABLE_MODAL_PROVISIONING=true` dies at startup — the failure
appears when a flag is flipped, arbitrarily long after the deploy that caused it.

Confirm which drivers actually came up rather than assuming the flags took:

```bash
journalctl -u agentpod-hub -n 80 --no-pager | grep "Provisioners registered"
# e.g. "Provisioners registered: docker, cloudflare, modal, fly"
```

Before enabling a new provider on a live hub, validate its variables **without
restarting anything** — the hub refuses to boot on a config error, so a bad value
turns a restart into an outage:

```bash
cd /opt/agentpod/apps/hub
python3 - <<'PY'
import os, subprocess
env = dict(os.environ)
for line in open("/etc/agentpod/hub.env"):
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    v = v.strip()
    # systemd's EnvironmentFile removes ONE layer of surrounding quotes and
    # nothing else. Match it exactly: no xargs, no comment stripping.
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    env[k.strip()] = v
script = '''
  const { collectConfigErrors } = await import("./src/utils/validate-config.ts");
  console.log(JSON.stringify(collectConfigErrors(undefined, () => {}).map(e => e.field)));
'''
r = subprocess.run(["/root/.bun/bin/bun", "--env-file=/dev/null", "-e", script],
                   env=env, capture_output=True, text=True)
print(r.stdout.strip() or r.stderr.strip()[-500:])
PY
# [] means the hub will boot. Anything else names the variable to fix.
```

Two things about that snippet are load-bearing, and both were learned the hard way:

- **`--env-file=/dev/null`.** Without it bun also loads any `.env` in the working
  directory, so you would validate a different environment than systemd passes.
- **Do not pipe the file through `xargs`.** The obvious form —
  `env $(grep -v '^#' /etc/agentpod/hub.env | xargs) bun …` — was in this runbook
  until 2026-08-14 and is **wrong**: `xargs` re-tokenises and strips quotes wherever
  they appear, so a value containing them arrives mangled. Enabling the kaambaan
  bridge, whose roster is a JSON array, produced `KAAMBAAN_BRIDGE_AGENTS is not
  valid JSON` from a config file that was perfectly valid — a pre-flight failing on
  a fault it invented, which is worse than no pre-flight at all.
- **Strip exactly one layer of surrounding quotes, and nothing else** — that is what
  systemd's `EnvironmentFile=` does. The replacement snippet was, briefly, *fully*
  literal, which recreated the same class of bug from the other side: an operator who
  quoted the roster (`KAAMBAAN_BRIDGE_AGENTS='[{…}]'`) got the quotes handed to
  `JSON.parse` and the same invented failure. Note systemd does **not** strip trailing
  comments — `KEY=value  # note` really is a value with a comment in it, on the live
  hub as well as here, which is why the `ENCRYPTION_KEY` line in §4 keeps its comment
  on a line of its own.

`() => {}` swallows the WARNINGS, and Fly's per-harness image gaps are warnings
(see the Fly notes above). Pass `console.warn` instead of the empty function to
see them — `[]` from the command above means "this hub boots", not "every
harness the console offers can actually be provisioned".

If the console changed: rebuild locally with `PUBLIC_HUB_URL=https://hub.<your-domain> pnpm --filter @agentpod/console build` and redeploy `apps/console/build/` to Cloudflare Pages (Wrangler or push to the connected branch).

Node-agent upgrades: re-run the curl installer on each host (idempotent — it re-installs the binary, re-enrolls, and re-runs `apn service install`):
```bash
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | sudo bash -s -- https://hub.<your-domain> <TOKEN>
```
Or, from a repo checkout: `sudo bash apps/node-agent/scripts/install-node-agent.sh https://hub.<your-domain> <TOKEN>`.

On macOS the same command — piped and all — always installs rootless (regardless of `sudo`, re-execing as the invoking user) and (re)installs a per-user LaunchAgent via `apn service install`. Manage it with the `apn` verbs — `apn status`, `apn logs -f`, `apn restart` — it only runs while the user is logged in; system sleep suspends it and the node shows offline until wake. See [docs/OPERATING.md](./OPERATING.md#1-enroll-a-node) for the full verb list and the raw-launchctl/systemctl fallback.
