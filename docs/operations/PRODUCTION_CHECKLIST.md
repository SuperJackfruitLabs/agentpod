# Production Deployment Checklist

Use this checklist before deploying to production. All items must be verified.

---

## 1. Secrets & Configuration

### Critical (Will Block Startup)
- [ ] `API_TOKEN` - Generate: `openssl rand -base64 32`
- [ ] `BETTER_AUTH_SECRET` - Generate: `openssl rand -base64 32`
- [ ] `ENCRYPTION_KEY` - Generate: `openssl rand -base64 24 | head -c 32`
- [ ] `POSTGRES_PASSWORD` - Use strong password, not default

### Required for Features
- [ ] `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` - If using GitHub OAuth
- [ ] `GRAFANA_PASSWORD` - Change from default `admin`
- [ ] `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` - For alerting (optional)

### Verify No Dev Values
```bash
# Run this to check for dev patterns in your .env
grep -E "(dev-|change-in-production|example|test|dummy)" .env
# Should return nothing
```

---

## 2. Infrastructure

### VPS Setup
- [ ] Docker installed and running
- [ ] Docker Compose v2 installed
- [ ] Sufficient disk space (minimum 20GB recommended)
- [ ] Sufficient RAM (minimum 4GB recommended)
- [ ] Firewall configured (only 80, 443 open)

### Network
- [ ] Domain DNS configured pointing to VPS
- [ ] `BASE_DOMAIN` set in `.env`
- [ ] `DOMAIN_PROTOCOL` set to `https`

### TLS/HTTPS
- [ ] Traefik Let's Encrypt configured
- [ ] `TRAEFIK_TLS=true` in `.env`
- [ ] `TRAEFIK_CERT_RESOLVER` configured
- [ ] Port 443 open in firewall

---

## 3. Security Verification

### Test Security Headers
```bash
# After deployment, verify headers are present
curl -I https://api.your-domain.com/health

# Should include:
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
# Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

### Test Rate Limiting
```bash
# Should get 429 after 5 rapid requests to auth endpoints
for i in {1..10}; do curl -s -o /dev/null -w "%{http_code}\n" https://api.your-domain.com/api/auth/session; done
```

### Test CSRF Protection
```bash
# Should get 403 for POST without proper origin
curl -X POST https://api.your-domain.com/api/test -H "Content-Type: application/json"
```

---

## 4. Database

### Backup Verification
- [ ] Backup service running: `docker ps | grep backup`
- [ ] Initial backup created: `ls -la backups/daily/`
- [ ] Test restore procedure (on test database)

### Backup Test
```bash
# Create test restore
docker exec agentpod-postgres psql -U agentpod -c "CREATE DATABASE restore_test;"
gunzip -c backups/daily/latest.sql.gz | docker exec -i agentpod-postgres psql -U agentpod -d restore_test
docker exec agentpod-postgres psql -U agentpod -c "DROP DATABASE restore_test;"
```

---

## 5. Observability

### Verify Stack Running
```bash
docker ps | grep -E "(loki|fluent-bit|grafana)"
# All three should be running
```

### Access Grafana
```bash
# SSH tunnel to access Grafana
ssh -L 3000:localhost:3000 user@your-vps
# Then open http://localhost:3000
```

### Grafana Setup
- [ ] Login with admin credentials
- [ ] Verify Loki datasource is connected (green)
- [ ] Import AgentPod dashboard visible
- [ ] Configure Telegram alert contact point (if using alerts)

### Test Logging Pipeline
```bash
# Generate test log
docker exec agentpod-api sh -c 'echo "test log" | tee /proc/1/fd/1'

# Check in Grafana > Explore > Loki
# Query: {job="docker"}
```

---

## 6. CI/CD

### GitHub Secrets Required
- [ ] `VPS_HOST` - Your VPS IP or hostname
- [ ] `VPS_USER` - SSH username
- [ ] `VPS_SSH_KEY` - Private SSH key for deployment
- [ ] `TELEGRAM_BOT_TOKEN` - For deployment notifications (optional)
- [ ] `TELEGRAM_CHAT_ID` - For deployment notifications (optional)

### Verify Workflows
- [ ] Push to `main` triggers CI
- [ ] CI passes (lint, test, build)
- [ ] Manual deploy workflow accessible

---

## 7. Health Checks

### API Health
```bash
curl https://api.your-domain.com/health
# Should return: {"status":"ok","timestamp":"..."}
```

### Docker Health
```bash
curl https://api.your-domain.com/api/v2/health/docker
# Should return Docker connectivity status
```

### Container Health
```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
# All containers should show "healthy" or "Up"
```

---

## 8. Performance

### Resource Limits (Optional but Recommended)
Add to docker-compose.yml services:
```yaml
deploy:
  resources:
    limits:
      memory: 512M
    reservations:
      memory: 256M
```

### Log Rotation
- [ ] Docker log rotation configured in `/etc/docker/daemon.json`:
```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

---

## 9. Monitoring & Alerts

### Uptime Monitoring (External)
- [ ] Set up UptimeRobot or similar (free tier)
- [ ] Monitor: `https://api.your-domain.com/health`
- [ ] Alert via email/Telegram on downtime

### Grafana Alerts (Internal)
- [ ] Error rate alert configured
- [ ] Backup failure alert configured
- [ ] Test alerts firing correctly

---

## 10. Documentation

### Runbooks Created
- [ ] How to restart services
- [ ] How to restore from backup
- [ ] How to rollback deployment
- [ ] How to check logs
- [ ] Emergency contact procedures

### Access Documented
- [ ] VPS SSH access details (secure location)
- [ ] Grafana credentials (secure location)
- [ ] GitHub deployment permissions

---

## Pre-Launch Final Check

```bash
# Run all health checks
echo "=== Container Status ===" && docker ps --format "table {{.Names}}\t{{.Status}}"
echo ""
echo "=== API Health ===" && curl -s https://api.your-domain.com/health | jq
echo ""
echo "=== Security Headers ===" && curl -sI https://api.your-domain.com/health | grep -E "^(X-|Strict)"
echo ""
echo "=== Recent Backups ===" && ls -la backups/daily/ | tail -5
echo ""
echo "=== Disk Space ===" && df -h /
echo ""
echo "=== Memory ===" && free -h
```

---

## Post-Launch

- [ ] Monitor logs for first 24 hours
- [ ] Verify daily backup ran (check at 3 AM UTC + 1 hour)
- [ ] Check Grafana for any error spikes
- [ ] Test all critical user flows manually
- [ ] Document any issues encountered

---

*Last updated: December 2025*
