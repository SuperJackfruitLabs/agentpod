/**
 * Configuration for Management API
 * Loads environment variables with sensible defaults
 */

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for environment variable: ${key}`);
  }
  return parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

export const config = {
  // Server
  port: getEnvInt('PORT', 3001),
  nodeEnv: getEnv('NODE_ENV', 'development'),

  // Authentication
  auth: {
    token: getEnv('API_TOKEN', 'dev-token-change-in-production'),
  },

  // Encryption for provider credentials
  encryption: {
    // 32-byte (256-bit) key for AES-256-GCM
    // In production, this should be a secure random value stored securely
    key: getEnv('ENCRYPTION_KEY', 'dev-encryption-key-32-bytes-long!'),
  },

  // ==========================================================================
  // Docker Orchestrator Configuration
  // ==========================================================================
  docker: {
    // Docker socket path (default: /var/run/docker.sock)
    socketPath: getEnv('DOCKER_SOCKET', '/var/run/docker.sock'),
    // Docker host for TCP connection (if not using socket)
    host: getEnv('DOCKER_HOST', ''),
    // Docker port for TCP connection
    port: getEnvInt('DOCKER_PORT', 2375),
    // Container name prefix
    containerPrefix: getEnv('DOCKER_CONTAINER_PREFIX', 'agentpod'),
    // Default Docker network for containers
    network: getEnv('DOCKER_NETWORK', 'agentpod-net'),
  },

  // ==========================================================================
  // Traefik Reverse Proxy Configuration
  // ==========================================================================
  traefik: {
    // Whether Traefik is enabled
    enabled: getEnvBool('TRAEFIK_ENABLED', true),
    // Docker network Traefik is connected to
    network: getEnv('TRAEFIK_NETWORK', 'agentpod-net'),
    // Whether to enable TLS by default
    tls: getEnvBool('TRAEFIK_TLS', false),
    // Certificate resolver name (for production)
    certResolver: getEnv('TRAEFIK_CERT_RESOLVER', ''),
  },

  // ==========================================================================
  // Domain Configuration
  // ==========================================================================
  domain: {
    // Base domain for sandbox URLs (e.g., "localhost" or "agentpod.dev")
    base: getEnv('BASE_DOMAIN', 'localhost'),
    // Protocol (http or https)
    protocol: getEnv('DOMAIN_PROTOCOL', 'http'),
  },

  // ==========================================================================
  // Data Storage Configuration
  // ==========================================================================
  data: {
    // Base directory for all persistent data
    dir: getEnv('DATA_DIR', './data'),
    // Git repositories directory (container path)
    reposDir: getEnv('REPOS_DIR', './data/repos'),
    // Container volumes directory (container path)
    volumesDir: getEnv('VOLUMES_DIR', './data/volumes'),
    // Host path prefix for bind mounts (when running in Docker)
    // This is needed because bind mounts must use host paths, not container paths
    // If not set, assumes running directly on host and uses reposDir/volumesDir as-is
    hostPathPrefix: getEnv('HOST_PATH_PREFIX', ''),
  },

  // ==========================================================================
  // Better Auth Configuration
  // ==========================================================================
  betterAuth: {
    // GitHub OAuth provider
    github: {
      clientId: getEnv('GITHUB_CLIENT_ID', ''),
      clientSecret: getEnv('GITHUB_CLIENT_SECRET', ''),
    },
    // Session configuration
    session: {
      // Better Auth signing secret. Docs and prod env already use BETTER_AUTH_SECRET;
      // config is the single source of truth and passes it to betterAuth() explicitly.
      secret: getEnv('BETTER_AUTH_SECRET', 'dev-session-secret-change-in-production'),
    },
  },

  // OpenCode containers
  opencode: {
    // Base port for OpenCode containers (auto-incremented per container)
    basePort: getEnvInt('OPENCODE_BASE_PORT', 4001),
    // Wildcard domain for OpenCode container URLs (e.g., superchotu.com -> opencode-{slug}.superchotu.com)
    wildcardDomain: getEnv('OPENCODE_WILDCARD_DOMAIN', ''),
    // OpenCode server port inside containers
    serverPort: getEnvInt('OPENCODE_SERVER_PORT', 4096),
  },
  
  // Container Registry
  registry: {
    url: getEnv('OPENCODE_REGISTRY_URL', 'forgejo.superchotu.com'),
    owner: getEnv('OPENCODE_REGISTRY_OWNER', 'rakeshgangwar'),
    version: getEnv('OPENCODE_CONTAINER_VERSION', '0.4.0'),
  },

  cloudflare: {
    enabled: getEnvBool('ENABLE_CLOUDFLARE_SANDBOXES', false),
    accountId: getEnv('CLOUDFLARE_ACCOUNT_ID', ''),
    apiToken: getEnv('CLOUDFLARE_API_TOKEN', ''),
    workerUrl: getEnv('CLOUDFLARE_WORKER_URL', ''),
    // The image wrangler.toml baked into the deployed worker. The sandbox
    // driver declares imageBinding: "fixed" and refuses a spec that asks for
    // anything else — but only when it knows this value, which is why
    // validate-config.ts requires it whenever `enabled` is true.
    sandboxImage: getEnv('CLOUDFLARE_SANDBOX_IMAGE', ''),
    r2Bucket: getEnv('CLOUDFLARE_R2_BUCKET', 'agentpod-workspaces'),
    defaultProvider: getEnv('DEFAULT_SANDBOX_PROVIDER', 'docker') as 'docker' | 'cloudflare',
    autoSelect: getEnvBool('AUTO_SELECT_PROVIDER', false),
  },

  fly: {
    enabled: getEnvBool('ENABLE_FLY_PROVISIONING', false),
    // Read here ONLY so validate-config can refuse the boot with a message
    // naming the variable. The DRIVER resolves this through
    // requireCredentials(), which is the seam the per-org encrypted store
    // (Horizon 3) replaces — do not make the driver read config.fly.apiToken.
    apiToken: getEnv('FLY_API_TOKEN', ''),
    // App creation requires an ORG-scoped token; Fly's app-scoped deploy tokens
    // can do everything else but not that.
    orgSlug: getEnv('FLY_ORG_SLUG', 'personal'),
    // Measured 2026-08-12: "bom" is refused on a non-paid plan ("legacy or
    // non-paid plan"), "sin" works.
    region: getEnv('FLY_REGION', 'sin'),
    appPrefix: getEnv('FLY_APP_PREFIX', 'agentpod'),
    // The workspace lives here, because the Fly rootfs is wiped on every
    // stop→start.
    volumeSizeGb: getEnvInt('FLY_VOLUME_SIZE_GB', 3),
  },

  metamcp: {
    // Internal URL for MetaMCP (used for tRPC/auth calls from API container)
    // Port 12008 is the Next.js frontend which proxies auth + tRPC
    url: getEnv('METAMCP_URL', 'http://metamcp:12008'),
    // Public URL for MetaMCP (external access via Traefik)
    publicUrl: getEnv('METAMCP_PUBLIC_URL', 'http://metamcp.localhost'),
    enabled: getEnvBool('METAMCP_ENABLED', true),
    // Service account for tRPC sync
    serviceAccount: {
      email: getEnv('METAMCP_SERVICE_EMAIL', 'agentpod-service@agentpod.local'),
      password: getEnv('METAMCP_SERVICE_PASSWORD', 'agentpod-service-secret-2026'),
    },
  },

  // Database
  database: {
    path: getEnv('DATABASE_PATH', './data/database.sqlite'),
  },
  
  // Management API public URL (for containers to call back)
  publicUrl: getEnv('MANAGEMENT_API_PUBLIC_URL', 'http://localhost:3001'),
  
  // Default user ID (until we have proper authentication)
  defaultUserId: getEnv('DEFAULT_USER_ID', 'default-user'),
} as const;

export type Config = typeof config;

// ─── CORS / CSWSH / CSRF origin policy (single source of truth) ───────────────

/**
 * Default browser origins that are always permitted.
 * Add more at runtime via the ALLOWED_ORIGINS env var (comma-separated).
 */
const _DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',         // Vite dev
  'https://console.agentpod.dev',  // Production console (Cloudflare Pages; same-site w/ hub.agentpod.dev)
  'https://app.agentpod.dev',      // legacy console origin (transitional)
] as const;

/**
 * The single canonical allowlist consumed by CORS middleware, the CSRF
 * middleware, and the station-terminal WebSocket CSWSH check.
 * Extend at deployment time with ALLOWED_ORIGINS="https://a.example.com,https://b.example.com".
 */
export const allowedOrigins: string[] = [
  ..._DEFAULT_ALLOWED_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : []),
];

/**
 * @deprecated Use `allowedOrigins` — kept for any external callers.
 */
export const corsAllowedOrigins: readonly string[] = allowedOrigins;

// Matches 192.168.A.B and 10.A.B.C private-network origins (4-octet).
const _LOCAL_IP_ORIGIN_RE = /^https?:\/\/(192\.168|10\.\d+)\.\d+\.\d+:\d+$/;

/**
 * Returns true if the given Origin header value is permitted by the hub's
 * CORS / CSRF / CSWSH policy.  A missing / empty origin (server-to-server,
 * no browser) is treated as allowed — there is no CSWSH risk without a
 * browser context.
 */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true;
  if (_LOCAL_IP_ORIGIN_RE.test(origin)) return true;
  return allowedOrigins.includes(origin);
}

// ─── Cookie configuration (env-driven, dev-safe) ──────────────────────────────

export interface SessionCookieOptions {
  /** Cookie Domain attribute — undefined in dev (http://localhost) */
  domain: string | undefined;
  /** SameSite attribute — always "lax" */
  sameSite: 'lax';
  /** Secure attribute — false in dev, true in prod */
  secure: boolean;
}

/**
 * Pure function that derives Better Auth session cookie attributes from the
 * process environment.  Pass `process.env` at runtime; pass a stub in tests.
 *
 * CRITICAL: when COOKIE_DOMAIN is unset and COOKIE_SECURE is not "true", the
 * returned options have `domain: undefined` and `secure: false` so that the
 * cookie works over http://localhost in local development without any changes.
 *
 * In production, set:
 *   COOKIE_DOMAIN=.agentpod.dev
 *   COOKIE_SECURE=true
 */
export function sessionCookieOptions(
  env: Partial<Record<string, string>> = process.env as Record<string, string>,
): SessionCookieOptions {
  const rawDomain = env.COOKIE_DOMAIN?.trim();
  return {
    domain: rawDomain || undefined,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE === 'true',
  };
}
