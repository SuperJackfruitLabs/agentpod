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
| **pnpm** | Builds the console (`corepack enable && corepack prepare pnpm@latest --activate`) |
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

# ── Auth ──────────────────────────────────────────────────────────────────────
# BETTER_AUTH_SECRET: ≥32 chars, random. Better Auth auto-reads this env var.
BETTER_AUTH_SECRET=<run: openssl rand -hex 32>

# ENCRYPTION_KEY: exactly 32 bytes (AES-256-GCM for stored credentials).
ENCRYPTION_KEY=<run: openssl rand -hex 16>  # 16 hex-pairs = 32 bytes

# API_TOKEN: bearer token for server-to-server calls (enrollment, health probes).
API_TOKEN=<run: openssl rand -hex 24>

# ── Feature flags ─────────────────────────────────────────────────────────────
# Disable MetaMCP integration (not part of fleet console).
METAMCP_ENABLED=false

# Activity archival: set false to disable background archival job (optional).
# ENABLE_ACTIVITY_ARCHIVAL=false

# ── Provisioning ──────────────────────────────────────────────────────────────
# Enable the Docker provisioner.
ENABLE_DOCKER_PROVISIONING=true

# Docker image tags built in step 3.
NODE_AGENT_IMAGE=agentpod-node:local
NODE_AGENT_OPENCODE_IMAGE=agentpod-node-opencode:local

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
# MODAL_TOKEN_ID / MODAL_TOKEN_SECRET / NODE_AGENT_MODAL_IMAGE /
# PROVISIONING_HUB_URL missing. The refusal names the variable.
# MODAL_TOKEN_ID=<from the Modal dashboard>
# MODAL_TOKEN_SECRET=<from the Modal dashboard>
# A PUBLIC registry image Modal can pull: linux/amd64, carrying python and pip.
# Build it with apps/node-agent/deploy/Dockerfile.modal.
# NODE_AGENT_MODAL_IMAGE=ghcr.io/<owner>/agentpod-node-modal:v0.1.0
# Only covers the Generic harness. Set these too if you provision an
# OpenCode or Pi runtime on Modal — otherwise it falls back to the local
# Docker tag and the driver refuses the provision.
# NODE_AGENT_MODAL_OPENCODE_IMAGE=ghcr.io/<owner>/agentpod-node-modal-opencode:v0.1.0
# NODE_AGENT_MODAL_PI_IMAGE=ghcr.io/<owner>/agentpod-node-modal-pi:v0.1.0
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
# NODE_AGENT_FLY_IMAGE=ghcr.io/<owner>/agentpod-node-fly:v0.1.0
# NODE_AGENT_FLY_OPENCODE_IMAGE=ghcr.io/<owner>/agentpod-node-opencode-fly:v0.1.0
EOF
chmod 600 /etc/agentpod/hub.env
```

> **Key constraints**
> - `BETTER_AUTH_SECRET`: ≥ 32 characters.
> - `ENCRYPTION_KEY`: **exactly** 32 bytes. Using `openssl rand -hex 16` produces 32 hex characters = 32 ASCII bytes.
> - `CLOUDFLARE_SANDBOX_IMAGE`: required whenever `ENABLE_CLOUDFLARE_SANDBOXES=true`, and it must be the image the worker was deployed with (what `imageForHarness` returns for the harness you provision). The Cloudflare driver advertises a **fixed** image and refuses a spec asking for a different one — but only when it knows this value. Unset, it advertises "fixed" and provisions whatever it is handed. Boot validation now fails instead.
> - Modal: `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `NODE_AGENT_MODAL_IMAGE` and `PROVISIONING_HUB_URL` are **all** required whenever `ENABLE_MODAL_PROVISIONING=true`, and the hub exits at startup without them, naming each one. That is deliberate: two of the four would otherwise fail silently, later, on somebody else's runtime.
> - `NODE_AGENT_MODAL_IMAGE` must be a **public registry** reference. The driver pulls it with `images.fromRegistry(tag)` and no Modal Secret, so a private repository cannot be authenticated to and a local Docker tag like `agentpod-node:local` gives Modal nothing to pull. Boot validation rejects any value without a registry host in it; a private-but-well-formed tag passes validation and then fails at provision time.
> - `NODE_AGENT_MODAL_IMAGE` covers the **Generic** harness only. A Modal runtime created with the OpenCode or Pi harness resolves `NODE_AGENT_MODAL_OPENCODE_IMAGE` / `NODE_AGENT_MODAL_PI_IMAGE` first, then the un-scoped `NODE_AGENT_OPENCODE_IMAGE` / `NODE_AGENT_PI_IMAGE`, then the local Docker default. Boot validation does not check these, so provision either fails with "not a registry reference Modal can pull", or — worse — silently hands Modal whatever your Docker deployment set.
> - `PROVISIONING_HUB_URL` is required for Modal (not merely recommended, as it is for Docker) because Modal destroys every sandbox at 24 hours and the hub re-creates them on a timer, with no incoming request to take an origin from. It must be reachable **from inside a Modal sandbox** — a public URL or a tunnel, never `localhost`.
> - On Modal's Starter plan an API token is **workspace-wide**; scoping a token per environment requires Modal's Team plan (~$250/month). Use a Modal workspace dedicated to AgentPod.
> - Never commit this file to source control.

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
> - **The Fly image must be registry-qualified** — e.g. `ghcr.io/rakeshgangwar/agentpod-node-opencode-fly:v0.1.22`. Fly pulls from a registry, so the default bare tag `agentpod-node-opencode:local` exists only on your Docker host and the machine create fails on the pull. `imageForHarness()` resolves it provider-first: `NODE_AGENT_FLY_OPENCODE_IMAGE`, then the un-scoped `NODE_AGENT_OPENCODE_IMAGE`, then the local default. Setting the **provider-scoped** name is the safe choice on a hub that also runs Docker, because it leaves the Docker tag alone. Setting the un-scoped `NODE_AGENT_OPENCODE_IMAGE` also works — a registry-qualified tag is fine for Docker too, since the daemon pulls it — and is what lets one variable serve both providers.
> - **The image is built by hand, and there is no CI pipeline for it — by convention, like every other node-agent image in this repo.** `fly/node-image/README.md` has the `docker buildx … --push` line. Two things it will not let you skip: `--platform linux/amd64` (Fly Machines are amd64; an arm64 image built on an Apple laptop dies at boot with `exec format error`) and making the registry package **public** (Fly pulls anonymously). The tag in `NODE_AGENT_FLY_OPENCODE_IMAGE` / `NODE_AGENT_OPENCODE_IMAGE` is the only record of which build the fleet is running.

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

**SPA fallback:** adapter-static requires a catch-all redirect so client-side routing works. Add a `_redirects` file to `apps/console/static/` (committed to the repo):
```
/* /index.html 200
```
Cloudflare Pages picks this up automatically. Alternatively, enable the "SPA" setting in the Pages project dashboard.

**Custom domain:** In the Pages project → Custom domains, add `console.<your-domain>`. Cloudflare provisions TLS automatically — no certbot needed for the console.

> **Same-site cookie warning:** auth only works via the custom domain `console.<your-domain>`. Opening the raw `*.pages.dev` URL is a **different registrable domain** from `hub.<your-domain>` — the session cookie (`Domain=.<your-domain>; SameSite=Lax; Secure`) will not be sent cross-site and login will silently break. **Always use the custom domain.**

---

## 7. nginx vhosts (hub only)

The console is hosted on Cloudflare Pages and does **not** require an nginx vhost on the VPS. Only the hub vhost is configured here.

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
export PATH=/root/.bun/bin:$PATH   # pnpm lives here; it is NOT on the SSH PATH
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
env $(grep -v '^#' /etc/agentpod/hub.env | grep -v '^$' | xargs) \
  /root/.bun/bin/bun --env-file=/dev/null -e '
  const { collectConfigErrors } = await import("./src/utils/validate-config.ts");
  console.log(JSON.stringify(collectConfigErrors(undefined, () => {}).map(e => e.field)));'
# [] means the hub will boot. Anything else names the variable to fix.
# --env-file=/dev/null matters: without it bun would also load any .env in the
# working directory, so you would be validating a different environment than
# systemd passes.
```

If the console changed: rebuild locally with `PUBLIC_HUB_URL=https://hub.<your-domain> pnpm --filter @agentpod/console build` and redeploy `apps/console/build/` to Cloudflare Pages (Wrangler or push to the connected branch).

Node-agent upgrades: re-run the curl installer on each host (idempotent — it re-installs the binary, re-enrolls, and re-runs `apn service install`):
```bash
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | sudo bash -s -- https://hub.<your-domain> <TOKEN>
```
Or, from a repo checkout: `sudo bash apps/node-agent/scripts/install-node-agent.sh https://hub.<your-domain> <TOKEN>`.

On macOS the same command — piped and all — always installs rootless (regardless of `sudo`, re-execing as the invoking user) and (re)installs a per-user LaunchAgent via `apn service install`. Manage it with the `apn` verbs — `apn status`, `apn logs -f`, `apn restart` — it only runs while the user is logged in; system sleep suspends it and the node shows offline until wake. See [docs/OPERATING.md](./OPERATING.md#1-enroll-a-node) for the full verb list and the raw-launchctl/systemctl fallback.
