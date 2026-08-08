# Self-Hosting Guide

> **Time:** 30-60 minutes  
> **Difficulty:** Intermediate

Deploy AgentPod to your own server for production use.

---

## Deployment Options

| Option | Best For | Complexity |
|--------|----------|------------|
| [Docker Compose](#docker-compose) | Single server, small teams | Low |
| [Manual Deployment](#manual-deployment) | Custom infrastructure | Medium |
| [Kubernetes](#kubernetes) | Large scale, high availability | High |

---

## Requirements

### Minimum Hardware

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 vCPUs | 4 vCPUs |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB SSD | 50 GB SSD |
| Network | 100 Mbps | 1 Gbps |

### Software Requirements

- Docker 24+ with Docker Compose
- Domain name with DNS access
- SSL certificate (auto-generated with Let's Encrypt)

---

## Docker Compose

The recommended deployment method for most users.

### Step 1: Clone Repository

```bash
git clone https://github.com/rakeshgangwar/agentpod.git
cd agentpod
```

### Step 2: Configure Environment

```bash
cp .env.example .env
nano .env
```

Edit the following values:

```bash
# ===================
# REQUIRED SETTINGS
# ===================

# Database (change password!)
DATABASE_URL=postgres://agentpod:CHANGE_THIS_PASSWORD@postgres:5432/agentpod
POSTGRES_PASSWORD=CHANGE_THIS_PASSWORD

# Auth secret (generate with: openssl rand -hex 32)
BETTER_AUTH_SECRET=your-64-character-hex-string

# Domain configuration
BASE_DOMAIN=your-domain.com

# ===================
# OPTIONAL SETTINGS
# ===================

# GitHub OAuth (for GitHub login)
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret

# SSL email for Let's Encrypt
ACME_EMAIL=admin@your-domain.com
```

### Step 3: Configure DNS

Point your domain to your server:

```
A     your-domain.com       → YOUR_SERVER_IP
A     api.your-domain.com   → YOUR_SERVER_IP
A     *.your-domain.com     → YOUR_SERVER_IP  (for sandboxes)
```

### Step 4: Deploy

```bash
# Start all services
docker compose -f docker-compose.prod.yml up -d

# Check status
docker compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f
```

### Step 5: Verify

1. **Frontend:** https://your-domain.com
2. **API Health:** https://api.your-domain.com/health
3. **Traefik Dashboard:** https://traefik.your-domain.com (if enabled)

---

## Configuration Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `BETTER_AUTH_SECRET` | Yes | 64-character secret for auth |
| `BASE_DOMAIN` | Yes | Your domain (e.g., `agentpod.app`) |
| `GITHUB_CLIENT_ID` | No | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | No | GitHub OAuth client secret |
| `ACME_EMAIL` | No | Email for Let's Encrypt |

### Docker Compose Services

| Service | Port | Description |
|---------|------|-------------|
| `postgres` | 5432 | PostgreSQL database |
| `api` | 3001 | Management API |
| `traefik` | 80, 443 | Reverse proxy + SSL |
| `loki` | 3100 | Log aggregation |
| `grafana` | 3000 | Monitoring dashboard |

---

## SSL Certificates

### Automatic (Let's Encrypt)

Traefik automatically obtains SSL certificates. Ensure:

1. Domain DNS is configured correctly
2. Ports 80 and 443 are open
3. `ACME_EMAIL` is set in `.env`

### Manual Certificates

Place certificates in `./config/traefik/certs/`:

```bash
mkdir -p config/traefik/certs
cp your-cert.pem config/traefik/certs/cert.pem
cp your-key.pem config/traefik/certs/key.pem
```

Update `config/traefik/dynamic/tls.yml`:

```yaml
tls:
  certificates:
    - certFile: /certs/cert.pem
      keyFile: /certs/key.pem
```

---

## Monitoring

### Grafana Dashboard

Access Grafana at `https://grafana.your-domain.com`

Default credentials:
- **Username:** `admin`
- **Password:** Check `GRAFANA_ADMIN_PASSWORD` in `.env`

### Viewing Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f api

# Query Loki logs
curl -G http://localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={job="agentpod"}' \
  --data-urlencode 'limit=100'
```

---

## Backup

### Database Backup

```bash
# Manual backup
./scripts/backup-db.sh

# Automated backup (add to crontab)
0 2 * * * /path/to/agentpod/scripts/backup-db.sh
```

### Restore from Backup

```bash
# Stop API
docker compose -f docker-compose.prod.yml stop api

# Restore database
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U agentpod -d agentpod < backup.sql

# Restart API
docker compose -f docker-compose.prod.yml start api
```

See [Backup & Recovery Guide](./backup-recovery.md) for full documentation.

---

## Updating

### Standard Update

```bash
# Pull latest changes
git pull origin main

# Rebuild and restart
docker compose -f docker-compose.prod.yml up -d --build
```

### Database Migrations

Migrations run automatically on API startup. For manual migration:

```bash
docker compose -f docker-compose.prod.yml exec api \
  bun run db:migrate
```

---

## Security Checklist

Before going to production, ensure:

- [ ] Changed default database password
- [ ] Generated unique `BETTER_AUTH_SECRET`
- [ ] Configured GitHub OAuth (or disabled registration)
- [ ] Set up firewall (only ports 80, 443 open)
- [ ] Enabled automatic backups
- [ ] Configured monitoring alerts
- [ ] Reviewed [Security Guide](../production/phase-1-security.md)

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose -f docker-compose.prod.yml logs api

# Verify environment
docker compose -f docker-compose.prod.yml config
```

### SSL Certificate Issues

```bash
# Check Traefik logs
docker compose -f docker-compose.prod.yml logs traefik

# Verify DNS
dig your-domain.com
```

### Database Connection Failed

```bash
# Check PostgreSQL is running
docker compose -f docker-compose.prod.yml ps postgres

# Test connection
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U agentpod -c "SELECT 1"
```

### Out of Disk Space

```bash
# Clean Docker resources
docker system prune -a --volumes

# Check disk usage
df -h
```

---

## Support

- **Documentation:** [Full Docs](../README.md)
- **GitHub Issues:** https://github.com/rakeshgangwar/agentpod/issues
- **Production Checklist:** [../production/PRODUCTION_CHECKLIST.md](../production/PRODUCTION_CHECKLIST.md)
