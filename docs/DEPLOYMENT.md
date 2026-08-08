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

Build both images on the Docker host from the repo root. The context path is `apps/node-agent`; the Dockerfiles live in `apps/node-agent/deploy/`.

```bash
cd /opt/agentpod

# Base node-agent image (no harness preloaded)
docker build \
  -t agentpod-node:local \
  -f apps/node-agent/deploy/Dockerfile \
  apps/node-agent

# OpenCode harness image (bun + opencode-ai@0.5.5 preloaded)
docker build \
  -t agentpod-node-opencode:local \
  -f apps/node-agent/deploy/Dockerfile.opencode \
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
EOF
chmod 600 /etc/agentpod/hub.env
```

> **Key constraints**
> - `BETTER_AUTH_SECRET`: ≥ 32 characters.
> - `ENCRYPTION_KEY`: **exactly** 32 bytes. Using `openssl rand -hex 16` produces 32 hex characters = 32 ASCII bytes.
> - Never commit this file to source control.

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
cd /opt/agentpod && git pull
# Restart hub (auto-migrates):
systemctl restart agentpod-hub
systemctl status agentpod-hub --no-pager
```

If the console changed: rebuild locally with `PUBLIC_HUB_URL=https://hub.<your-domain> pnpm --filter @agentpod/console build` and redeploy `apps/console/build/` to Cloudflare Pages (Wrangler or push to the connected branch).

Node-agent upgrades: re-run the curl installer on each host (idempotent — it re-installs the binary, re-enrolls, and re-runs `apn service install`):
```bash
curl -fsSL https://github.com/rakeshgangwar/agentpod/releases/latest/download/install.sh \
  | sudo bash -s -- https://hub.<your-domain> <TOKEN>
```
Or, from a repo checkout: `sudo bash apps/node-agent/scripts/install-node-agent.sh https://hub.<your-domain> <TOKEN>`.

On macOS the same command — piped and all — always installs rootless (regardless of `sudo`, re-execing as the invoking user) and (re)installs a per-user LaunchAgent via `apn service install`. Manage it with the `apn` verbs — `apn status`, `apn logs -f`, `apn restart` — it only runs while the user is logged in; system sleep suspends it and the node shows offline until wake. See [docs/OPERATING.md](./OPERATING.md#1-enroll-a-node) for the full verb list and the raw-launchctl/systemctl fallback.
