/**
 * Configuration for Management API
 * Loads environment variables with sensible defaults
 */

import { dockerDaemonSettingsFromEnv } from './services/provisioner/docker-daemon';

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Read an integer setting, falling back to `defaultValue`.
 *
 * A PRESENT BUT EMPTY variable counts as unset. This is not leniency for its
 * own sake: every deployment surface — a docker-compose `environment:` entry,
 * a `.env` line, a systemd `Environment=`, a copied block from
 * docs/DEPLOYMENT.md with the comment removed but the value not filled in —
 * turns "I did not set this" into "" rather than into absent. Treating "" as a
 * parse failure meant a blank line in an operator's env file threw HERE, at
 * module scope, before `validateConfig()` exists to say anything useful, and it
 * did so for every hub regardless of which substrates it had enabled: a
 * docker-only hub could be stopped from booting by a blank FLY_VOLUME_SIZE_GB.
 * A value nobody supplied is a value nobody supplied.
 *
 * A non-empty value that is not an integer is still a refusal — that is an
 * operator saying something the hub cannot honour, not an operator saying
 * nothing — and the refusal is now WHOLE-STRING. `parseInt` read "3.5" as 3 and
 * "12gb" as 12 without a word, which is how FLY_VOLUME_SIZE_GB came to mean two
 * different numbers at once: 3 to the boot check that validated it and 3.5 to
 * the driver that sent it to Fly. These settings are counts of whole things —
 * ports, gigabytes — so a value that is not a whole number is a mistake worth
 * hearing about, not a value worth guessing at.
 */
const INTEGER_RE = /^[+-]?\d+$/;

export function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key]?.trim();
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (!INTEGER_RE.test(value)) {
    throw new Error(`Invalid integer for environment variable: ${key}`);
  }
  return Number(value);
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

  /**
   * forge, for provisioning an agent's git identity.
   *
   * Unset means the feature is off and `POST …/git-identity` answers 503 — a deployment that
   * never asked for this grows no new door. The admin token can create any account and register
   * any key, so it lives in `hub.env` beside the other root-equivalent values and never in this
   * file.
   *
   * `charter → decisions/2026-09-27-which-side-is-primary-is-a-repositorys-property.md`.
   */
  forge: {
    url: getEnv('FORGE_URL', ''),
    adminToken: getEnv('FORGE_ADMIN_TOKEN', ''),
  },

  /**
   * Transcript redaction (services/redact-content.ts). `rulesFile` is a JSON list of
   * `{"name","pattern"}` applied after the built-in rules; unset or absent means none, and a
   * file that is there but unusable refuses the boot (validate-config.ts).
   */
  redaction: {
    rulesFile: getEnv('HUB_REDACTION_RULES_FILE', '').trim(),
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
    // Whether the Docker provisioner is registered at all. The registry
    // (services/provisioner/registry.ts) remains the authority on that at
    // runtime; this copy exists so validate-config can scope its Docker rules
    // the way it scopes the Cloudflare, Modal and Fly ones — a hub that never
    // provisions Docker must not be stopped from booting by a Docker variable.
    enabled: getEnvBool('ENABLE_DOCKER_PROVISIONING', false),
    // DOCKER_HOST / DOCKER_SOCKET / DOCKER_PORT / DOCKER_CERT_PATH /
    // DOCKER_ALLOW_INSECURE_TCP. Read through the same function the driver
    // uses, so boot validation and the driver cannot end up looking at
    // different variables — a hub that validates one daemon and then talks to
    // another is the failure this whole seam exists to prevent.
    // Unset, this is `/var/run/docker.sock`, exactly as it has always been.
    ...dockerDaemonSettingsFromEnv(process.env),
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

  modal: {
    enabled: getEnvBool('ENABLE_MODAL_PROVISIONING', false),
    // Workspace-wide on Modal's Starter plan: per-resource scoping needs the
    // $250/mo Team plan. Use a Modal workspace dedicated to AgentPod.
    tokenId: getEnv('MODAL_TOKEN_ID', ''),
    tokenSecret: getEnv('MODAL_TOKEN_SECRET', ''),
    // Modal pulls from a registry and runs linux/amd64 only, so the local tags
    // a Docker-first hub uses are meaningless to it.
    image: getEnv('NODE_AGENT_MODAL_IMAGE', ''),
    appName: getEnv('MODAL_APP_NAME', 'agentpod'),
  },

  // Hub URL a provisioned container dials to enrol. Request-scoped for a
  // console-initiated create, but a rotating substrate re-creates instances on
  // a timer with no request in sight — so it must be configured.
  provisioningHubUrl: getEnv('PROVISIONING_HUB_URL', ''),

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

  bridge: {
    // Whether this hub claims work from a superpipeline board at all. The bridge's
    // own `isBridgeEnabled()` remains the authority at runtime (it requires the
    // literal string "true", like isProviderEnabled); this copy exists so
    // validate-config can scope its rule the way it scopes the provisioner
    // ones — a hub that never claims must not be stopped from booting by a
    // bridge variable. Off, and never inferred from a token being present.
    enabled: getEnvBool('ENABLE_SUPERPIPELINE_BRIDGE', false),
  },

  // Database
  database: {
    /**
     * The connection string the hub actually runs on. Everything that talks to
     * Postgres reads DATABASE_URL; this is here so the rules in
     * validate-config.ts can inspect the same value rather than a neighbour.
     */
    url: getEnv('DATABASE_URL', ''),
    /**
     * @deprecated Pre-pivot SQLite path. Read only by `src/db/index.ts`, which
     * is itself deprecated and imported by nothing. Do not add readers, and do
     * not write a rule against it: a production guard that inspected this
     * instead of `url` is issue #321, and it silently never fired.
     */
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
  // `https://app.agentpod.dev` was here as the "transitional" origin of the first,
  // VPS-served console. Retired 2026-09-17: nothing has served a console there since
  // the vhost was removed, and a trusted origin nobody operates is one somebody else
  // could. See SuperJackfruitLabs/estate#2.
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

/**
 * The hub's own URL (`MANAGEMENT_API_PUBLIC_URL`). Under the org plane the hub's audience is
 * `ORG_PLANE_AUDIENCE`; this is kept only so `WORK_PLANE_AUDIENCES` below can drop an entry that
 * names the hub's own URL (`routes/station-token.ts`, `stationAudiences`).
 */
export const HUB_AUDIENCE = config.publicUrl;

/**
 * The planes a STATION token may be spent at, beyond the hub itself: `WORK_PLANE_AUDIENCES`,
 * comma-separated, empty by default. The first entry is the hub's URL; `stationAudiences` in
 * `routes/station-token.ts` swaps it for the plane's audience and sends the rest to the plane's
 * `POST /api/token/agent` (contract §3.4).
 *
 * **Why configuration and not a request parameter.** The node asks for a token; it does not get to
 * say where the token may be spent. A node that could name its own audiences could get credentials
 * for any plane it liked.
 */
export const STATION_TOKEN_AUDIENCES: string[] = [
  HUB_AUDIENCE,
  ...getEnv('WORK_PLANE_AUDIENCES', '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '' && a !== HUB_AUDIENCE),
];
