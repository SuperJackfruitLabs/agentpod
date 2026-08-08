# Quick Start Guide

> **Time:** 5 minutes  
> **Difficulty:** Beginner

Get AgentPod running locally in 5 minutes.

---

## Prerequisites

Before you begin, ensure you have:

- **Docker** - [Install Docker](https://docs.docker.com/get-docker/)
- **Node.js 22+** - [Install Node.js](https://nodejs.org/)
- **pnpm** - `npm install -g pnpm`
- **Rust** - [Install Rust](https://rustup.rs/) (for desktop app)
- **Tauri prerequisites** - [Platform-specific requirements](https://v2.tauri.app/start/prerequisites/)

---

## Step 1: Clone the Repository

```bash
git clone https://github.com/rakeshgangwar/agentpod.git
cd agentpod
```

## Step 2: Install Dependencies

```bash
pnpm install
```

## Step 3: Configure Environment

```bash
# Copy environment templates
cp .env.example .env
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env` with your settings:

```bash
# Required: Database connection
DATABASE_URL=postgres://agentpod:password@localhost:5432/agentpod

# Required: Auth secret (generate a random string)
BETTER_AUTH_SECRET=your-secret-key-change-this

# Optional: GitHub OAuth (for GitHub login)
GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret
```

## Step 4: Start Infrastructure

```bash
# Start PostgreSQL and Traefik
docker compose up -d postgres traefik
```

Wait for PostgreSQL to be ready:

```bash
docker compose logs -f postgres
# Look for: "database system is ready to accept connections"
# Press Ctrl+C to exit logs
```

## Step 5: Start Development Servers

```bash
# Start all apps (API + Frontend)
pnpm dev
```

Or run the full Tauri desktop app:

```bash
pnpm tauri dev
```

---

## Verify Installation

1. **Frontend:** Open http://localhost:5173
2. **API Health:** Visit http://localhost:3001/health

You should see the AgentPod interface!

---

## Next Steps

Now that AgentPod is running:

1. **[Create your first sandbox](./first-sandbox.md)** - Set up an AI workspace
2. **[Configure LLM providers](./configuration.md#llm-providers)** - Add API keys for Claude, GPT, etc.
3. **[Explore workflows](./workflows-guide.md)** - Build automation workflows

---

## Troubleshooting

### Port Already in Use

```bash
# Find what's using the port
lsof -i :5432  # PostgreSQL
lsof -i :3001  # API
lsof -i :5173  # Frontend

# Kill the process
kill -9 <PID>
```

### Docker Not Running

```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker
```

### Database Connection Failed

```bash
# Check PostgreSQL status
docker compose ps postgres

# View logs
docker compose logs postgres

# Restart PostgreSQL
docker compose restart postgres
```

### Rust/Tauri Build Errors

```bash
# Update Rust
rustup update

# Clean and rebuild
cd apps/frontend/src-tauri
cargo clean
cd ../../..
pnpm tauri dev
```

---

## Development Commands

```bash
# Start all apps
pnpm dev

# Start frontend only
pnpm dev:frontend

# Start API only
pnpm dev:api

# Run Tauri desktop app
pnpm tauri dev

# Run tests
pnpm test

# Type checking
pnpm check
```

---

## Getting Help

- **Issues:** https://github.com/rakeshgangwar/agentpod/issues
- **Discussions:** https://github.com/rakeshgangwar/agentpod/discussions
- **Full Documentation:** [docs/README.md](../README.md)
