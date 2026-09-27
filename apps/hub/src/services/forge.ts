/**
 * An agent's git identity on forge.
 *
 * `charter → decisions/2026-09-27-which-side-is-primary-is-a-repositorys-property.md` makes
 * `super-jackfruit-website` forge-primary, so an agent that writes code needs a **forge account**,
 * not a GitHub one. `estate → docs/2026-09-21-forge.md` §7 settled the shape: one account per
 * agent, its own token, "so a leak or a runaway is attributable and revocable on its own. A shared
 * bot account undoes that."
 *
 * The hub holds a forge **admin** token and provisions from it. That is a real privilege — it can
 * create any account and mint any token — and it is what makes onboarding the next agent a call
 * rather than an afternoon.
 *
 * **Forgejo tokens do not expire.** A GitHub App installation token lives an hour, which is what
 * makes minting per operation natural there; here a token lives until revoked, so minting per
 * operation would leave a live credential behind every turn that crashed mid-flight. Mint one per
 * station, store it encrypted, and revoke by name.
 *
 * Every quirk handled below was met against the live instance (Forgejo 16.0.5) rather than read
 * from documentation, and each is noted where it bites.
 */
import { createLogger } from "../utils/logger";

const log = createLogger("forge");

/**
 * The domain an agent's identity already lives in.
 *
 * Agents are `@agent_…:id.agentpod.dev` in Matrix (`services/matrix-as/names.ts`). Giving the
 * forge account a different domain would split one principal across two namespaces, which is the
 * thing `charter → decisions/2026-08-30-an-agent-is-a-principal.md` exists to prevent. The local
 * part is the agent's plain name rather than the MXID's full localpart, because this string's
 * main audience is `git log`.
 */
const AGENT_EMAIL_DOMAIN = "id.agentpod.dev";

export function agentEmail(username: string): string {
  return `${username}@${AGENT_EMAIL_DOMAIN}`;
}

export interface ForgeConfig {
  /** No trailing slash. */
  baseUrl: string;
  adminToken: string;
}

export interface ForgeUser {
  id: number;
  login: string;
  email: string;
}

export interface MintedToken {
  id: number;
  name: string;
  token: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface CallResult {
  status: number;
  body: unknown;
}

async function call(
  cfg: ForgeConfig,
  method: string,
  path: string,
  fetchImpl: FetchLike,
  body?: unknown,
): Promise<CallResult> {
  const res = await fetchImpl(`${cfg.baseUrl}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `token ${cfg.adminToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  // 204 carries nothing; parsing it would throw on an empty body.
  if (res.status === 204) return { status: 204, body: null };
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: res.status, body: null };
  }
}

/**
 * Fails with the status and never the body.
 *
 * forge answers a rejected request with `{"message":"%!s(<nil>)"}` — a Go format string printing a
 * nil error — so the body carries no information about what was wrong. Worse, other endpoints echo
 * what was sent, and what was sent here can include a password.
 */
function refuse(what: string, status: number): never {
  throw new Error(`forge: ${what} was refused (HTTP ${status}).`);
}

/**
 * The account, created if it is not already there.
 *
 * Idempotent because onboarding is re-run: a second agent on the same station, a hub restart mid
 * provision, an operator making sure. Creating twice is an error from forge and a confusing one.
 */
export async function ensureAgentUser(
  cfg: ForgeConfig,
  username: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ user: ForgeUser; created: boolean }> {
  const existing = await call(cfg, "GET", `/users/${encodeURIComponent(username)}`, fetchImpl);
  if (existing.status === 200) {
    return { user: existing.body as ForgeUser, created: false };
  }
  if (existing.status !== 404) refuse(`reading the account ${username}`, existing.status);

  // A password is required although `CreateUserOption` marks it optional — forge answers
  // `PasswordIsRequired` without one. It is generated, used once, and never returned: the account
  // authenticates by token, and an admin resets the password if one is ever needed.
  const password = crypto.randomUUID() + crypto.randomUUID();

  const created = await call(cfg, "POST", "/admin/users", fetchImpl, {
    username,
    email: agentEmail(username),
    full_name: `${username} (agent)`,
    password,
    must_change_password: false,
    // An agent has nowhere to read mail, and a bounce per notification helps nobody.
    send_notify: false,
    visibility: "private",
  });
  if (created.status !== 201 && created.status !== 200) {
    refuse(`creating the account ${username}`, created.status);
  }

  log.info("forge account created", { username });
  return { user: created.body as ForgeUser, created: true };
}

export interface MintOptions {
  /** Names the token so it can be revoked on its own. One per station. */
  name: string;
  /** `owner/repo` entries. Omitted means every repository the account can reach. */
  repositories?: string[];
}

/**
 * Mint a token for one station.
 *
 * Returned exactly once — forge does not show it again — so a caller that does not store it has
 * lost it and must revoke and mint afresh.
 */
export async function mintAgentToken(
  cfg: ForgeConfig,
  username: string,
  opts: MintOptions,
  fetchImpl: FetchLike = fetch,
): Promise<MintedToken> {
  const res = await call(cfg, "POST", `/admin/users/${encodeURIComponent(username)}/tokens`, fetchImpl, {
    name: opts.name,
    // Enough to clone, commit and push. Not `write:user`, not `write:admin`: an agent that can
    // edit accounts is an agent that can grant itself more.
    scopes: ["write:repository"],
    ...(opts.repositories ? { repositories: opts.repositories } : {}),
  });

  if (res.status !== 201 && res.status !== 200) {
    refuse(`minting a token for ${username}`, res.status);
  }

  // **`sha1`, not `token`.** Gitea's field name, kept by Forgejo. A reader expecting `token` gets
  // `undefined` and hands an empty credential onward, which then fails at `git push` with an
  // authentication error that names nothing useful.
  const body = res.body as { id?: unknown; name?: unknown; sha1?: unknown };
  if (typeof body?.sha1 !== "string" || body.sha1.trim() === "") {
    throw new Error(`forge: the mint for ${username} returned no token.`);
  }

  log.info("forge token minted", { username, name: opts.name, repositories: opts.repositories?.length ?? 0 });
  return {
    id: typeof body.id === "number" ? body.id : 0,
    name: typeof body.name === "string" ? body.name : opts.name,
    token: body.sha1,
  };
}

/** Withdraw one station's credential without touching the agent's other stations. */
export async function revokeAgentToken(
  cfg: ForgeConfig,
  username: string,
  tokenName: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const res = await call(
    cfg,
    "DELETE",
    `/admin/users/${encodeURIComponent(username)}/tokens/${encodeURIComponent(tokenName)}`,
    fetchImpl,
  );
  // 404 is success for a revoke: the credential is not there, which is the end state asked for.
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
    refuse(`revoking ${tokenName} for ${username}`, res.status);
  }
  log.info("forge token revoked", { username, name: tokenName });
}

export interface RegisteredKey {
  /** forge's numeric key id — the handle revocation needs. */
  id: number;
  title: string;
}

/**
 * Register a public key on an agent's account.
 *
 * The private half is generated on the node and never leaves it, which is why nothing here takes
 * or returns a secret. forge's own push mirror works the same way: it generated its keypair and
 * handed us only the public half.
 *
 * `read_only: false` — the key is for pushing. A read-only key would clone and then fail at the
 * push, which is the least useful place to discover a permission.
 */
export async function addAgentKey(
  cfg: ForgeConfig,
  username: string,
  title: string,
  publicKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<RegisteredKey> {
  const res = await call(cfg, "POST", `/admin/users/${encodeURIComponent(username)}/keys`, fetchImpl, {
    title,
    key: publicKey.trim(),
    read_only: false,
  });
  if (res.status !== 201 && res.status !== 200) {
    refuse(`registering a key for ${username}`, res.status);
  }
  const body = res.body as { id?: unknown; title?: unknown };
  if (typeof body?.id !== "number") {
    // Without the id there is no way to revoke this key later, and forge does not let us search
    // for it by content. Failing here beats registering a key nobody can withdraw.
    throw new Error(`forge: the key registered for ${username} came back without an id.`);
  }
  log.info("forge key registered", { username, title, keyId: body.id });
  return { id: body.id, title: typeof body.title === "string" ? body.title : title };
}

/** Withdraw one key by the id `addAgentKey` returned. 404 is success: the end state is asked for. */
export async function deleteAgentKey(
  cfg: ForgeConfig,
  username: string,
  keyId: number,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const res = await call(
    cfg,
    "DELETE",
    `/admin/users/${encodeURIComponent(username)}/keys/${keyId}`,
    fetchImpl,
  );
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
    refuse(`deleting key ${keyId} for ${username}`, res.status);
  }
  log.info("forge key deleted", { username, keyId });
}
