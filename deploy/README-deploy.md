# P3 — Hub Deploy Runbook (production, operator-gated)

> ## Historical record — superseded. Do not follow this.
>
> This is the runbook for the **first** hub deploy, written against the
> `redesign/fleet-console` branch, with the console served from the VPS at
> `app.agentpod.dev`. It is kept because it records what was actually done to the live box,
> not because it is current. **The deployment guide is
> [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).**
>
> Three things in here are known-wrong today and are left as written rather than patched:
> `SESSION_SECRET` (step 4) is read by nothing — the hub uses `BETTER_AUTH_SECRET`;
> `PUBLIC_URL` (step 4) is read by nothing; and `redesign/fleet-console` no longer exists —
> production deploys from `main`. Step 4's `COOKIE_DOMAIN` / `COOKIE_SECURE` /
> `ALLOWED_ORIGINS`, on the other hand, were right, and were missing from DEPLOYMENT.md
> until 2026-08-14.

Deploys the AgentPod hub + console onto the existing Matrix box
(`<HUB_HOST>`, Ubuntu 24.04, nginx + Synapse). **Every step is additive.**

> ⚠️ **SAFETY — read first**
> - This is the live `id.agentpod.dev` Matrix homeserver. Do **NOT** edit the
>   existing `id.agentpod.dev` nginx vhost or touch Synapse's sqlite
>   (`/var/lib/matrix-synapse/homeserver.db`).
> - We add only: a new Postgres DB, two new nginx vhosts (`hub.`/`app.`), one
>   systemd unit. Nothing else changes.
> - **`nginx -t` before every `systemctl reload nginx`.** If it fails, fix and
>   re-test before reloading — a bad reload would take Matrix offline too.
> - Run steps one at a time; verify Synapse + `id.agentpod.dev` stay up after
>   the nginx reload (`curl -sI https://id.agentpod.dev` should still 200/redirect).

Assumes the repo is checked out at `/opt/agentpod` on the box and the
`redesign/fleet-console` branch is built.

---

## 0. DNS (Cloudflare, do first — certs need it resolving)
Add two A-records → `<HUB_HOST>`:
- `hub.agentpod.dev`  (DNS-only / grey-cloud recommended so nginx terminates TLS and WS isn't subject to CF proxy quirks)
- `app.agentpod.dev`
Wait for propagation (`dig +short hub.agentpod.dev` → the IP).

## 1. Toolchain (if not already present)
```bash
# Bun (for the hub) — installs to ~/.bun/bin/bun
curl -fsSL https://bun.sh/install | bash
# Node/pnpm (to build the console) — use the repo's pinned versions
corepack enable && corepack prepare pnpm@latest --activate
```

## 2. Postgres + pgvector (hub's own DB — Synapse keeps its sqlite)
```bash
apt-get update && apt-get install -y postgresql postgresql-contrib postgresql-16-pgvector
sudo -u postgres psql -c "CREATE ROLE agentpod LOGIN PASSWORD '<STRONG_PASSWORD>';"
sudo -u postgres psql -c "CREATE DATABASE agentpod OWNER agentpod;"
sudo -u postgres psql -d agentpod -c "CREATE EXTENSION IF NOT EXISTS vector;"
```
Tune conservatively (shared box): set `shared_buffers = 256MB` in
`/etc/postgresql/16/main/postgresql.conf`, then `systemctl restart postgresql`.

## 3. Build hub + console
```bash
cd /opt/agentpod
git fetch && git checkout redesign/fleet-console && git pull
pnpm install --frozen-lockfile
# Console: build static SPA pointed at the public hub
PUBLIC_HUB_URL=https://hub.agentpod.dev pnpm --filter @agentpod/console build   # → apps/console/build
# Hub deps are run directly by bun (no build step needed; `bun run src/index.ts`).
```

## 4. Hub env file (secrets — chmod 600)
```bash
mkdir -p /etc/agentpod
cat > /etc/agentpod/hub.env <<EOF
DATABASE_URL=postgres://agentpod:<STRONG_PASSWORD>@localhost:5432/agentpod
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
PORT=3001
NODE_ENV=production
PUBLIC_URL=https://hub.agentpod.dev
COOKIE_DOMAIN=.agentpod.dev
COOKIE_SECURE=true
ALLOWED_ORIGINS=https://app.agentpod.dev
EOF
chmod 600 /etc/agentpod/hub.env
```
(Legacy OpenCode vars in `apps/hub/.env.example` — GITHUB_*, DOCKER_*, TRAEFIK_*
— are not needed for the fleet console; leave unset.)

## 5. Hub systemd unit (self-migrates on start)
```bash
cp /opt/agentpod/deploy/agentpod-hub.service /etc/systemd/system/
# Verify ExecStart bun path matches `which bun` (default /root/.bun/bin/bun).
systemctl daemon-reload
systemctl enable --now agentpod-hub
systemctl status agentpod-hub --no-pager        # active; logs show "migrations completed"
curl -s http://127.0.0.1:3001/health            # {"status":"ok",...}
```

## 6. nginx vhosts (ADDITIVE — never touch id.agentpod.dev)
```bash
# The WS upgrade map (once, http{} context):
cat > /etc/nginx/conf.d/agentpod-upgrade.conf <<'EOF'
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
EOF
cp /opt/agentpod/deploy/nginx/hub.agentpod.dev.conf /etc/nginx/sites-available/agentpod-hub
ln -sf /etc/nginx/sites-available/agentpod-hub /etc/nginx/sites-enabled/agentpod-hub
nginx -t                                         # MUST pass before reload
systemctl reload nginx
curl -sI https://id.agentpod.dev                 # confirm Matrix still served
```

## 7. TLS (certbot adds the :443 listeners)
```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d hub.agentpod.dev -d app.agentpod.dev   # picks up the new vhosts
nginx -t && systemctl reload nginx
curl -s https://hub.agentpod.dev/health          # ok over TLS
curl -sI https://app.agentpod.dev                # 200, serves the console
```

## 8. Smoke (then hand to Task 11 verification)
- Open `https://app.agentpod.dev` → connect screen prefilled with the hub; sign in; in devtools the session cookie is `Domain=.agentpod.dev; Secure; SameSite=Lax`.
- `https://id.agentpod.dev` still serves Matrix (Synapse untouched).

## 9. Re-point node-agents (no more tunnel)
On each fleet host (buddhimaan, superchotu, superprocess-remote-dev), install the
agent as a service pointed at the public hub (replaces the P2 demo tunnel setup):
```bash
# copy the linux binary + run, OR use the install script from the repo:
sudo bash /opt/agentpod/apps/node-agent/scripts/install-node-agent.sh \
  https://hub.agentpod.dev <enrollment-token-from-app.agentpod.dev>
systemctl status agentpod-node       # active; node shows online in the console, NO tunnel
```

## Rollback
- `systemctl disable --now agentpod-hub`
- `rm /etc/nginx/sites-enabled/agentpod-hub /etc/nginx/conf.d/agentpod-upgrade.conf && nginx -t && systemctl reload nginx`
- `sudo -u postgres dropdb agentpod` (only if abandoning).
Synapse / `id.agentpod.dev` are never modified, so rollback cannot affect Matrix.
