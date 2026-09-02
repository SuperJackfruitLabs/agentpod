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
    // Whether this hub claims work from a kaambaan board at all. The bridge's
    // own `isBridgeEnabled()` remains the authority at runtime (it requires the
    // literal string "true", like isProviderEnabled); this copy exists so
    // validate-config can scope its rule the way it scopes the provisioner
    // ones — a hub that never claims must not be stopped from booting by a
    // bridge variable. Off, and never inferred from a token being present.
    enabled: getEnvBool('ENABLE_KAAMBAAN_BRIDGE', false),
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

// ─── The OAuth client registry (who may RECEIVE a token) ─────────────────────

/**
 * A plane that may be handed a hub token by the cross-domain authorize flow.
 *
 * This is deliberately NOT `allowedOrigins`. They answer different questions:
 * `allowedOrigins` says who may *call* the hub from a browser (CORS / CSRF /
 * CSWSH), while this says who may *be handed a credential* for whoever is
 * signed in. Being permitted to make a request must not by itself confer the
 * right to receive a token, so the two lists are separate and this one is
 * empty until a deployment opts in.
 */
export interface OAuthClient {
  /** Registry key, named in the `client` query param. */
  id: string;
  /** Exact redirect URIs. Full-string compare — no prefix, no origin matching. */
  redirectUris: string[];
}

/**
 * Parse `HUB_OAUTH_CLIENTS`:
 *
 *   kaambaan|https://kaambaan.dev/hub/callback,supermessage|https://…
 *
 * Several URIs for one client: repeat the client key.
 *
 * Exported because `oauthClients` below is computed at module scope and cannot
 * be re-derived after import — the same reason `sessionCookieOptions` takes an
 * env rather than reading `process.env` directly.
 *
 * A malformed entry is SKIPPED, never thrown: this runs at module scope, so a
 * typo in an operator's env file would otherwise be a raw stack trace out of an
 * import that stops the hub booting entirely — for a feature it may not even
 * use. Skipping is safe in the direction that matters: an entry that does not
 * parse is simply not in the registry, and authorize refuses what it cannot
 * find. It never widens anything.
 */
export function parseOAuthClients(raw: string | undefined): OAuthClient[] {
  const byId = new Map<string, OAuthClient>();
  for (const entry of (raw ?? '').split(',')) {
    if (!entry.trim()) continue;
    const parts = entry.split('|');
    // Exactly one separator. "too|many|pipes" is ambiguous about where the id
    // ends, and guessing is how a wrong destination gets registered.
    if (parts.length !== 2) continue;
    const id = parts[0]!.trim();
    const redirectUri = parts[1]!.trim();
    if (!id || !redirectUri) continue;
    const existing = byId.get(id);
    if (existing) {
      if (!existing.redirectUris.includes(redirectUri)) {
        existing.redirectUris.push(redirectUri);
      }
    } else {
      byId.set(id, { id, redirectUris: [redirectUri] });
    }
  }
  return [...byId.values()];
}

/**
 * Empty when HUB_OAUTH_CLIENTS is unset: a hub that has not opted in refuses
 * every authorize, which is the right posture for a deployment that never
 * asked for this door.
 */
export const oauthClients: OAuthClient[] = parseOAuthClients(process.env.HUB_OAUTH_CLIENTS);

/**
 * Look up a registered client by its exact id. `registry` exists for tests;
 * callers pass the id alone and get the hub's own registry.
 */
export function findOAuthClient(
  id: string | null | undefined,
  registry: readonly OAuthClient[] = oauthClients,
): OAuthClient | null {
  if (!id) return null;
  return registry.find((client) => client.id === id) ?? null;
}

/**
 * True only for an EXACT match against that client's registered URIs.
 *
 * Full-string equality, on purpose. Prefix or origin matching is how an
 * authorize endpoint becomes an open redirector that mints credentials:
 * `https://k.dev/hub/callback/../../evil` shares an origin and a prefix with
 * the registered URI and is not it.
 */
export function isRegisteredRedirect(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

/**
 * Where a browser with no hub session is sent to get one, before it can be
 * asked to authorize anything.
 *
 * The hub serves no sign-in page of its own — Better Auth's `/api/auth/*`
 * routes are an API, not a UI — so this names the console that does. It is a
 * setting rather than a derivation from `allowedOrigins` because that list is
 * an allowlist of many origins with no notion of which one a person signs in
 * at, and picking one out of it by position is how a hub ends up sending its
 * operators to a Vite dev server.
 *
 * The default is the production console, which shares the session cookie's
 * `.agentpod.dev` domain — signing in there is what makes the hub's own
 * first-party cookie exist. A hub deployed anywhere else sets HUB_SIGN_IN_URL.
 *
 * Nothing the caller sends reaches this value: it is config, so the no-session
 * redirect can never be steered by a query parameter. That matters because it
 * is the one redirect `GET /api/auth/authorize` will perform for a caller it
 * has not yet authenticated.
 */
export const signInUrl = getEnv('HUB_SIGN_IN_URL', 'https://console.agentpod.dev/login');
