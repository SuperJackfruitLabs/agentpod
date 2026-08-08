# Phase 3: CI/CD Pipeline

**Priority**: High  
**Estimated Time**: 2-3 hours  
**Prerequisites**: Phase 1 (Security) completed

This phase sets up GitHub Actions for continuous integration and deployment.

## Overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push, PR | Lint, test, build |
| `build-deploy.yml` | Push to main, tags | Build images, optional deploy |
| `dependabot.yml` | Schedule | Security updates |

---

## 3.1 CI Workflow

**File**: `.github/workflows/ci.yml`

```yaml
# =============================================================================
# Continuous Integration
# =============================================================================
# Runs on every push and pull request
# - Linting and type checking
# - Unit and integration tests
# - Build verification
# =============================================================================

name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  # Suppress Bun analytics
  DO_NOT_TRACK: 1

jobs:
  # ===========================================================================
  # Lint and Type Check
  # ===========================================================================
  lint:
    name: Lint & Type Check
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type check
        run: pnpm typecheck

  # ===========================================================================
  # API Tests (Bun)
  # ===========================================================================
  test-api:
    name: API Tests
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: agentpod
          POSTGRES_PASSWORD: test-password
          POSTGRES_DB: agentpod_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run unit tests
        working-directory: apps/api
        run: bun test tests/unit
        env:
          NODE_ENV: test
          DATABASE_URL: postgres://agentpod:test-password@localhost:5432/agentpod_test
          API_TOKEN: test-token
          BETTER_AUTH_SECRET: test-session-secret-32-chars-long
          ENCRYPTION_KEY: test-encryption-key-32-bytes!!

      - name: Run integration tests
        working-directory: apps/api
        run: bun test tests/integration
        env:
          NODE_ENV: test
          DATABASE_URL: postgres://agentpod:test-password@localhost:5432/agentpod_test
          API_TOKEN: test-token
          BETTER_AUTH_SECRET: test-session-secret-32-chars-long
          ENCRYPTION_KEY: test-encryption-key-32-bytes!!

      - name: Run tests with coverage
        working-directory: apps/api
        run: bun test --coverage
        env:
          NODE_ENV: test
          DATABASE_URL: postgres://agentpod:test-password@localhost:5432/agentpod_test
          API_TOKEN: test-token
          BETTER_AUTH_SECRET: test-session-secret-32-chars-long
          ENCRYPTION_KEY: test-encryption-key-32-bytes!!

  # ===========================================================================
  # Rust Tests (Tauri Backend)
  # ===========================================================================
  test-rust:
    name: Rust Tests
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt

      - name: Cache Cargo
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: apps/frontend/src-tauri

      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf

      - name: Check formatting
        working-directory: apps/frontend/src-tauri
        run: cargo fmt --check

      - name: Run Clippy
        working-directory: apps/frontend/src-tauri
        run: cargo clippy -- -D warnings

      - name: Run tests
        working-directory: apps/frontend/src-tauri
        run: cargo test

  # ===========================================================================
  # Build Verification
  # ===========================================================================
  build:
    name: Build
    runs-on: ubuntu-latest
    needs: [lint, test-api]
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build packages
        run: pnpm build

  # ===========================================================================
  # Security Scan
  # ===========================================================================
  security:
    name: Security Scan
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Audit dependencies
        run: pnpm audit --audit-level=high
        continue-on-error: true

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: fs
          scan-ref: .
          severity: CRITICAL,HIGH
          exit-code: 0  # Don't fail on vulnerabilities (yet)
          format: table
```

---

## 3.2 Build & Deploy Workflow

**File**: `.github/workflows/build-deploy.yml`

```yaml
# =============================================================================
# Build and Deploy
# =============================================================================
# Builds Docker images and optionally deploys to VPS
# Triggered on:
# - Push to main branch
# - Version tags (v*)
# =============================================================================

name: Build & Deploy

on:
  push:
    branches: [main]
    paths:
      - 'apps/api/**'
      - 'docker/**'
      - 'docker-compose.yml'
      - '.github/workflows/build-deploy.yml'
    tags:
      - 'v*'

  workflow_dispatch:
    inputs:
      deploy:
        description: 'Deploy to production'
        required: true
        default: 'false'
        type: boolean

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  # ===========================================================================
  # Build API Docker Image
  # ===========================================================================
  build-api:
    name: Build API Image
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/api
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix=sha-

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/api/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64

  # ===========================================================================
  # Build Container Images (Base + Flavors)
  # ===========================================================================
  build-containers:
    name: Build Container - ${{ matrix.image }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      fail-fast: false
      matrix:
        image:
          - base
          - js
          - python
          - rust
          - fullstack
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Read version
        id: version
        run: |
          VERSION=$(cat docker/VERSION 2>/dev/null | tr -d '\n' || echo "0.0.1")
          echo "VERSION=$VERSION" >> $GITHUB_OUTPUT

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set build context
        id: context
        run: |
          if [ "${{ matrix.image }}" = "base" ]; then
            echo "dockerfile=docker/base/Dockerfile" >> $GITHUB_OUTPUT
            echo "context=docker/base" >> $GITHUB_OUTPUT
            echo "build_args=" >> $GITHUB_OUTPUT
          else
            echo "dockerfile=docker/flavors/${{ matrix.image }}/Dockerfile" >> $GITHUB_OUTPUT
            echo "context=docker/flavors/${{ matrix.image }}" >> $GITHUB_OUTPUT
            echo "build_args=BASE_IMAGE=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/agentpod-base:${{ steps.version.outputs.VERSION }}" >> $GITHUB_OUTPUT
          fi

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: ${{ steps.context.outputs.context }}
          file: ${{ steps.context.outputs.dockerfile }}
          push: true
          build-args: |
            CONTAINER_VERSION=${{ steps.version.outputs.VERSION }}
            ${{ steps.context.outputs.build_args }}
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/agentpod-${{ matrix.image }}:${{ steps.version.outputs.VERSION }}
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/agentpod-${{ matrix.image }}:latest
          cache-from: type=gha,scope=${{ matrix.image }}
          cache-to: type=gha,mode=max,scope=${{ matrix.image }}
          platforms: linux/amd64

  # ===========================================================================
  # Deploy to VPS (Optional)
  # ===========================================================================
  deploy:
    name: Deploy to Production
    runs-on: ubuntu-latest
    needs: [build-api, build-containers]
    if: github.event.inputs.deploy == 'true' || startsWith(github.ref, 'refs/tags/v')
    environment: production
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/agentpod
            
            # Pull latest images
            docker compose pull
            
            # Restart services with zero downtime
            docker compose up -d --remove-orphans
            
            # Clean up old images
            docker image prune -f
            
            # Verify health
            sleep 10
            curl -f http://localhost:3001/health || exit 1
            
            echo "Deployment successful!"

      - name: Notify on success
        if: success()
        run: |
          curl -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d "chat_id=${{ secrets.TELEGRAM_CHAT_ID }}" \
            -d "text=✅ Deployment successful: ${{ github.ref_name }}" \
            -d "parse_mode=HTML"

      - name: Notify on failure
        if: failure()
        run: |
          curl -X POST "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d "chat_id=${{ secrets.TELEGRAM_CHAT_ID }}" \
            -d "text=❌ Deployment failed: ${{ github.ref_name }}" \
            -d "parse_mode=HTML"
```

---

## 3.3 Dependabot Configuration

**File**: `.github/dependabot.yml`

```yaml
# =============================================================================
# Dependabot Configuration
# =============================================================================
# Automated dependency updates for security and maintenance

version: 2

updates:
  # NPM/pnpm dependencies
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "09:00"
    open-pull-requests-limit: 10
    groups:
      # Group minor and patch updates together
      npm-minor-patch:
        patterns:
          - "*"
        update-types:
          - minor
          - patch
    commit-message:
      prefix: "deps"
    labels:
      - dependencies
      - npm
    ignore:
      # Ignore major version updates for stability
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]

  # Rust/Cargo dependencies
  - package-ecosystem: cargo
    directory: /apps/frontend/src-tauri
    schedule:
      interval: weekly
      day: monday
      time: "09:00"
    open-pull-requests-limit: 5
    groups:
      cargo-minor-patch:
        patterns:
          - "*"
        update-types:
          - minor
          - patch
    commit-message:
      prefix: "deps(rust)"
    labels:
      - dependencies
      - rust
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]

  # Docker dependencies (security only)
  - package-ecosystem: docker
    directory: /apps/api
    schedule:
      interval: weekly
    open-pull-requests-limit: 3
    commit-message:
      prefix: "deps(docker)"
    labels:
      - dependencies
      - docker

  # GitHub Actions
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 3
    commit-message:
      prefix: "ci"
    labels:
      - dependencies
      - ci
```

---

## 3.4 GitHub Secrets Configuration

Configure these secrets in your GitHub repository settings:

### Required for CI

| Secret | Description | Example |
|--------|-------------|---------|
| (none) | CI uses `GITHUB_TOKEN` automatically | |

### Required for Deployment

| Secret | Description | How to Get |
|--------|-------------|------------|
| `VPS_HOST` | VPS IP or hostname | `123.45.67.89` |
| `VPS_USER` | SSH username | `deploy` |
| `VPS_SSH_KEY` | Private SSH key | `ssh-keygen -t ed25519` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | From bot API |

### Setting Up SSH Key

```bash
# On your local machine
ssh-keygen -t ed25519 -C "github-actions" -f ~/.ssh/github_deploy

# Copy public key to VPS
ssh-copy-id -i ~/.ssh/github_deploy.pub user@your-vps

# Add private key to GitHub Secrets as VPS_SSH_KEY
cat ~/.ssh/github_deploy
```

---

## 3.5 Branch Protection Rules

Configure these in GitHub repository settings → Branches:

### Main Branch Protection

| Setting | Value |
|---------|-------|
| Require pull request reviews | Yes |
| Required approving reviews | 1 |
| Require status checks | Yes |
| Required checks | `lint`, `test-api`, `build` |
| Require branches to be up to date | Yes |
| Include administrators | Yes |

---

## 3.6 GitHub Container Registry Setup

The workflow automatically pushes to GitHub Container Registry (ghcr.io). Images are available at:

```
ghcr.io/<owner>/agentpod/api:latest
ghcr.io/<owner>/agentpod/agentpod-base:latest
ghcr.io/<owner>/agentpod/agentpod-js:latest
ghcr.io/<owner>/agentpod/agentpod-python:latest
ghcr.io/<owner>/agentpod/agentpod-rust:latest
ghcr.io/<owner>/agentpod/agentpod-fullstack:latest
```

### Making Images Public (Optional)

1. Go to GitHub → Packages
2. Click on the package
3. Package settings → Change visibility → Public

This enables unlimited storage and bandwidth.

---

## 3.7 Local Development Workflow

After CI is set up, the development workflow becomes:

```bash
# 1. Create feature branch
git checkout -b feature/my-feature

# 2. Make changes and test locally
pnpm test
pnpm typecheck

# 3. Commit and push
git add .
git commit -m "feat: add new feature"
git push -u origin feature/my-feature

# 4. Open PR - CI runs automatically
# 5. After review and CI passes, merge to main
# 6. Deployment runs automatically (if configured)
```

---

## Checklist

- [ ] Create `.github/workflows/ci.yml`
- [ ] Create `.github/workflows/build-deploy.yml`
- [ ] Create `.github/dependabot.yml`
- [ ] Configure GitHub secrets (if deploying)
- [ ] Set up branch protection rules
- [ ] Verify CI runs on push/PR
- [ ] Test deployment workflow (manual trigger)
- [ ] Configure Dependabot alerts

---

## Monitoring CI/CD

### GitHub Actions Dashboard

View workflow runs at:
```
https://github.com/<owner>/<repo>/actions
```

### Notifications

GitHub sends notifications for:
- Failed workflow runs
- Dependabot PRs
- Required review requests

Configure notification preferences in GitHub settings.

---

## Troubleshooting

### Common Issues

**1. Tests fail with database connection error**
- Check PostgreSQL service is running in CI
- Verify DATABASE_URL environment variable

**2. Docker build fails**
- Check Dockerfile paths are correct
- Verify base image exists (for flavor builds)

**3. Deployment fails**
- Verify SSH key is correct
- Check VPS_HOST is reachable
- Ensure docker-compose.yml exists on VPS

**4. Permission denied for ghcr.io**
- Ensure workflow has `packages: write` permission
- Check repository visibility settings

---

## Next Phase

After completing Phase 3, proceed to [Phase 4: Database Backup](./phase-4-backup.md).
