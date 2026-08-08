# AgentPod User Guides

> **Status:** Current  
> **Last Updated:** December 2025

Practical guides for using, deploying, and operating AgentPod.

---

## Getting Started

| Guide | Description | Time |
|-------|-------------|------|
| [Quick Start](./quick-start.md) | Get up and running | 5 min |
| [First Sandbox](./first-sandbox.md) | Create your first AI sandbox | 10 min |
| [Configuration](./configuration.md) | Environment variables and settings | 15 min |

## User Guides

| Guide | Description |
|-------|-------------|
| [Working with Agents](./agents-guide.md) | How to interact with AI agents |
| [Workflows Guide](./workflows-guide.md) | Building and running workflows |
| [Managing Sandboxes](./sandboxes-guide.md) | Sandbox lifecycle management |
| [File Browser](./file-browser-guide.md) | Navigating project files |
| [Terminal Access](./terminal-guide.md) | Using the integrated terminal |

## Operator Guides

| Guide | Description |
|-------|-------------|
| [Self-Hosting](./self-hosting.md) | Running AgentPod in production |
| [Monitoring](./monitoring.md) | Observability and troubleshooting |
| [Backup & Recovery](./backup-recovery.md) | Data protection strategies |
| [Security Hardening](./security.md) | Production security checklist |

## Developer Guides

| Guide | Description |
|-------|-------------|
| [Architecture Overview](../architecture/system-architecture.md) | System design |
| [Contributing](../../CONTRIBUTING.md) | How to contribute |
| [API Reference](../reference/api/README.md) | API documentation |
| [Testing Guide](../testing/tdd-workflow.md) | Test-driven development |

---

## Quick Links

- **New to AgentPod?** Start with [Quick Start](./quick-start.md)
- **Deploying to production?** See [Self-Hosting](./self-hosting.md)
- **Having issues?** Check [Troubleshooting](#troubleshooting)

---

## Troubleshooting

### Common Issues

**Port conflicts:**
```bash
# Check if ports are in use
lsof -i :5432  # PostgreSQL
lsof -i :3001  # API
lsof -i :5173  # Frontend
```

**Docker issues:**
```bash
# Restart Docker daemon
docker compose down
docker compose up -d
```

**Database connection failed:**
```bash
# Check PostgreSQL is running
docker compose ps postgres
docker compose logs postgres
```

### Getting Help

- [GitHub Issues](https://github.com/rakeshgangwar/agentpod/issues) - Bug reports
- [Discussions](https://github.com/rakeshgangwar/agentpod/discussions) - Questions
- [Documentation](../README.md) - Full documentation index
