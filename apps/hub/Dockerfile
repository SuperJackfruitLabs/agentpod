# =============================================================================
# Management API Dockerfile
# Multi-stage build for smaller production image
# 
# Build context: monorepo root (/)
# Dockerfile location: /apps/api/Dockerfile
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Copy root package.json and create bun-compatible workspace config
COPY package.json ./
# Add workspaces field for bun (pnpm uses pnpm-workspace.yaml, bun uses package.json)
RUN bun -e "const pkg = JSON.parse(await Bun.file('package.json').text()); pkg.workspaces = ['packages/*', 'apps/*']; await Bun.write('package.json', JSON.stringify(pkg, null, 2));"

# Copy workspace package.json files for dependency resolution
COPY packages/types/package.json ./packages/types/
COPY packages/agents/package.json ./packages/agents/
COPY packages/tsconfig/ ./packages/tsconfig/
COPY apps/api/package.json ./apps/api/

# Install dependencies from root (enables workspace resolution)
RUN bun install --filter @agentpod/api

# Copy workspace packages source
COPY packages/types/ ./packages/types/
COPY packages/agents/ ./packages/agents/

# Copy API source code
COPY apps/api/src/ ./apps/api/src/
COPY apps/api/tsconfig.json ./apps/api/

# -----------------------------------------------------------------------------
# Stage 2: Production
# -----------------------------------------------------------------------------
FROM oven/bun:1.3-alpine AS production

WORKDIR /app

# Install required packages:
# - shadow: for usermod/groupadd commands
# - su-exec: for dropping privileges
# - git: for repository management
RUN apk add --no-cache shadow su-exec git

# Create non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

# Copy the monorepo structure needed for workspace resolution
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api ./apps/api

# Create data directories for SQLite and repos (both /app/data for defaults and /data for docker-compose)
RUN mkdir -p /app/data /data/db /data/repos /data/volumes && \
    chown -R appuser:appgroup /app/data /data

# Set working directory to API
WORKDIR /app/apps/api

# Environment variables (can be overridden at runtime)
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/app/data/database.sqlite

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Copy entrypoint script
COPY apps/api/scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Run via entrypoint (handles Docker socket permissions, then drops to appuser)
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
