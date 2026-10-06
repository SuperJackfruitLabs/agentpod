# P3: AgentPod as an org-plane consumer — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AgentPod hub, console and `apn`/`fleet` CLI consume the organization plane (verify its tokens, ask it for agent tokens, resolve principals through it, sign in through it), all behind the `ORG_PLANE_*` settings, so production keeps behaving exactly as today until P4 sets them.

**Architecture:** One configuration module (`apps/hub/src/auth/org-plane/config.ts`) decides the mode at boot. When it is `null` (production today), every code path below is the existing one, byte for byte. When it is set, the hub verifies EdDSA tokens against the plane's JWKS, maps `org` to a local tenant, mints nothing, and reaches the plane through one HTTP client that authenticates with the hub's own `svc_` credential. The `user.id` → `prn_` column rewrite is a rehearsable operator script (dry run by default, reversible), run by P4 at cutover — never an auto-applied migration, because the hub applies migrations on boot and would rewrite production while it still trusts Better Auth.

**Tech Stack:** Bun 1.4.2 + Hono + Drizzle/Postgres (hub), `jose` ^6 (already a hub dependency), zod 4 (`packages/contract`), SvelteKit `adapter-static` + Svelte 5 + vitest (console), Go 1.26 standard library (`apps/node-agent`).

**Spec:** `accounts/docs/superpowers/specs/2026-10-06-issuer-contract.md` (authoritative; §4 lists the AgentPod changes) and `accounts/docs/superpowers/specs/2026-10-06-organization-plane-design.md` §§2, 5, 8, 9. Both are on `SuperJackfruitLabs/accounts` `main`. When the two disagree, the contract wins.

## Global Constraints

Copied from the contract and design; every task implicitly includes these.

- `ORG_PLANE_ISSUER` — exact `iss`; "A single string; never a prefix match."
- `ORG_PLANE_JWKS_URL` — "Cache ≤ 10 min, refetch on unknown `kid`, serve the last good set when unreachable, EdDSA only."
- `ORG_PLANE_AUDIENCE` — AgentPod hub's audience is `https://hub.agentpod.dev`. `aud` "A **string or an array**. Accept if it equals, or contains, `ORG_PLANE_AUDIENCE`."
- `ORG_PLANE_URL` — base for the plane's APIs; "Products must not hard-code anything below except the claim names. Every URL is configuration."
- New for this repo: `ORG_PLANE_SERVICE_CREDENTIAL_FILE` — a file holding the hub's `svc_<20 hex>:<secret>`; sent as `Authorization: Bearer <id>:<secret>`.
- **Cutover rule:** "The `ORG_PLANE_*` settings are absent, and the product behaves exactly as today. Setting them switches the product to the plane. There is no dual-accept." All four of `ORG_PLANE_ISSUER`, `_JWKS_URL`, `_AUDIENCE`, `_URL` plus the credential file are set together or not at all; a partial set refuses to boot.
- Token lifetime: "`exp - iat` = 300 seconds". `jti` always present.
- `tenant` claim is removed. "Products map `org` to their local tenant through `external_source = 'org-plane'`, `external_id = <org_ id>`."
- Entitlement refusal is exactly `403` with body `{ "error": "product_not_enabled", "org": "<org_ id>" }` — "It never sends a bare 403." The product key is `agentpod`.
- First sight: "A valid token whose `org` has no local tenant, and whose `ent` contains the product, creates the tenant mapped to that `org`. The product never calls the plane to do this."
- Grant scopes are read "only from tokens whose `principalKind` is `agent` or `service`".
- `amr` is "Absent on OAuth tokens"; never required.
- Agent token: `POST /api/token/agent { principal, audience }` with the hub's `svc_`; errors `403 not_permitted`, `404 unknown_principal`, `423 suspended`.
- Console: OAuth 2.1 authorization code + PKCE S256, `client_id` `agentpod-console`, redirect `https://console.agentpod.dev/auth/callback`, token request "**must** carry `resource=<audience>`".
- CLI: `POST /api/auth/device/code { client_id: "apn", scope: "openid" }`; `POST /api/auth/device/token` → `{ "device_credential": "dev_<20 hex>:<43 base64url>" }` ("**not** an RFC 8628 token response"); `POST /api/token/device { audience }` with `Bearer dev_…:<secret>` → `{ access_token, token_type: "Bearer", expires_in: 300 }`.
- Design §5.7: "No authorization path calls the plane. The one named exception is resolving an inbound Matrix sender to a principal for gate approvals."
- Design §8: "Rollback. Switch the issuer settings back. The hub's auth tables stay, read-only, for 7 days, then are dropped."
- Repo rules: TDD (failing test first), every guard revert-proofed; required CI checks `contract`, `hub`, `node-agent`, `console`, `worker` stay green on every task; conventional commits scoped by area (`feat(hub): …`); hub tests run with `DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod"`; never sleep for a barrier in hub tests; never put a deployment's local names ("guild", agent names) in shipped code.

## Review Focus

The five inputs the spec implies, that no task's happy-path test would naturally hit, most likely first. Each has a pinned test in the owning task.

1. **The plane is unreachable while a valid token is presented.** Expected: the hub still admits the caller from the last good JWKS (design §9 "Offline"). Pinned in Task 3 (`serves the last good key set when the plane is down`).
2. **A `prn_` that the rewrite could not map** (a `user_id` with no `better-auth` identity row — `DEFAULT_USER_ID`'s `default-user` is the known one). Expected: the dry run names it and `--apply` refuses to run rather than leaving a half-rewritten fleet. Pinned in Task 13 (`refuses to apply while any value is unmapped`).
3. **A token whose `aud` is an array that contains the hub among others** (the plane signs arrays for multi-resource grants). Expected: accepted; an array that omits the hub is refused. Pinned in Task 3.
4. **A token for an org whose `ent` lacks `agentpod`.** Expected: 403 `product_not_enabled` with the org, never a bare 403 and never a tenant created. Pinned in Task 4.
5. **A console tab left open past the 5-minute token life, then a WebSocket opened (terminal, ACP).** Expected: the console refreshes before opening the socket and the socket carries the fresh token. Pinned in Task 15 (`opens the terminal socket with a token fresh enough to last`).

## Decisions this plan makes (and why)

- **D1 — The rewrite is a script, not a migration.** `apps/hub/src/db/drizzle.ts:165-180` runs every pending migration on boot. A migration that rewrote `user_id` to `prn_` would run in production while `ORG_PLANE_*` is unset and every session still carries a Better Auth id; the fleet would vanish from every operator's console. The FK drop rides in the same script and transaction for a second reason: 81 hub test files clean up by deleting a `user` row and relying on `ON DELETE CASCADE` (`grep -rln 'delete(user)\|DELETE FROM "user"' apps/hub/{src,tests,scripts}`), so dropping the FKs in a migration would leak rows across the whole suite. The drizzle schema keeps its `.references(() => user.id)` until Task 17.
- **D2 — The rewrite is reversible.** Rollback (design §8) means switching the issuer back, and a hub that trusts Better Auth again needs `user.id` values again. The script takes `--reverse`; it re-adds the FKs as `NOT VALID` so rows created by plane-only humans during the window do not block the rollback.
- **D3 — Grant and principal admin routes are retired under the plane, not proxied.** Contract §3.5: "A human with the `agent:create` or `grant:create` permission does the same through the plane's pages." Proxying `PUT /api/admin/grants/:id` through the hub's `svc_` would record the hub service, not the human, as the actor in the plane's audit log, and would hand every hub admin org-wide `grants:write`. The hub keeps exactly the writes it needs to place an agent (Task 11): create the agent principal, link its Matrix id, and append it to the placing human's `mayDispatch`. `GET /api/admin/principals` stays, as a read through the plane, because the console's agents page and `fleet.svelte.ts:127` need it. `/api/admin/users*`, `/api/admin/settings/signup*`, `/api/admin/service-principals*`, `/api/admin/grants*` (all methods) and `/api/admin/principals/:id/{suspend,restore}` answer `410 { error: "managed_by_org_plane", url }` under the plane.
- **D4 — "Admin" becomes a hub-local list of operator principals.** `isUserAdmin` reads `user.role` (`apps/hub/src/models/admin-users.ts:342-349`), and the plane's token carries no role. A new `hub_operators(principal_id)` table, seeded by the rewrite script from `user.role = 'admin'`, answers `isUserAdmin` under the plane. It is AgentPod's own seat, like Superpipeline's (design §4 "Product seats … stay in each product").
- **D5 — A discovery route, not build-time configuration, tells the console and the CLI which issuer to use.** `GET /public/org-plane` answers `{ issuer: null }` today and `{ issuer, url, audience }` under the plane. The console is a static build (`apps/console/src/routes/+layout.ts:2-3`) shipped independently of the hub, and `fleet` already resolves everything from the hub URL (`apps/node-agent/cmd/agentpod-fleet/fleet.go:35-40`); asking the hub keeps both from needing a rebuild or a new environment variable at cutover.

## Contract points this plan relies on

AgentPod's first draft of this plan found five gaps. Contract commit `cbc3098` on `accounts` `main` closed four of them; the fifth is a property of the design that the hub works around.

- **Human assertion (was G1) — contract §3.4b.** `POST /api/token/assertion { identity: { system: "matrix", externalId }, audience }` with the hub's `svc_`, scope `token:assert`. The plane resolves the human from the linked identity itself (it never takes a caller-supplied `prn_`), requires a human member of the hub's workspace who is not suspended, and signs `sub` = the human, `act.sub` = the hub's service principal, `amr: ["assertion"]`, 120 s. Errors `403 not_permitted`, `404 unknown_identity`, `409 not_human`, `423 suspended`. This replaces `mintPrincipalAssertion` (`apps/hub/src/auth/service-signing.ts:241-250`) in Task 10.
- **Principal reads (was G2/G3) — contract §3.5.** `GET /api/principals/:id` → `{ id, kind, handle, displayName, organizationId, suspended, grant: { mayDispatch, mayGrantReach, scopes } }`, and `GET /api/principals?kind=agent|service|human` lists the caller's workspace (humans = its members) in the same shape, unpaged below 500. Both need `principals:read`. No email in either: under the plane the hub never needs a principal's email (it only fed the hub's own token minting).
- **Several audiences (was G4) — contract §3.4.** `POST /api/token/agent` takes `audience` as a string or an array. Task 7 sends the hub plus any `WORK_PLANE_AUDIENCES`.
- **Migrated humans' ids — contract §2 "Migrated humans (P4)".** At import the plane re-keys each migrated human's `user.id` to their existing `prn_` (the value `principal_identities (system = 'better-auth')` maps the old id to). So OAuth `sub` is a `prn_` for everyone, and Task 13's rewrite maps every old user id to that same `prn_`.
- **Other clients may hold hub tokens — contract §3.1.** `superpipeline-web` may request the hub resource (for its assignee picker's `/api/fleet/dispatchable`). The hub ignores `client_id`/`azp` and accepts any valid human token for its audience, so Task 5 needs no client allowlist; Task 5 pins this with a test.
- **The `act` claim names the hub, not the node (G5, still open by design).** Today a station token's `act.sub` is the node id (`station-token.ts:126`), which bounds a compromised node's blast radius in the record. The plane sets `act.sub` to the hub's service principal. The hub logs `{ nodeId, stationId, principal, jti }` for every exchange in Task 7 so the attribution survives in the hub's own log.

## Hub `user.id` column inventory

Enumerated from a freshly migrated database (all 97 migrations at `origin/main` 1408efe8 applied to an empty pgvector database), not from memory:

```sql
SELECT c.conrelid::regclass, a.attname, c.conname, c.confdeltype
FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
WHERE c.contype='f' AND c.confrelid='public."user"'::regclass ORDER BY 1;
```

**21 foreign-key columns reference `user.id`.** 18 are product columns the rewrite changes; 3 belong to auth tables that are dropped, not rewritten:

| # | Column | Constraint | On delete | Rewritten |
|---|---|---|---|---|
| 1 | `admin_audit_log.admin_user_id` | `admin_audit_log_admin_user_id_user_id_fk` | set null | yes |
| 2 | `admin_audit_log.target_user_id` | `admin_audit_log_target_user_id_user_id_fk` | set null | yes |
| 3 | `agent_tasks.user_id` | `agent_tasks_user_id_user_id_fk` | cascade | yes |
| 4 | `bridge_agents.created_by` | `bridge_agents_created_by_user_id_fk` | set null | yes |
| 5 | `cloudflare_sandboxes.user_id` | `cloudflare_sandboxes_user_id_user_id_fk` | cascade | yes |
| 6 | `enrollment_tokens.user_id` | `enrollment_tokens_user_id_user_id_fk` | cascade | yes |
| 7 | `matrix_missions.user_id` | `matrix_missions_user_id_fkey` | cascade | yes |
| 8 | `nodes.user_id` | `nodes_user_id_user_id_fk` | cascade | yes |
| 9 | `provisioned_runtimes.user_id` | `provisioned_runtimes_user_id_user_id_fk` | cascade | yes |
| 10 | `skill_artifacts.user_id` | `skill_artifacts_user_id_user_id_fk` | cascade | yes |
| 11 | `skill_operations.user_id` | `skill_operations_user_id_user_id_fk` | cascade | yes |
| 12 | `skill_release_cohorts.user_id` | `skill_release_cohorts_user_id_user_id_fk` | cascade | yes |
| 13 | `station_setups.user_id` | `station_setups_user_id_user_id_fk` | cascade | yes |
| 14 | `station_speech.updated_by` | `station_speech_updated_by_user_id_fk` | set null | yes |
| 15 | `station_transcription.updated_by` | `station_transcription_updated_by_user_id_fk` | set null | yes |
| 16 | `stations.user_id` | `stations_user_id_user_id_fk` | cascade | yes |
| 17 | `system_settings.updated_by` | `system_settings_updated_by_user_id_fk` | set null | yes |
| 18 | `trusted_skill_releases.user_id` | `trusted_skill_releases_user_id_user_id_fk` | cascade | yes |
| 19 | `account.user_id` | `account_user_id_user_id_fk` | cascade | no — Better Auth, dropped in Task 17 |
| 20 | `session.user_id` | `session_user_id_user_id_fk` | cascade | no — Better Auth, dropped in Task 17 |
| 21 | `device_credentials.user_id` | `device_credentials_user_id_user_id_fk` | cascade | no — hub credential table, dropped in Task 17 |

**5 more columns hold a `user.id` with no foreign key** (found by `information_schema.columns` and checked against their writers) and are rewritten too:

| Column | Written from |
|---|---|
| `acp_sessions.user_id` | `apps/hub/src/db/schema/acp.ts:50`; `services/acp-sessions.ts` |
| `station_audit.user_id` | `apps/hub/src/db/schema/audit.ts:19`; `services/audit.ts:109` |
| `trusted_skill_release_artifacts.user_id` | `apps/hub/src/db/schema/skills.ts:86` (part of two composite owner FKs) |
| `declared_harness_config.declared_by` | `routes/harness-config.ts:497` (`declaredBy: user.id`) |
| `harness_config_opt_out.opted_out_by` | `routes/harness-config.ts:577` (`optedOutBy: user.id`) |

**Deliberately not rewritten:** `live_activity_tokens.user_id` holds a Matrix id (`apps/hub/src/db/schema/live-activity.ts:12`: "`user_id` is the Matrix id the homeserver's `whoami` returned"); `oauth_codes.user_id` is a 60-second auth row dropped in Task 17; every `principal_id`-named column (`stations`, `station_setups`, `matrix_rooms`, `acp_runs.agent_principal_id`, `principal_*`) already holds `prn_` ids, which the move preserves (design §8 step 3).

**Six composite "owner" foreign keys include `user_id`** and block an in-place rewrite (they are `NOT DEFERRABLE`): `skill_operations_artifact_owner_fk`, `skill_operations_station_owner_fk`, `skill_release_cohorts_release_owner_fk`, `station_setups_owner_fk`, `trusted_skill_release_artifacts_artifact_owner_fk`, `trusted_skill_release_artifacts_release_owner_fk`. The script captures their definitions with `pg_get_constraintdef`, drops them, rewrites, and re-creates them, inside the one transaction.

Total rewritten: **23 columns** (18 FK + 5 non-FK).

## File structure

Hub (`apps/hub/`):

| File | Responsibility | Task |
|---|---|---|
| `src/auth/org-plane/config.ts` (new) | Read and validate `ORG_PLANE_*`; the mode switch | 1 |
| `src/routes/org-plane-discovery.ts` (new) | `GET /public/org-plane` | 1 |
| `src/auth/org-plane/verify.ts` (new) | JWKS cache + EdDSA verification + claim parsing | 3 |
| `src/auth/org-plane/tenant.ts` (new) | `org` → tenant, first sight, `ent` check | 4 |
| `src/auth/hub-token.ts` | `verifyBearer`: one switch for every verifying door | 5 |
| `src/auth/middleware.ts` | Plane branch of `authMiddleware` | 5 |
| `src/mcp/auth.ts`, `src/routes/evidence.ts`, `src/routes/fleet-dispatchable.ts` | Use `verifyBearer` | 5 |
| `src/services/org-plane/client.ts` (new) | The one HTTP client to the plane | 6 |
| `src/routes/station-token.ts` | Agent tokens from the plane | 7 |
| `src/auth/org-plane/retired.ts` (new), `src/index.ts` | 410 for the hub's issuer routes under the plane | 8 |
| `src/services/org-plane/directory.ts` (new), `src/services/principals.ts`, `src/services/grants.ts` | Principal/grant reads through the plane, cached | 9 |
| `src/services/matrix-identity.ts`, `src/services/matrix-as/gates.ts`, `elicitations.ts` | Matrix sender via `GET /api/identities/matrix/:mxid` | 9 |
| `src/routes/evidence.ts`, `src/db/schema/legacy-user-principals.ts` (new), `0093_legacy_user_principals.sql` (new) | Superwitness's `GET /api/evidence/principals/:id` backed by the plane; permanent user→principal map | 9 |
| `src/auth/service-signing.ts`, `src/services/matrix-as/index.ts` | Gate assertions under the plane | 10 |
| `src/routes/station-setup.ts`, `src/routes/agents-admin.ts` | Agent principal creation through the plane | 11 |
| `src/db/schema/operators.ts` (new), `src/db/drizzle-migrations/0094_hub_operators.sql` (new), `src/models/admin-users.ts`, `src/routes/admin.ts`, `src/routes/me.ts` (new) | Operator seat; retired admin routes | 12 |
| `scripts/rewrite-user-ids.ts` (new) | The rehearsable rewrite | 13 |
| `src/db/drizzle-migrations/0095_drop_hub_auth.sql` (new, Task 17) | Cleanup after the rollback window | 17 |

Contract: `packages/contract/src/token-claims.ts` (new), `fixtures/ecosystem-identity/token_claims.json` (v7 → v8), `apps/hub/src/auth/testdata/token_claims.v7.json` (frozen copy) — Task 2.

Console (`apps/console/src/`): `lib/auth/pkce.ts` (new), `lib/auth/org-plane.svelte.ts` (new), `routes/auth/callback/+page.svelte` (new), `lib/stores/auth.svelte.ts`, `routes/login/+page.svelte`, `routes/+layout.svelte` — Task 14; `lib/api/client.ts`, `lib/api/admin.ts`, `lib/api/acp.ts`, `lib/api/terminal.ts`, `lib/api/speech.ts`, `lib/components/stations/LogTail.svelte`, `lib/api/my-grant.ts` — Task 15.

CLI (`apps/node-agent/`): `internal/fleetcred/plane.go` (new), `internal/fleetcred/device.go`, `cmd/agentpod-fleet/fleet_login_plane.go` (new), `cmd/agentpod-fleet/fleet_login.go` — Task 16.

## Task order and shippability

Tasks 1–8 depend only on the contract's verification and agent-token sections. Tasks 9–11 use the §3.4b and §3.5 endpoints; every plane call is in `services/org-plane/client.ts`, so a shape change is one file. Task 13 can run in parallel with 9–12. Tasks 14–16 need only Task 1's discovery route. Task 17 is written and merged **only after P4 + 7 days**.

Every task keeps production identical while `ORG_PLANE_*` is unset; each task's tests include a "legacy mode unchanged" case.

---

### Task 1: The mode switch — `ORG_PLANE_*` configuration and discovery

**Files:**
- Create: `apps/hub/src/auth/org-plane/config.ts`
- Create: `apps/hub/src/auth/org-plane/config.test.ts`
- Create: `apps/hub/src/routes/org-plane-discovery.ts`
- Create: `apps/hub/src/routes/org-plane-discovery.test.ts`
- Modify: `apps/hub/src/utils/validate-config.ts:158-162` (signature of `collectConfigErrors`) and its body's `return errors` (append plane errors)
- Modify: `apps/hub/src/index.ts:164-165` (mount discovery beside `/public/nodes`)
- Modify: `docs/DEPLOYMENT.md` (new "Organization plane" subsection listing the five variables)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ServiceCredential { id: string; secret: string }`
  - `interface OrgPlaneConfig { issuer: string; jwksUrl: string; audience: string; url: string; serviceCredential: ServiceCredential }`
  - `type OrgPlaneConfigResult = { ok: true; config: OrgPlaneConfig | null } | { ok: false; errors: { field: string; message: string }[] }`
  - `readOrgPlaneConfig(env: Record<string, string | undefined>, readFile?: (path: string) => string): OrgPlaneConfigResult`
  - `orgPlane(): OrgPlaneConfig | null` — the mode switch every later task calls.
  - `orgPlaneConfigErrors(): { field: string; message: string }[]`
  - `setOrgPlaneForTests(c: OrgPlaneConfig | null): () => void` — returns a restore function.
  - `createOrgPlaneDiscoveryRoutes(read?: () => OrgPlaneConfig | null): Hono` — `GET /org-plane` under `/public`.
  - Test helper exported from `config.ts`: `TEST_PLANE: OrgPlaneConfig` (issuer `https://accounts.test`, audience `https://hub.test`, url `https://accounts.test`, jwksUrl `https://accounts.test/api/auth/jwks`, credential `svc_0123456789abcdef0123` / `s3cret`).

- [ ] **Step 1: Write the failing test**

`apps/hub/src/auth/org-plane/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readOrgPlaneConfig } from "./config";

const FULL = {
  ORG_PLANE_ISSUER: "https://accounts.superjackfruit.com",
  ORG_PLANE_JWKS_URL: "https://accounts.superjackfruit.com/api/auth/jwks",
  ORG_PLANE_AUDIENCE: "https://hub.agentpod.dev",
  ORG_PLANE_URL: "https://accounts.superjackfruit.com/",
  ORG_PLANE_SERVICE_CREDENTIAL_FILE: "/run/secrets/hub-svc",
};
const file = (body: string) => () => body;

describe("readOrgPlaneConfig", () => {
  test("nothing set is the legacy mode: config null, no errors", () => {
    expect(readOrgPlaneConfig({})).toEqual({ ok: true, config: null });
  });

  test("blank values count as unset", () => {
    expect(readOrgPlaneConfig({ ORG_PLANE_ISSUER: "  " })).toEqual({ ok: true, config: null });
  });

  test("all five set yields the config, the issuer kept exactly as written", () => {
    const r = readOrgPlaneConfig(FULL, file("svc_0123456789abcdef0123:abc-DEF_123\n"));
    expect(r).toEqual({
      ok: true,
      config: {
        issuer: "https://accounts.superjackfruit.com",
        jwksUrl: "https://accounts.superjackfruit.com/api/auth/jwks",
        audience: "https://hub.agentpod.dev",
        url: "https://accounts.superjackfruit.com",
        serviceCredential: { id: "svc_0123456789abcdef0123", secret: "abc-DEF_123" },
      },
    });
  });

  test("a partial set refuses to boot and names every missing variable", () => {
    const { ORG_PLANE_AUDIENCE: _a, ORG_PLANE_URL: _u, ...partial } = FULL;
    const r = readOrgPlaneConfig(partial, file("svc_0123456789abcdef0123:x"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.field).sort()).toEqual(["ORG_PLANE_AUDIENCE", "ORG_PLANE_URL"]);
  });

  test("an unreadable credential file is an error, and the error never echoes file contents", () => {
    const r = readOrgPlaneConfig(FULL, () => {
      throw new Error("ENOENT");
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.field).toBe("ORG_PLANE_SERVICE_CREDENTIAL_FILE");
  });

  test("a credential that is not svc_<20 hex>:<secret> is refused without printing it", () => {
    const r = readOrgPlaneConfig(FULL, file("dev_0123456789abcdef0123:leaky"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.errors)).not.toContain("leaky");
  });

  test("plain http is refused for a non-loopback host", () => {
    const r = readOrgPlaneConfig({ ...FULL, ORG_PLANE_JWKS_URL: "http://accounts.superjackfruit.com/jwks" }, file("svc_0123456789abcdef0123:x"));
    expect(r.ok).toBe(false);
  });
});
```

`apps/hub/src/routes/org-plane-discovery.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createOrgPlaneDiscoveryRoutes } from "./org-plane-discovery";
import { TEST_PLANE } from "../auth/org-plane/config";

describe("GET /public/org-plane", () => {
  test("legacy mode says there is no issuer", async () => {
    const app = new Hono().route("/public", createOrgPlaneDiscoveryRoutes(() => null));
    const res = await app.request("/public/org-plane");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: null });
  });

  test("plane mode names issuer, url and audience — never the credential", async () => {
    const app = new Hono().route("/public", createOrgPlaneDiscoveryRoutes(() => TEST_PLANE));
    const body = await (await app.request("/public/org-plane")).json();
    expect(body).toEqual({ issuer: TEST_PLANE.issuer, url: TEST_PLANE.url, audience: TEST_PLANE.audience });
    expect(JSON.stringify(body)).not.toContain(TEST_PLANE.serviceCredential.secret);
  });
});
```

Add to `apps/hub/src/utils/validate-config.test.ts`:

```ts
import { collectConfigErrors } from "./validate-config";
import { config } from "../config";

test("org-plane errors are fatal configuration errors", () => {
  const errors = collectConfigErrors(config, () => {}, undefined, [
    { field: "ORG_PLANE_URL", message: "missing" },
  ]);
  expect(errors).toContainEqual({ field: "ORG_PLANE_URL", message: "missing" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/auth/org-plane/config.test.ts src/routes/org-plane-discovery.test.ts src/utils/validate-config.test.ts`
Expected: FAIL — `Cannot find module './config'`, `./org-plane-discovery`; the validate-config test fails because the fourth argument is ignored.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/auth/org-plane/config.ts`:

```ts
/**
 * The organization plane's settings, and the one switch every consumer path asks.
 *
 * Absent (all five unset) is today's hub, unchanged. All five set is the plane. Anything in
 * between refuses to boot: the contract's cutover rule has no dual-accept, and a half-configured
 * hub would be exactly that.
 */
import { readFileSync } from "node:fs";

export interface ServiceCredential { id: string; secret: string }
export interface OrgPlaneConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  url: string;
  serviceCredential: ServiceCredential;
}
export interface OrgPlaneConfigError { field: string; message: string }
export type OrgPlaneConfigResult =
  | { ok: true; config: OrgPlaneConfig | null }
  | { ok: false; errors: OrgPlaneConfigError[] };

const KEYS = [
  "ORG_PLANE_ISSUER",
  "ORG_PLANE_JWKS_URL",
  "ORG_PLANE_AUDIENCE",
  "ORG_PLANE_URL",
  "ORG_PLANE_SERVICE_CREDENTIAL_FILE",
] as const;
type Key = (typeof KEYS)[number];
const URL_KEYS: Key[] = ["ORG_PLANE_ISSUER", "ORG_PLANE_JWKS_URL", "ORG_PLANE_AUDIENCE", "ORG_PLANE_URL"];
const SVC = /^(svc_[0-9a-f]{20}):(\S+)$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function readOrgPlaneConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): OrgPlaneConfigResult {
  const value = (k: Key) => (env[k] ?? "").trim();
  const present = KEYS.filter((k) => value(k) !== "");
  if (present.length === 0) return { ok: true, config: null };

  const errors: OrgPlaneConfigError[] = [];
  if (present.length !== KEYS.length) {
    for (const k of KEYS) {
      if (value(k) === "") {
        errors.push({
          field: k,
          message: `missing while ${present.join(", ")} ${present.length === 1 ? "is" : "are"} set — the org-plane settings are all-or-none`,
        });
      }
    }
    return { ok: false, errors };
  }

  for (const k of URL_KEYS) {
    try {
      const u = new URL(value(k));
      if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
        errors.push({ field: k, message: "must be https (plain http only for a loopback host)" });
      }
    } catch {
      errors.push({ field: k, message: "is not a URL" });
    }
  }

  let raw = "";
  try {
    raw = readFile(value("ORG_PLANE_SERVICE_CREDENTIAL_FILE")).trim();
  } catch {
    errors.push({ field: "ORG_PLANE_SERVICE_CREDENTIAL_FILE", message: "cannot be read" });
  }
  const m = SVC.exec(raw);
  if (raw !== "" && !m) {
    errors.push({
      field: "ORG_PLANE_SERVICE_CREDENTIAL_FILE",
      message: "must hold one line `svc_<20 hex>:<secret>`",
    });
  }
  if (errors.length > 0 || !m) return { ok: false, errors };

  return {
    ok: true,
    config: {
      // Exact, never normalised: the contract compares `iss` as a single string.
      issuer: value("ORG_PLANE_ISSUER"),
      jwksUrl: value("ORG_PLANE_JWKS_URL"),
      audience: value("ORG_PLANE_AUDIENCE"),
      url: value("ORG_PLANE_URL").replace(/\/+$/, ""),
      serviceCredential: { id: m[1]!, secret: m[2]! },
    },
  };
}

const fromEnv = readOrgPlaneConfig(process.env);
let override: OrgPlaneConfig | null | undefined;

export function orgPlaneConfigErrors(): OrgPlaneConfigError[] {
  return fromEnv.ok ? [] : fromEnv.errors;
}

/** Null in legacy mode. The ONLY question later code asks about the mode. */
export function orgPlane(): OrgPlaneConfig | null {
  if (override !== undefined) return override;
  return fromEnv.ok ? fromEnv.config : null;
}

export function setOrgPlaneForTests(c: OrgPlaneConfig | null): () => void {
  const previous = override;
  override = c;
  return () => {
    override = previous;
  };
}

export const TEST_PLANE: OrgPlaneConfig = {
  issuer: "https://accounts.test",
  jwksUrl: "https://accounts.test/api/auth/jwks",
  audience: "https://hub.test",
  url: "https://accounts.test",
  serviceCredential: { id: "svc_0123456789abcdef0123", secret: "s3cret" },
};
```

`apps/hub/src/routes/org-plane-discovery.ts`:

```ts
import { Hono } from "hono";
import { orgPlane, type OrgPlaneConfig } from "../auth/org-plane/config";

/** Tells the console and `fleet login` which issuer to use, so neither needs rebuilding at cutover. */
export function createOrgPlaneDiscoveryRoutes(read: () => OrgPlaneConfig | null = orgPlane) {
  return new Hono().get("/org-plane", (c) => {
    const p = read();
    return c.json(p ? { issuer: p.issuer, url: p.url, audience: p.audience } : { issuer: null });
  });
}
```

`apps/hub/src/utils/validate-config.ts` — add the parameter and append before `return errors;`:

```ts
import { orgPlaneConfigErrors, type OrgPlaneConfigError } from "../auth/org-plane/config";

export function collectConfigErrors(
  cfg: typeof config = config,
  warn: Warn = console.warn,
  resolveImage: ResolveImage = imageForHarness,
  planeErrors: OrgPlaneConfigError[] = orgPlaneConfigErrors(),
): ValidationError[] {
  // …existing body unchanged…
  errors.push(...planeErrors);
  return errors;
}
```

`apps/hub/src/index.ts` — after `.route('/public', nodeEnrollRoutes)` (line 164):

```ts
  .route('/public', createOrgPlaneDiscoveryRoutes())     // GET /public/org-plane
```

`docs/DEPLOYMENT.md` — add a subsection "Organization plane (P3, off until P4)" with the five variables, the all-or-none rule, and "the credential file holds one line, `svc_<20 hex>:<secret>`, mode 0600".

- [ ] **Step 4: Run the tests to verify they pass**

Run the Step 2 command. Expected: PASS. Then the whole hub suite: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test` — Expected: PASS (nothing reads the switch yet). Revert-proof: change `present.length !== KEYS.length` to `false` and watch "a partial set refuses to boot" go red; restore.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/org-plane/config.ts apps/hub/src/auth/org-plane/config.test.ts apps/hub/src/routes/org-plane-discovery.ts apps/hub/src/routes/org-plane-discovery.test.ts apps/hub/src/utils/validate-config.ts apps/hub/src/utils/validate-config.test.ts apps/hub/src/index.ts docs/DEPLOYMENT.md
git commit -m "feat(hub): ORG_PLANE_* settings, all-or-none, and /public/org-plane discovery"
```

---

### Task 2: Token-claims fixture v8 and the contract schema

**Files:**
- Modify: `fixtures/ecosystem-identity/token_claims.json` (v7 → v8)
- Create: `apps/hub/src/auth/testdata/token_claims.v7.json` (exact copy of today's v7, for the legacy issuer only)
- Modify: `apps/hub/tests/unit/jwt-issuer.test.ts:5-7` (read the frozen v7 copy)
- Modify: `apps/hub/src/auth/jwt-claims.ts:8-9,62-63` (comments: the hub's own minting is pinned by the v7 copy until Task 17)
- Create: `packages/contract/src/token-claims.ts`
- Create: `packages/contract/src/token-claims.test.ts`
- Modify: `packages/contract/src/index.ts` (add `export * from "./token-claims";`)
- Modify: `fixtures/ecosystem-identity/README.md` (Files table: add `token_claims.json`, v8)
- Modify: `apps/node-agent/internal/fleetcred/fleetcred_test.go` (Go reader of a v8-shaped payload)

**Interfaces:**
- Consumes: `OrganizationId`, `PrincipalId` from `packages/contract/src/ids.ts:141,170`.
- Produces:
  - `ORG_PLANE_PRODUCTS = ["agentpod", "superpipeline", "supermessage", "superwitness"] as const`
  - `OrgPlaneTokenClaims` (zod schema) and `type OrgPlaneTokenClaims = z.infer<…>` with fields `iss, sub, aud: string | string[], exp, iat, jti, principalKind, org, ent: string[], mayDispatch: string[], mayGrantReach: boolean, scope?, act?: { sub }, amr?: string[], email?, email_verified?`.
  - `audienceIncludes(aud: string | string[], audience: string): boolean`

Why the frozen copy: the only reader of `token_claims.json` today is `apps/hub/tests/unit/jwt-issuer.test.ts`, and it holds the hub's **own minting** (`buildTokenPayload`) to the fixture. The hub keeps minting `tenant` tokens while `ORG_PLANE_*` is unset, so it must be checked against the shape it mints (v7), while the canonical fixture moves to the plane's shape (v8). The copy is deleted with the hub's minting in Task 17. Nothing in Go or `packages/contract` reads `token_claims.json` today; this task adds the contract schema test (CI `contract` job) and a Go reader test (CI `node-agent` job) so the shape is round-tripped in both languages.

- [ ] **Step 1: Freeze v7 and edit the fixture to v8**

```bash
mkdir -p apps/hub/src/auth/testdata
git show HEAD:fixtures/ecosystem-identity/token_claims.json > apps/hub/src/auth/testdata/token_claims.v7.json
```

In `apps/hub/tests/unit/jwt-issuer.test.ts` replace lines 5-7 with:

```ts
// The hub's OWN minting, frozen at v7 (tenant, no org/ent) until Task 17 deletes it.
// The canonical fixture is v8 — the org plane's shape — and is pinned by packages/contract.
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "src", "auth", "testdata", "token_claims.v7.json"), "utf8")
) as {
```

Edit `fixtures/ecosystem-identity/token_claims.json`:
- `"version": 8`, `"authoredAt": "2026-10-06"`, prepend to `authoredFrom`: `"v8 (2026-10-06): the issuer moves to the organization plane (accounts/docs/superpowers/specs/2026-10-06-issuer-contract.md). Removed: tenant. Added: org, ent (issued), jti (standard), amr (conditional). aud may be a string or an array. "`
- In `issued[]`: replace the `sub` entry's `meaning` with `"The prn_ id of the principal acting. For a human this is also their account id."` and add `"grammar": "^prn_[0-9a-f]{20}$"`; **delete** the `tenant` entry; add after `principalKind`:

```json
{
  "claim": "org",
  "type": "string",
  "grammar": "^org_[0-9a-f]{20}$",
  "meaning": "The workspace: the active one for a human, the owning one for an agent or service. Products map it to their own tenant through external_source = 'org-plane', external_id = <org>.",
  "required": true,
  "crossRef": "id_grammar.json → agentpod.organization"
},
{
  "claim": "ent",
  "type": "string[]",
  "enum": ["agentpod", "superpipeline", "supermessage", "superwitness"],
  "meaning": "The products enabled for org. A product not listed answers 403 { error: 'product_not_enabled', org }. A consumer ignores values it does not recognise.",
  "required": true
}
```

- In `standard[]`: change the `aud` entry to `"type": "string | string[]"` and `"meaning": "Audience. A string or an array; accept if it equals, or contains, your own audience. Consumers MUST validate it."`; add `{ "claim": "jti", "type": "string", "meaning": "Unique token id." }`.
- In `reject[]`: replace `missing-tenant` with `{ "case": "missing-org", "why": "A token that verifies but names no workspace cannot be mapped to a tenant. Refuse it rather than falling back to a default boundary." }`; add `{ "case": "product-not-enabled", "why": "ent does not contain the consumer's product. Answer 403 { error: 'product_not_enabled', org } — never a bare 403." }`.
- In `conditional[]`: in `scope`'s `consumerObligation` replace "`principalKind` and `tenant`" with "`principalKind` and `org`" and append "Read grant scopes only from tokens whose principalKind is agent or service; on an OAuth authorization-code token, scope is the OAuth scope string."; add:

```json
{
  "claim": "amr",
  "type": "string[]",
  "required": false,
  "meaning": "How the subject authenticated: [\"device\"], [\"exchange\"], [\"service\"] or [\"assertion\"] (a service asserting a human who acted from chat, contract §3.4b).",
  "whyItExists": "A consumer may refuse to turn a device-exchanged token into a session.",
  "consumerObligation": "Never require it: it is absent on OAuth authorization-code tokens, where the provider reserves the claim."
}
```

- [ ] **Step 2: Write the failing tests**

`packages/contract/src/token-claims.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrgPlaneTokenClaims, audienceIncludes } from "./token-claims";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "ecosystem-identity", "token_claims.json"), "utf8"),
) as {
  version: number;
  issued: Array<{ claim: string; required: boolean }>;
  standard: Array<{ claim: string }>;
  conditional: Array<{ claim: string }>;
  reject: Array<{ case: string }>;
};

const valid = {
  iss: "https://accounts.superjackfruit.com",
  sub: "prn_0123456789abcdef0123",
  aud: "https://hub.agentpod.dev",
  exp: 1_900_000_300,
  iat: 1_900_000_000,
  jti: "b7f1c0de",
  principalKind: "agent",
  org: "org_00000000000000000000",
  ent: ["agentpod", "superpipeline"],
  mayDispatch: [],
  mayGrantReach: false,
};

describe("token_claims.json v8 ↔ OrgPlaneTokenClaims", () => {
  test("the fixture is v8 and no longer issues tenant", () => {
    expect(fixture.version).toBe(8);
    expect(fixture.issued.map((c) => c.claim)).not.toContain("tenant");
  });

  test("every claim the fixture names is a key of the schema, and the reverse", () => {
    const described = new Set([...fixture.issued, ...fixture.standard, ...fixture.conditional].map((c) => c.claim));
    expect([...described].sort()).toEqual(Object.keys(OrgPlaneTokenClaims.shape).sort());
  });

  test("every required issued claim is required by the schema", () => {
    for (const { claim } of fixture.issued.filter((c) => c.required)) {
      const { [claim]: _dropped, ...rest } = valid as Record<string, unknown>;
      expect(OrgPlaneTokenClaims.safeParse(rest).success).toBe(false);
    }
  });

  test("a v7 hub token (tenant, no org/ent) is refused — reject case missing-org", () => {
    expect(fixture.reject.map((r) => r.case)).toContain("missing-org");
    const { org: _o, ent: _e, ...v7 } = valid;
    expect(OrgPlaneTokenClaims.safeParse({ ...v7, tenant: "fleet_00000000000000000000" }).success).toBe(false);
  });

  test("aud may be a string or a non-empty array", () => {
    expect(OrgPlaneTokenClaims.safeParse({ ...valid, aud: ["https://hub.agentpod.dev", "x"] }).success).toBe(true);
    expect(OrgPlaneTokenClaims.safeParse({ ...valid, aud: [] }).success).toBe(false);
  });

  test("unknown extra claims (client_id, azp, sid) pass through", () => {
    const r = OrgPlaneTokenClaims.safeParse({ ...valid, client_id: "agentpod-console", azp: "x", sid: "y" });
    expect(r.success).toBe(true);
  });

  test("audienceIncludes: equals or contains, never a prefix", () => {
    expect(audienceIncludes("https://hub.agentpod.dev", "https://hub.agentpod.dev")).toBe(true);
    expect(audienceIncludes(["a", "https://hub.agentpod.dev"], "https://hub.agentpod.dev")).toBe(true);
    expect(audienceIncludes("https://hub.agentpod.dev/x", "https://hub.agentpod.dev")).toBe(false);
    expect(audienceIncludes(["a"], "https://hub.agentpod.dev")).toBe(false);
  });
});
```

Append to `apps/node-agent/internal/fleetcred/fleetcred_test.go`:

```go
// A v8 (org-plane) access token: aud is an array, org/ent/jti are present, tenant is gone.
// Inspect must read sub/principalKind/exp from it exactly as from a hub token.
func TestInspectReadsAnOrgPlaneShapedToken(t *testing.T) {
	payload := `{"iss":"https://accounts.superjackfruit.com","sub":"prn_0123456789abcdef0123",` +
		`"aud":["https://hub.agentpod.dev","https://app.superpipeline.dev"],"exp":1900000300,"iat":1900000000,` +
		`"jti":"j1","principalKind":"human","org":"org_00000000000000000000","ent":["agentpod"],` +
		`"mayDispatch":[],"mayGrantReach":false}`
	tok := "h." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".s"
	c, err := Inspect(tok)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if c.Subject != "prn_0123456789abcdef0123" || c.PrincipalKind != "human" || c.Expiry.Unix() != 1900000300 {
		t.Fatalf("got %+v", c)
	}
}
```

(Add `"encoding/base64"` to the test file's imports if absent.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/contract && bun test src/token-claims.test.ts`
Expected: FAIL — `Cannot find module './token-claims'`.
Run: `cd apps/node-agent && go test -race ./internal/fleetcred/ -run TestInspectReadsAnOrgPlaneShapedToken`
Expected: PASS already (this is a characterisation test — `Inspect` decodes only three fields; it guards a future change that types `aud` as a string). Revert-proof it: temporarily add `Aud string \`json:"aud"\`` to the struct `Inspect` unmarshals into and watch it fail with `cannot unmarshal array`; remove.

- [ ] **Step 4: Write the schema**

`packages/contract/src/token-claims.ts`:

```ts
/**
 * The organization plane's access-token claims (fixtures/ecosystem-identity/token_claims.json v8).
 * Every product verifies against this one shape. Loose: provider-set claims (client_id, azp, sid)
 * pass through and are ignored.
 */
import { z } from "zod";
import { OrganizationId, PrincipalId } from "./ids";

export const ORG_PLANE_PRODUCTS = ["agentpod", "superpipeline", "supermessage", "superwitness"] as const;

export const OrgPlaneTokenClaims = z.looseObject({
  iss: z.string().min(1),
  sub: PrincipalId,
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string().min(1),
  principalKind: z.enum(["human", "agent", "service"]),
  org: OrganizationId,
  // Unrecognised values are ignored, never refused — so not an enum.
  ent: z.array(z.string()),
  // A non-prn_ value is ignored by consumers (valueRules.unrecognisedIsIgnored), so plain strings.
  mayDispatch: z.array(z.string()),
  mayGrantReach: z.boolean(),
  scope: z.string().optional(),
  act: z.object({ sub: PrincipalId }).optional(),
  amr: z.array(z.string()).optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
});
export type OrgPlaneTokenClaims = z.infer<typeof OrgPlaneTokenClaims>;

/** Equals, or contains. Never a prefix match. */
export function audienceIncludes(aud: string | string[], audience: string): boolean {
  return Array.isArray(aud) ? aud.includes(audience) : aud === audience;
}
```

Add `export * from "./token-claims";` to `packages/contract/src/index.ts`. Update the two comments in `apps/hub/src/auth/jwt-claims.ts` (lines 8-9 and 62-63) to name `src/auth/testdata/token_claims.v7.json` as what holds the hub's legacy minting. Add `token_claims.json | 8 | The access-token claims every product verifies` to the README's Files table.

- [ ] **Step 5: Run all affected suites**

Run: `cd packages/contract && bun test && bun run scripts/emit-go-fixtures.ts --check` — Expected: PASS.
Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/unit/jwt-issuer.test.ts` — Expected: PASS (reads the v7 copy).
Run: `cd apps/node-agent && go test -race ./internal/fleetcred/` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add fixtures/ecosystem-identity/ packages/contract/src/token-claims.ts packages/contract/src/token-claims.test.ts packages/contract/src/index.ts apps/hub/src/auth/testdata/token_claims.v7.json apps/hub/tests/unit/jwt-issuer.test.ts apps/hub/src/auth/jwt-claims.ts apps/node-agent/internal/fleetcred/fleetcred_test.go
git commit -m "feat(contract): token_claims v8 — org/ent/jti/amr in, tenant out; OrgPlaneTokenClaims schema"
```

---

### Task 3: The plane verifier — JWKS cache and EdDSA verification

**Files:**
- Create: `apps/hub/src/auth/org-plane/verify.ts`
- Create: `apps/hub/src/auth/org-plane/verify.test.ts`

**Interfaces:**
- Consumes: `OrgPlaneTokenClaims` from `@agentpod/contract` (Task 2); `orgPlane()` (Task 1).
- Produces:
  - `interface PlaneVerifierOptions { issuer: string; audience: string; jwksUrl: string; fetch?: (url: string) => Promise<Response>; now?: () => number; maxAgeMs?: number; retryAfterMs?: number }`
  - `interface PlaneVerifier { verify(token: string): Promise<OrgPlaneTokenClaims | null> }`
  - `createPlaneVerifier(opts: PlaneVerifierOptions): PlaneVerifier`
  - `planeVerifier(): PlaneVerifier` — lazy singleton built from `orgPlane()`; throws if called in legacy mode.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/auth/org-plane/verify.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { createPlaneVerifier } from "./verify";

const ISS = "https://accounts.test";
const AUD = "https://hub.test";
const JWKS = "https://accounts.test/api/auth/jwks";

async function keypair(kid: string, alg: "EdDSA" | "ES256" = "EdDSA") {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } as JWK;
  return { pub, privateKey, kid, alg };
}

type Key = Awaited<ReturnType<typeof keypair>>;

function sign(key: Key, claims: Record<string, unknown> = {}, nowSec = Math.floor(Date.now() / 1000)) {
  return new SignJWT({
    principalKind: "human",
    org: "org_00000000000000000000",
    ent: ["agentpod"],
    mayDispatch: [],
    mayGrantReach: false,
    jti: crypto.randomUUID(),
    ...claims,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer((claims.iss as string) ?? ISS)
    .setSubject("prn_0123456789abcdef0123")
    .setAudience((claims.aud as string | string[]) ?? AUD)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(key.privateKey);
}

/** A JWKS endpoint whose keys and liveness the test controls, counting fetches. */
function plane(keys: JWK[]) {
  const state = { keys, down: false, fetches: 0 };
  const fetch = async (url: string) => {
    state.fetches++;
    if (url !== JWKS) throw new Error(`unexpected ${url}`);
    if (state.down) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ keys: state.keys }), { headers: { "content-type": "application/json" } });
  };
  return { state, fetch };
}

describe("createPlaneVerifier", () => {
  test("accepts a token for this audience and returns its claims", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch });
    const claims = await v.verify(await sign(k));
    expect(claims?.sub).toBe("prn_0123456789abcdef0123");
    expect(claims?.org).toBe("org_00000000000000000000");
  });

  test("an aud array containing the hub is accepted; one without it is refused", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch });
    expect(await v.verify(await sign(k, { aud: ["https://other.test", AUD] }))).not.toBeNull();
    expect(await v.verify(await sign(k, { aud: ["https://other.test"] }))).toBeNull();
  });

  test("the issuer is compared exactly — a trailing slash is a different issuer", async () => {
    const k = await keypair("k1");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([k.pub]).fetch });
    expect(await v.verify(await sign(k, { iss: `${ISS}/` }))).toBeNull();
  });

  test("EdDSA only: an ES256 token is refused even when its key is published", async () => {
    const es = await keypair("es", "ES256");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([es.pub]).fetch });
    expect(await v.verify(await sign(es))).toBeNull();
  });

  test("a v7-shaped token (tenant, no org) is refused", async () => {
    const k = await keypair("k1");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([k.pub]).fetch });
    expect(await v.verify(await sign(k, { org: undefined, tenant: "fleet_00000000000000000000" }))).toBeNull();
  });

  test("caches the key set, and refetches once it is ten minutes old", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now });
    const nowSec = () => Math.floor(now / 1000);
    await v.verify(await sign(k, {}, nowSec()));
    await v.verify(await sign(k, {}, nowSec()));
    expect(p.state.fetches).toBe(1);
    now += 10 * 60 * 1000;
    await v.verify(await sign(k, {}, nowSec()));
    expect(p.state.fetches).toBe(2);
  });

  test("an unknown kid triggers a refetch, so a rotated key verifies at once", async () => {
    const k1 = await keypair("k1");
    const k2 = await keypair("k2");
    const p = plane([k1.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch });
    await v.verify(await sign(k1));
    p.state.keys = [k1.pub, k2.pub];
    expect(await v.verify(await sign(k2))).not.toBeNull();
    expect(p.state.fetches).toBe(2);
  });

  test("serves the last good key set when the plane is down (design §9 Offline)", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now });
    await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    p.state.down = true;
    now += 60 * 60 * 1000; // an hour later: the cache is stale and the plane is unreachable
    expect(await v.verify(await sign(k, {}, Math.floor(now / 1000)))).not.toBeNull();
  });

  test("a down plane is not hammered: one retry per retryAfterMs", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now, retryAfterMs: 30_000 });
    await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    p.state.down = true;
    now += 11 * 60 * 1000;
    for (let i = 0; i < 5; i++) await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    expect(p.state.fetches).toBe(2);
  });

  test("a token signed by an unpublished key is refused, and unknown kids cannot force a refetch storm", async () => {
    const k = await keypair("k1");
    const rogue = await keypair("rogue");
    const p = plane([k.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, retryAfterMs: 30_000 });
    await v.verify(await sign(k));
    for (let i = 0; i < 5; i++) expect(await v.verify(await sign(rogue))).toBeNull();
    expect(p.state.fetches).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/auth/org-plane/verify.test.ts`
Expected: FAIL — `Cannot find module './verify'`.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/auth/org-plane/verify.ts`:

```ts
/**
 * Verifying the organization plane's tokens (contract §1, design §5.5).
 *
 * - Key set cached ≤ 10 minutes; refetched on an unknown `kid`.
 * - The last good key set is served while the plane is unreachable — the hub keeps admitting
 *   valid tokens through a plane outage, which is the property design §9 "Offline" tests.
 * - EdDSA only, read from configuration, never from the token's header.
 * - `iss` exact; `aud` equals or contains this hub's audience.
 * - Refetches are rate-limited (`retryAfterMs`) so neither an outage nor a stream of rogue kids
 *   turns every request into a call to the plane.
 */
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWK } from "jose";
import { OrgPlaneTokenClaims } from "@agentpod/contract";

import { orgPlane } from "./config";
import { createLogger } from "../../utils/logger";

const log = createLogger("org-plane-verify");
const TEN_MINUTES = 10 * 60 * 1000;
const ALG = "EdDSA";

export interface PlaneVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: string;
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
  /** Capped at ten minutes whatever is passed. */
  maxAgeMs?: number;
  retryAfterMs?: number;
}

export interface PlaneVerifier {
  verify(token: string): Promise<OrgPlaneTokenClaims | null>;
}

export function createPlaneVerifier(o: PlaneVerifierOptions): PlaneVerifier {
  const fetchFn = o.fetch ?? ((url: string) => fetch(url, { headers: { accept: "application/json" } }));
  const now = o.now ?? Date.now;
  const maxAge = Math.min(o.maxAgeMs ?? TEN_MINUTES, TEN_MINUTES);
  const retryAfter = o.retryAfterMs ?? 30_000;

  let good: { keys: JWK[]; at: number } | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  const triedKids = new Set<string>();

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    if (now() - lastAttempt < retryAfter) return Promise.resolve();
    lastAttempt = now();
    inflight = (async () => {
      try {
        const res = await fetchFn(o.jwksUrl);
        if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
        const body = (await res.json()) as { keys?: unknown };
        if (!Array.isArray(body.keys)) throw new Error("JWKS has no keys array");
        const keys = (body.keys as JWK[]).filter((k) => k.kty === "OKP" && k.crv === "Ed25519");
        good = { keys, at: now() };
      } catch (error) {
        log.warn("JWKS refresh failed; serving the last good set", {
          error: String(error),
          lastGoodAgeMs: good ? now() - good.at : null,
        });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    async verify(token) {
      let kid: string | undefined;
      try {
        const header = decodeProtectedHeader(token);
        if (header.alg !== ALG) return null;
        kid = header.kid;
      } catch {
        return null;
      }

      if (!good || now() - good.at >= maxAge) await refresh();
      if (good && kid && !good.keys.some((k) => k.kid === kid) && !triedKids.has(kid)) {
        if (triedKids.size >= 100) triedKids.clear();
        triedKids.add(kid);
        lastAttempt = Number.NEGATIVE_INFINITY; // a new kid may refetch at once
        await refresh();
      }
      if (!good) return null;

      try {
        const { payload } = await jwtVerify(token, createLocalJWKSet({ keys: good.keys } as JSONWebKeySet), {
          issuer: o.issuer,
          audience: o.audience, // jose accepts aud as a string equal to, or an array containing, this
          algorithms: [ALG],
          currentDate: new Date(now()),
        });
        const parsed = OrgPlaneTokenClaims.safeParse(payload);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}

let singleton: PlaneVerifier | null = null;

export function planeVerifier(): PlaneVerifier {
  const plane = orgPlane();
  if (!plane) throw new Error("planeVerifier() called with ORG_PLANE_* unset");
  singleton ??= createPlaneVerifier({ issuer: plane.issuer, audience: plane.audience, jwksUrl: plane.jwksUrl });
  return singleton;
}
```

Why the unknown-kid path resets the retry window: the contract says "refetch on unknown `kid`", so a rotated key must verify on its first use even seconds after the last fetch. Each *distinct* kid gets that once (`triedKids`, capped at 100 entries and cleared when full); repeats of a rogue kid fall back to one fetch per `retryAfterMs`.

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS (10 tests). Revert-proof: (a) delete `currentDate`/`issuer` options one at a time and watch the issuer test go red; (b) replace `if (!good) return null` path by clearing `good` on refresh failure and watch "serves the last good key set" go red.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/org-plane/verify.ts apps/hub/src/auth/org-plane/verify.test.ts
git commit -m "feat(hub): org-plane token verifier — 10-min JWKS cache, kid refetch, last-good, EdDSA only"
```

---

### Task 4: `org` → tenant, first sight, and the entitlement refusal

**Files:**
- Create: `apps/hub/src/auth/org-plane/tenant.ts`
- Create: `apps/hub/tests/integration/org-plane-tenant.test.ts`

**Interfaces:**
- Consumes: `tenants` table (`apps/hub/src/db/schema/tenants.ts`: `externalId`, `externalSource`, unique `tenants_external_idx`); `prefixedId` (`apps/hub/src/utils/ids.ts:9`).
- Produces:
  - `AGENTPOD_PRODUCT = "agentpod"`, `ORG_PLANE_SOURCE = "org-plane"`
  - `type TenantResolution = { ok: true; tenantId: string } | { ok: false; status: 403; body: { error: "product_not_enabled"; org: string } }`
  - `tenantForOrg(claims: { org: string; ent: string[] }, exec?: DbExecutor): Promise<TenantResolution>`

- [ ] **Step 1: Write the failing test**

`apps/hub/tests/integration/org-plane-tenant.test.ts`:

```ts
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { tenantForOrg } from "../../src/auth/org-plane/tenant";

const hex = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const created: string[] = [];

beforeAll(ensurePgMigrations);
afterAll(async () => {
  if (created.length) await db.delete(tenants).where(inArray(tenants.externalId, created));
});

describe("tenantForOrg", () => {
  test("first sight creates one tenant mapped to the org; the second sight reuses it", async () => {
    const org = `org_${hex()}`;
    created.push(org);
    const a = await tenantForOrg({ org, ent: ["agentpod"] });
    const b = await tenantForOrg({ org, ent: ["agentpod", "superpipeline"] });
    expect(a.ok && b.ok && a.tenantId === b.tenantId).toBe(true);
    const rows = await db
      .select()
      .from(tenants)
      .where(and(eq(tenants.externalSource, "org-plane"), eq(tenants.externalId, org)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(/^fleet_[0-9a-f]{20}$/);
  });

  test("ent without agentpod is 403 product_not_enabled naming the org, and creates nothing", async () => {
    const org = `org_${hex()}`;
    created.push(org);
    const r = await tenantForOrg({ org, ent: ["superpipeline"] });
    expect(r).toEqual({ ok: false, status: 403, body: { error: "product_not_enabled", org } });
    const rows = await db.select().from(tenants).where(eq(tenants.externalId, org));
    expect(rows).toHaveLength(0);
  });

  test("concurrent first sights converge on one tenant", async () => {
    const org = `org_${hex()}`;
    created.push(org);
    const results = await Promise.all(Array.from({ length: 5 }, () => tenantForOrg({ org, ent: ["agentpod"] })));
    const ids = new Set(results.map((r) => (r.ok ? r.tenantId : "refused")));
    expect(ids.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/org-plane-tenant.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/auth/org-plane/tenant.ts`:

```ts
/**
 * A plane token's `org` → this hub's tenant (contract §2 "First sight", "Entitlement check").
 * Local only: the hub never calls the plane to create a tenant.
 */
import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "../../db/drizzle";
import { tenants } from "../../db/schema/tenants";
import { prefixedId } from "../../utils/ids";

export const AGENTPOD_PRODUCT = "agentpod";
export const ORG_PLANE_SOURCE = "org-plane";

export type TenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; status: 403; body: { error: "product_not_enabled"; org: string } };

async function find(org: string, exec: DbExecutor): Promise<string | null> {
  const [row] = await exec
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.externalSource, ORG_PLANE_SOURCE), eq(tenants.externalId, org)))
    .limit(1);
  return row?.id ?? null;
}

export async function tenantForOrg(
  claims: { org: string; ent: string[] },
  exec: DbExecutor = db,
): Promise<TenantResolution> {
  if (!claims.ent.includes(AGENTPOD_PRODUCT)) {
    return { ok: false, status: 403, body: { error: "product_not_enabled", org: claims.org } };
  }
  const existing = await find(claims.org, exec);
  if (existing) return { ok: true, tenantId: existing };

  await exec
    .insert(tenants)
    .values({ id: prefixedId("fleet"), name: claims.org, externalSource: ORG_PLANE_SOURCE, externalId: claims.org })
    .onConflictDoNothing({ target: [tenants.externalSource, tenants.externalId] });
  const id = await find(claims.org, exec);
  if (!id) throw new Error(`tenant for ${claims.org} neither found nor created`);
  return { ok: true, tenantId: id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS. Revert-proof: delete the `ent` check and watch the 403 test fail.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/org-plane/tenant.ts apps/hub/tests/integration/org-plane-tenant.test.ts
git commit -m "feat(hub): map a plane token's org to a tenant, first-sight creation, product_not_enabled"
```

---

### Task 5: Every verifying door switches to the plane

The hub verifies bearer tokens at five places today, all found by `grep -rn "verifyHubToken\|jwtVerify" apps/hub/src`:

| Door | File:line | Today |
|---|---|---|
| `authMiddleware` (all `/api/*` below `src/index.ts:323`) | `src/auth/middleware.ts:126-267` (hub token at :189-231, Better Auth session at :135-154 and :234-255, `API_TOKEN` at :166-176) | Better Auth session, `API_TOKEN`, hub JWT (human only), Better Auth bearer |
| MCP | `src/mcp/auth.ts:26-37` | `verifyHubToken` |
| Evidence | `src/routes/evidence.ts:55-73` | `verifyHubToken` + `tenant` regex |
| Dispatchable | `src/routes/fleet-dispatchable.ts:110-125` | its own `jwtVerify` with `publishedJwks` |
| Devices (`resolveCaller`) | `src/routes/devices.ts:73-91` | `verifyHubToken` — retired whole under the plane in Task 8, not switched |

Legacy branches stay byte-identical: every door gains an `if (plane) { … }` branch ahead of its existing code.

**Files:**
- Modify: `apps/hub/src/auth/hub-token.ts` (add `verifyPlaneBearer`)
- Modify: `apps/hub/src/auth/middleware.ts:41-57` (`authType` union), `:126` (factory)
- Modify: `apps/hub/src/mcp/auth.ts:13-37`, `apps/hub/src/index.ts:315-319` (`/mcp` handler)
- Modify: `apps/hub/src/routes/evidence.ts:47-73`
- Modify: `apps/hub/src/routes/fleet-dispatchable.ts:95-125`
- Create: `apps/hub/src/auth/org-plane/middleware.test.ts`
- Create: `apps/hub/src/auth/org-plane/doors.test.ts`

**Interfaces:**
- Consumes: `orgPlane()`, `TEST_PLANE`, `setOrgPlaneForTests` (Task 1); `planeVerifier()`, `PlaneVerifier` (Task 3); `tenantForOrg`, `TenantResolution` (Task 4).
- Produces:
  - `type PlaneCaller = { sub: string; principalKind: "human" | "agent" | "service"; tenantId: string; claims: OrgPlaneTokenClaims }`
  - `type PlaneBearerResult = { ok: true; caller: PlaneCaller } | { ok: false; status: 401 } | { ok: false; status: 403; body: { error: "product_not_enabled"; org: string } }`
  - `verifyPlaneBearer(token: string, deps?: { verify?: (t: string) => Promise<OrgPlaneTokenClaims | null>; tenantFor?: typeof tenantForOrg }): Promise<PlaneBearerResult>`
  - `createAuthMiddleware(deps?: { plane?: () => OrgPlaneConfig | null; verifyPlane?: typeof verifyPlaneBearer }): MiddlewareHandler`; `authMiddleware = createAuthMiddleware()`.
  - `AuthUser.authType` gains `"org_plane"`; under the plane `AuthUser.id` is the caller's `prn_` (which, after Task 13's rewrite, is what every `user_id` column holds).
  - `resolveMcpCaller(request, deps?)` returns `McpCaller | McpRefusal | null` where `McpRefusal = { refusal: { error: "product_not_enabled"; org: string } }`.
  - `EvidenceDeps` gains `verifyPlane?: typeof verifyPlaneBearer`; `DispatchableDeps` gains the same.

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/auth/org-plane/middleware.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "../middleware";
import { TEST_PLANE } from "./config";
import type { PlaneBearerResult } from "../hub-token";
import { config } from "../../config";

const human: PlaneBearerResult = {
  ok: true,
  caller: {
    sub: "prn_aaaaaaaaaaaaaaaaaaaa",
    principalKind: "human",
    tenantId: "fleet_11111111111111111111",
    claims: { email: "op@example.com" } as never,
  },
};

function app(result: PlaneBearerResult, seen: string[] = []) {
  return new Hono()
    .use("/api/*", createAuthMiddleware({
      plane: () => TEST_PLANE,
      verifyPlane: async (t) => {
        seen.push(t);
        return result;
      },
    }))
    .get("/api/whoami", (c) => c.json(c.get("user")));
}

describe("authMiddleware with ORG_PLANE_* set", () => {
  test("a human plane token is admitted as its prn_, in the tenant its org maps to", async () => {
    const res = await app(human).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "prn_aaaaaaaaaaaaaaaaaaaa",
      email: "op@example.com",
      authType: "org_plane",
      tenantId: "fleet_11111111111111111111",
    });
  });

  test("?token= is still read, for the browser's WebSocket and EventSource", async () => {
    const seen: string[] = [];
    const res = await app(human, seen).request("/api/whoami?token=qt");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["qt"]);
  });

  test("an agent token is refused with the same 403 as today", async () => {
    const agent = { ...human, caller: { ...(human as { caller: object }).caller, principalKind: "agent" } } as PlaneBearerResult;
    const res = await app(agent).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(403);
  });

  test("product_not_enabled passes through as the contract's body", async () => {
    const res = await app({ ok: false, status: 403, body: { error: "product_not_enabled", org: "org_00000000000000000000" } })
      .request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "product_not_enabled", org: "org_00000000000000000000" });
  });

  test("no dual-accept: a context already holding a Better Auth user is not trusted", async () => {
    const a = new Hono()
      .use("/api/*", async (c, next) => {
        c.set("user", { id: "ba-user", authType: "better_auth", tenantId: "fleet_x" });
        await next();
      })
      .use("/api/*", createAuthMiddleware({ plane: () => TEST_PLANE, verifyPlane: async () => ({ ok: false, status: 401 }) }))
      .get("/api/whoami", (c) => c.json(c.get("user")));
    expect((await a.request("/api/whoami")).status).toBe(401);
  });

  test("a human token minted for another first-party client (superpipeline-web, contract §3.1) is admitted", async () => {
    const viaSuperpipeline = {
      ...human,
      caller: { ...(human as { caller: object }).caller, claims: { email: "op@example.com", client_id: "superpipeline-web", azp: "superpipeline-web" } },
    } as PlaneBearerResult;
    const res = await app(viaSuperpipeline).request("/api/whoami", { headers: { Authorization: "Bearer t" } });
    expect(res.status).toBe(200);
  });

  test("the static API_TOKEN keeps working (it is configuration, not an issuer)", async () => {
    const res = await app({ ok: false, status: 401 }).request("/api/whoami", {
      headers: { Authorization: `Bearer ${config.auth.token}` },
    });
    expect(res.status).toBe(200);
  });

  test("legacy mode is today's middleware: no plane call at all", async () => {
    const seen: string[] = [];
    const a = new Hono()
      .use("/api/*", createAuthMiddleware({ plane: () => null, verifyPlane: async (t) => (seen.push(t), human) }))
      .get("/api/whoami", (c) => c.json(c.get("user")));
    await a.request("/api/whoami", { headers: { Authorization: "Bearer not-a-hub-token" } });
    expect(seen).toEqual([]);
  });
});
```

`apps/hub/src/auth/org-plane/doors.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { verifyPlaneBearer } from "../hub-token";
import { resolveMcpCaller } from "../../mcp/auth";
import { setOrgPlaneForTests, TEST_PLANE } from "./config";
import { createDispatchableRoutes } from "../../routes/fleet-dispatchable";

const claims = {
  iss: TEST_PLANE.issuer, sub: "prn_aaaaaaaaaaaaaaaaaaaa", aud: TEST_PLANE.audience, exp: 2e9, iat: 2e9 - 300, jti: "j",
  principalKind: "agent" as const, org: "org_00000000000000000000", ent: ["agentpod"], mayDispatch: [], mayGrantReach: false,
};
let restore = () => {};
afterEach(() => restore());

describe("verifyPlaneBearer", () => {
  test("verified claims plus a mapped tenant", async () => {
    const r = await verifyPlaneBearer("t", {
      verify: async () => claims,
      tenantFor: async () => ({ ok: true, tenantId: "fleet_22222222222222222222" }),
    });
    expect(r).toEqual({ ok: true, caller: { sub: claims.sub, principalKind: "agent", tenantId: "fleet_22222222222222222222", claims } });
  });

  test("an unverifiable token is 401 and never reaches the tenant table", async () => {
    let touched = false;
    const r = await verifyPlaneBearer("t", { verify: async () => null, tenantFor: async () => ((touched = true), { ok: true, tenantId: "x" }) });
    expect(r).toEqual({ ok: false, status: 401 });
    expect(touched).toBe(false);
  });
});

describe("MCP under the plane", () => {
  test("an agent token resolves to its principal", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const caller = await resolveMcpCaller(
      new Request("http://hub/mcp", { headers: { Authorization: "Bearer t" } }),
      { verifyPlane: async () => ({ ok: true, caller: { sub: claims.sub, principalKind: "agent", tenantId: "fleet_x", claims } }) },
    );
    expect(caller).toEqual({ principalId: claims.sub, kind: "agent" });
  });

  test("product_not_enabled is surfaced as a refusal, not swallowed into a 401", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const caller = await resolveMcpCaller(
      new Request("http://hub/mcp", { headers: { Authorization: "Bearer t" } }),
      { verifyPlane: async () => ({ ok: false, status: 403, body: { error: "product_not_enabled", org: claims.org } }) },
    );
    expect(caller).toEqual({ refusal: { error: "product_not_enabled", org: claims.org } });
  });
});

describe("dispatchable under the plane", () => {
  test("reads mayDispatch from the plane token", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const app = createDispatchableRoutes({
      verifyPlane: async () => ({
        ok: true,
        caller: { sub: "prn_hhhhhhhhhhhhhhhhhhhh", principalKind: "human", tenantId: "fleet_x", claims: { ...claims, principalKind: "human", mayDispatch: ["prn_aaaaaaaaaaaaaaaaaaaa"] } },
      }),
      listPrincipals: async () => [
        { id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "a", displayName: "A", userId: null, suspendedAt: null },
      ],
    });
    const res = await app.request("/api/fleet/dispatchable", { headers: { Authorization: "Bearer t" } });
    expect(await res.json()).toEqual({ agents: [{ id: "prn_aaaaaaaaaaaaaaaaaaaa", handle: "a", displayName: "A" }] });
  });
});
```

Add one case to `apps/hub/src/routes/evidence.test.ts` (it already builds an app with `createEvidenceRoutes({ jwks })`):

```ts
test("under the plane, an agent token's own scope claim authorises evidence:read; a human is 403", async () => {
  const restore = setOrgPlaneForTests(TEST_PLANE);
  try {
    const agentApp = createEvidenceRoutes({
      verifyPlane: async () => ({ ok: true, caller: { sub: agentPrincipalId, principalKind: "agent", tenantId: BOOTSTRAP_TENANT_ID, claims: { scope: "evidence:read" } as never } }),
    });
    expect((await agentApp.request(`/api/evidence/attempts/${attemptId}`, { headers: { Authorization: "Bearer t" } })).status).toBe(200);
    const humanApp = createEvidenceRoutes({
      verifyPlane: async () => ({ ok: true, caller: { sub: "prn_hhhhhhhhhhhhhhhhhhhh", principalKind: "human", tenantId: BOOTSTRAP_TENANT_ID, claims: { scope: "openid evidence:read" } as never } }),
    });
    expect((await humanApp.request(`/api/evidence/attempts/${attemptId}`, { headers: { Authorization: "Bearer t" } })).status).toBe(403);
  } finally {
    restore();
  }
});
```

(Reuse that file's existing `agentPrincipalId`/`attemptId` fixtures; if they are named differently, use the ones its existing "an agent with evidence:read reads an attempt" case uses.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/auth/org-plane/ src/routes/evidence.test.ts`
Expected: FAIL — `createAuthMiddleware` and `verifyPlaneBearer` are not exported; `resolveMcpCaller` takes no deps.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/auth/hub-token.ts` — append:

```ts
import type { OrgPlaneTokenClaims } from "@agentpod/contract";
import { planeVerifier } from "./org-plane/verify.ts";
import { tenantForOrg } from "./org-plane/tenant.ts";

export type PlaneCaller = {
  sub: string;
  principalKind: "human" | "agent" | "service";
  tenantId: string;
  claims: OrgPlaneTokenClaims;
};
export type PlaneBearerResult =
  | { ok: true; caller: PlaneCaller }
  | { ok: false; status: 401 }
  | { ok: false; status: 403; body: { error: "product_not_enabled"; org: string } };

/**
 * The plane-mode counterpart of `verifyHubToken`, shared by every door so none can drift.
 * Verification is offline (cached JWKS); the tenant lookup is local. No plane call.
 */
export async function verifyPlaneBearer(
  token: string,
  deps: { verify?: (t: string) => Promise<OrgPlaneTokenClaims | null>; tenantFor?: typeof tenantForOrg } = {},
): Promise<PlaneBearerResult> {
  const claims = await (deps.verify ?? ((t: string) => planeVerifier().verify(t)))(token);
  if (!claims) return { ok: false, status: 401 };
  const tenant = await (deps.tenantFor ?? tenantForOrg)(claims);
  if (!tenant.ok) return tenant;
  return { ok: true, caller: { sub: claims.sub, principalKind: claims.principalKind, tenantId: tenant.tenantId, claims } };
}
```

`apps/hub/src/auth/middleware.ts` — widen `authType` to `"better_auth" | "api_key" | "hub_token" | "org_plane"`; turn the middleware into a factory and put the plane branch first:

```ts
import type { MiddlewareHandler } from "hono";
import { orgPlane, type OrgPlaneConfig } from "./org-plane/config";
import { verifyPlaneBearer } from "./hub-token";

export function createAuthMiddleware(
  deps: { plane?: () => OrgPlaneConfig | null; verifyPlane?: typeof verifyPlaneBearer } = {},
): MiddlewareHandler {
  return createMiddleware(async (c: Context, next: Next) => {
    if ((deps.plane ?? orgPlane)()) {
      // No dual-accept: a Better Auth session — cookie, bearer, or one an earlier middleware
      // loaded — authenticates nobody once the plane is the issuer.
      const header = c.req.header("Authorization");
      const bearer = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
      if (bearer && safeCompare(bearer, config.auth.token)) {
        c.set("user", { id: config.defaultUserId, authType: "api_key", tenantId: BOOTSTRAP_TENANT_ID });
        c.set("session", null);
        c.set("betterAuthUser", null);
        return next();
      }
      if (bearer) {
        const r = await (deps.verifyPlane ?? verifyPlaneBearer)(bearer);
        if (r.ok) {
          if (r.caller.principalKind !== "human") {
            log.warn("Refused a non-human plane token", { kind: r.caller.principalKind });
            return c.json(
              { error: "Forbidden", message: `This endpoint takes a human principal. That token names a ${r.caller.principalKind}.` },
              403,
            );
          }
          c.set("user", {
            id: r.caller.sub,
            ...(r.caller.claims.email ? { email: r.caller.claims.email } : {}),
            authType: "org_plane",
            tenantId: r.caller.tenantId,
          });
          c.set("session", null);
          c.set("betterAuthUser", null);
          return next();
        }
        if (r.status === 403) return c.json(r.body, 403);
      }
      return c.json({ error: "Unauthorized", message: "Valid session or API key required" }, 401);
    }

    // ── Legacy: the existing body of authMiddleware, unchanged, from `const existingUser` to the 401. ──
  });
}

export const authMiddleware = createAuthMiddleware();
```

`apps/hub/src/mcp/auth.ts`:

```ts
import { orgPlane } from "../auth/org-plane/config.ts";
import { verifyHubToken, verifyPlaneBearer } from "../auth/hub-token.ts";

export interface McpRefusal { refusal: { error: "product_not_enabled"; org: string } }

export async function resolveMcpCaller(
  request: Request,
  deps: { verifyPlane?: typeof verifyPlaneBearer } = {},
): Promise<McpCaller | McpRefusal | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  if (!match) return null;

  if (orgPlane()) {
    const r = await (deps.verifyPlane ?? verifyPlaneBearer)(match[1]!);
    if (r.ok) return { principalId: r.caller.sub, kind: r.caller.principalKind };
    return r.status === 403 ? { refusal: r.body } : null;
  }

  // legacy, unchanged
  const claims = await verifyHubToken(match[1]!);
  // …
}
```

`apps/hub/src/index.ts:315-319`:

```ts
  .all('/mcp', async (c) => {
    const caller = await resolveMcpCaller(c.req.raw);
    if (!caller) return mcpUnauthorized();
    if ('refusal' in caller) return c.json(caller.refusal, 403);
    return handleMcpRequest(c.req.raw, caller);
  })
```

`apps/hub/src/routes/evidence.ts` — `EvidenceDeps` gains `verifyPlane?: typeof verifyPlaneBearer`; `authorize` takes it and branches first:

```ts
  if (orgPlane()) {
    const r = await (verifyPlane ?? verifyPlaneBearer)(match[1]!);
    if (!r.ok) return { ok: false, status: r.status === 403 ? 403 : 401 };
    // Contract §2: grant scopes are read only from agent or service tokens. A human's `scope`
    // is an OAuth scope string and is never a grant. No plane call on this path (design §5.7).
    if (r.caller.principalKind === "human") return { ok: false, status: 403 };
    const scopes = (r.caller.claims.scope ?? "").split(" ").filter(Boolean);
    if (!scopes.includes(scope)) return { ok: false, status: 403 };
    return { ok: true, tenant: r.caller.tenantId, principalId: r.caller.sub };
  }
```

Thread `deps.verifyPlane` from `createEvidenceRoutes(deps)` into each `authorize(...)` call (the routes at `evidence.ts:166, 204, 233, 251, 308`).

`apps/hub/src/routes/fleet-dispatchable.ts` — `DispatchableDeps` gains `verifyPlane?`; at the top of the handler, after the `Bearer` match:

```ts
    let claims: Record<string, unknown>;
    if (orgPlane()) {
      const r = await (deps.verifyPlane ?? verifyPlaneBearer)(match[1]!);
      if (!r.ok) {
        return r.status === 403
          ? c.json(r.body, 403)
          : c.json(refuse("That token is not one this hub will accept: it is unknown, expired, signed by somebody else, or was not issued for this hub."), 401);
      }
      claims = r.caller.claims as Record<string, unknown>;
    } else {
      // existing try { jwtVerify(...) } catch { … } block, unchanged
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test` (whole suite — the legacy doors' existing tests, e.g. `src/auth/hub-token-middleware.test.ts`, `src/routes/fleet-dispatchable.test.ts`, must stay green). Expected: PASS. Revert-proof: move the plane branch below `if (existingUser && existingUser.id !== "anonymous") return next();` and watch "no dual-accept" go red.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/hub-token.ts apps/hub/src/auth/middleware.ts apps/hub/src/mcp/auth.ts apps/hub/src/index.ts apps/hub/src/routes/evidence.ts apps/hub/src/routes/evidence.test.ts apps/hub/src/routes/fleet-dispatchable.ts apps/hub/src/auth/org-plane/middleware.test.ts apps/hub/src/auth/org-plane/doors.test.ts
git commit -m "feat(hub): verify org-plane tokens at every door when ORG_PLANE_* is set; no dual-accept"
```

---

### Task 6: The one HTTP client to the plane

**Files:**
- Create: `apps/hub/src/services/org-plane/client.ts`
- Create: `apps/hub/src/services/org-plane/client.test.ts`

**Interfaces:**
- Consumes: `orgPlane()`, `ServiceCredential`, `TEST_PLANE` (Task 1).
- Produces:
  - `class OrgPlaneError extends Error { readonly status: number; readonly code: string }` — `status: 0, code: "unreachable"` for network failures and timeouts.
  - `interface PlaneGrant { mayDispatch: string[]; mayGrantReach: boolean; scopes: string[] }`
  - `interface PlanePrincipal { id: string; kind: "human" | "agent" | "service"; handle: string; displayName: string | null; organizationId: string | null; suspended: boolean; grant: PlaneGrant | null }` (contract §3.5)
  - `interface OrgPlaneClient`:
    - `agentToken(principal: string, audience: string | string[]): Promise<{ accessToken: string; expiresIn: number }>`
    - `assertionToken(identity: { system: string; externalId: string }, audience: string): Promise<{ accessToken: string; expiresIn: number }>` (contract §3.4b)
    - `createAgent(input: { handle: string; displayName: string }): Promise<{ id: string }>`
    - `putGrant(id: string, grant: PlaneGrant): Promise<void>`
    - `linkIdentity(id: string, system: string, externalId: string): Promise<void>`
    - `lookupIdentity(system: string, externalId: string): Promise<{ principalId: string; kind: "human" | "agent" | "service"; suspended: boolean } | null>`
    - `getPrincipal(id: string): Promise<PlanePrincipal | null>`
    - `listPrincipals(kind: "human" | "agent" | "service"): Promise<PlanePrincipal[]>` (contract §3.5; `kind` is required)
  - `createOrgPlaneClient(o: { url: string; credential: ServiceCredential; fetch?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number }): OrgPlaneClient`
  - `orgPlaneClient(): OrgPlaneClient` (singleton from `orgPlane()`; throws in legacy mode) and `setOrgPlaneClientForTests(c: OrgPlaneClient | null): () => void`.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/services/org-plane/client.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createOrgPlaneClient, OrgPlaneError } from "./client";
import { TEST_PLANE } from "../../auth/org-plane/config";

type Seen = { url: string; method: string; auth: string | null; body: unknown };

function fake(respond: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const s: Seen = {
      url,
      method: init.method ?? "GET",
      auth: new Headers(init.headers).get("authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    return respond(s);
  };
  return { seen, client: createOrgPlaneClient({ url: TEST_PLANE.url, credential: TEST_PLANE.serviceCredential, fetch }) };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OrgPlaneClient", () => {
  test("agentToken posts principal and audience with the hub's svc_ credential", async () => {
    const { seen, client } = fake(() => json(200, { access_token: "tok", token_type: "Bearer", expires_in: 300 }));
    expect(await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", "https://hub.test")).toEqual({ accessToken: "tok", expiresIn: 300 });
    expect(seen[0]).toEqual({
      url: "https://accounts.test/api/token/agent",
      method: "POST",
      auth: "Bearer svc_0123456789abcdef0123:s3cret",
      body: { principal: "prn_aaaaaaaaaaaaaaaaaaaa", audience: "https://hub.test" },
    });
  });

  test.each([
    [403, "not_permitted"],
    [404, "unknown_principal"],
    [423, "suspended"],
  ])("agentToken maps %i to OrgPlaneError(%s)", async (status, code) => {
    const { client } = fake(() => json(status, { error: code }));
    const err = await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", "a").catch((e) => e);
    expect(err).toBeInstanceOf(OrgPlaneError);
    expect([err.status, err.code]).toEqual([status, code]);
  });

  test("a network failure is OrgPlaneError(0, unreachable) and never leaks the secret", async () => {
    const client = createOrgPlaneClient({
      url: TEST_PLANE.url,
      credential: TEST_PLANE.serviceCredential,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const err = await client.getPrincipal("prn_aaaaaaaaaaaaaaaaaaaa").catch((e) => e);
    expect([err.status, err.code]).toEqual([0, "unreachable"]);
    expect(String(err.message)).not.toContain("s3cret");
  });

  test("lookupIdentity percent-encodes the mxid and answers null on 404", async () => {
    const { seen, client } = fake(() => json(404, { error: "not_found" }));
    expect(await client.lookupIdentity("matrix", "@agent_x:id.agentpod.dev")).toBeNull();
    expect(seen[0]!.url).toBe("https://accounts.test/api/identities/matrix/%40agent_x%3Aid.agentpod.dev");
  });

  test("getPrincipal returns the principal and its grant", async () => {
    const p = {
      id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "cody", displayName: "Cody", organizationId: "org_00000000000000000000",
      suspended: false, grant: { mayDispatch: [], mayGrantReach: false, scopes: ["runs:write"] },
    };
    const { client } = fake(() => json(200, p));
    expect(await client.getPrincipal(p.id)).toEqual(p as never);
  });

  test("assertionToken sends the Matrix identity, never a prn_ (contract §3.4b)", async () => {
    const { seen, client } = fake(() => json(200, { access_token: "a", token_type: "Bearer", expires_in: 120 }));
    expect(await client.assertionToken({ system: "matrix", externalId: "@op:id.test" }, "https://app.test")).toEqual({ accessToken: "a", expiresIn: 120 });
    expect(seen[0]!.url).toBe("https://accounts.test/api/token/assertion");
    expect(seen[0]!.body).toEqual({ identity: { system: "matrix", externalId: "@op:id.test" }, audience: "https://app.test" });
  });

  test("listPrincipals always names a kind", async () => {
    const { seen, client } = fake(() => json(200, []));
    await client.listPrincipals("agent");
    expect(seen[0]!.url).toBe("https://accounts.test/api/principals?kind=agent");
  });

  test("createAgent, putGrant, linkIdentity, suspend shapes", async () => {
    const { seen, client } = fake((s) => (s.method === "POST" && s.url.endsWith("/api/principals") ? json(201, { id: "prn_bbbbbbbbbbbbbbbbbbbb" }) : json(200, {})));
    expect(await client.createAgent({ handle: "cody", displayName: "Cody" })).toEqual({ id: "prn_bbbbbbbbbbbbbbbbbbbb" });
    await client.putGrant("prn_bbbbbbbbbbbbbbbbbbbb", { mayDispatch: [], mayGrantReach: false, scopes: [] });
    await client.linkIdentity("prn_bbbbbbbbbbbbbbbbbbbb", "matrix", "@agent_cody:id.agentpod.dev");
    expect(seen.map((s) => `${s.method} ${s.url.replace(TEST_PLANE.url, "")}`)).toEqual([
      "POST /api/principals",
      "PUT /api/principals/prn_bbbbbbbbbbbbbbbbbbbb/grants",
      "PUT /api/principals/prn_bbbbbbbbbbbbbbbbbbbb/identities/matrix",
    ]);
    expect(seen[0]!.body).toEqual({ kind: "agent", handle: "cody", displayName: "Cody" });
    expect(seen[2]!.body).toEqual({ externalId: "@agent_cody:id.agentpod.dev" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && bun test src/services/org-plane/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/services/org-plane/client.ts`:

```ts
/**
 * Every call the hub makes to the organization plane, in one place, authenticated with the
 * hub's own `svc_` credential (contract §3, §3.4b, §3.5). A shape change at the plane is a
 * change here only.
 */
import { orgPlane, type ServiceCredential } from "../../auth/org-plane/config";

export class OrgPlaneError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`org plane answered ${status === 0 ? "nothing" : status} (${code})`);
    this.name = "OrgPlaneError";
  }
}

export interface PlaneGrant { mayDispatch: string[]; mayGrantReach: boolean; scopes: string[] }
export type PlaneKind = "human" | "agent" | "service";
export interface PlanePrincipal {
  id: string;
  kind: PlaneKind;
  handle: string;
  displayName: string | null;
  organizationId: string | null;
  suspended: boolean;
  grant: PlaneGrant | null;
}
export interface PlaneToken { accessToken: string; expiresIn: number }

export interface OrgPlaneClient {
  agentToken(principal: string, audience: string | string[]): Promise<PlaneToken>;
  assertionToken(identity: { system: string; externalId: string }, audience: string): Promise<PlaneToken>;
  createAgent(input: { handle: string; displayName: string }): Promise<{ id: string }>;
  putGrant(id: string, grant: PlaneGrant): Promise<void>;
  linkIdentity(id: string, system: string, externalId: string): Promise<void>;
  lookupIdentity(system: string, externalId: string): Promise<{ principalId: string; kind: PlaneKind; suspended: boolean } | null>;
  getPrincipal(id: string): Promise<PlanePrincipal | null>;
  listPrincipals(kind: PlaneKind): Promise<PlanePrincipal[]>;
  suspend(id: string): Promise<void>;
  unsuspend(id: string): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function createOrgPlaneClient(o: {
  url: string;
  credential: ServiceCredential;
  fetch?: Fetch;
  timeoutMs?: number;
}): OrgPlaneClient {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = o.timeoutMs ?? 5_000;
  const authorization = `Bearer ${o.credential.id}:${o.credential.secret}`;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await doFetch(`${o.url}${path}`, {
        method,
        headers: { authorization, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new OrgPlaneError(0, "unreachable");
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  function ok(r: { status: number; json: any }, allowNotFound = false): any {
    if (r.status >= 200 && r.status < 300) return r.json;
    if (allowNotFound && r.status === 404) return null;
    throw new OrgPlaneError(r.status, typeof r.json?.error === "string" ? r.json.error : "error");
  }

  const token = (r: { status: number; json: any }): PlaneToken => {
    const j = ok(r);
    return { accessToken: j.access_token, expiresIn: j.expires_in };
  };

  return {
    agentToken: async (principal, audience) => token(await call("POST", "/api/token/agent", { principal, audience })),
    assertionToken: async (identity, audience) => token(await call("POST", "/api/token/assertion", { identity, audience })),
    createAgent: async ({ handle, displayName }) => ok(await call("POST", "/api/principals", { kind: "agent", handle, displayName })),
    putGrant: async (id, grant) => void ok(await call("PUT", `/api/principals/${enc(id)}/grants`, grant)),
    linkIdentity: async (id, system, externalId) =>
      void ok(await call("PUT", `/api/principals/${enc(id)}/identities/${enc(system)}`, { externalId })),
    lookupIdentity: async (system, externalId) =>
      ok(await call("GET", `/api/identities/${enc(system)}/${enc(externalId)}`), true),
    getPrincipal: async (id) => ok(await call("GET", `/api/principals/${enc(id)}`), true),
    listPrincipals: async (kind) => ok(await call("GET", `/api/principals?kind=${enc(kind)}`)),
    suspend: async (id) => void ok(await call("POST", `/api/principals/${enc(id)}/suspend`)),
    unsuspend: async (id) => void ok(await call("POST", `/api/principals/${enc(id)}/unsuspend`)),
  };
}

let singleton: OrgPlaneClient | null = null;
let testOverride: OrgPlaneClient | null = null;

export function orgPlaneClient(): OrgPlaneClient {
  if (testOverride) return testOverride;
  const plane = orgPlane();
  if (!plane) throw new Error("orgPlaneClient() called with ORG_PLANE_* unset");
  singleton ??= createOrgPlaneClient({ url: plane.url, credential: plane.serviceCredential });
  return singleton;
}

export function setOrgPlaneClientForTests(c: OrgPlaneClient | null): () => void {
  const previous = testOverride;
  testOverride = c;
  return () => {
    testOverride = previous;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/hub && bun test src/services/org-plane/client.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/org-plane/
git commit -m "feat(hub): org-plane HTTP client authenticated with the hub's svc_ credential"
```

---

### Task 7: Station tokens come from the plane

**Files:**
- Modify: `apps/hub/src/routes/station-token.ts:53-149` (factory + plane branch)
- Modify: `apps/hub/src/routes/station-token.test.ts` (new `describe` block)
- Modify: `apps/hub/src/index.ts:258` (`stationTokenRoutes` stays the exported default instance — no change needed if the export name is kept)

**Interfaces:**
- Consumes: `orgPlane()`, `OrgPlaneConfig`, `TEST_PLANE` (Task 1); `OrgPlaneClient.agentToken`, `OrgPlaneError` (Task 6); `STATION_TOKEN_AUDIENCES`, `HUB_AUDIENCE` (`apps/hub/src/config.ts:430,455`).
- Produces: `createStationTokenRoutes(deps?: { plane?: () => OrgPlaneConfig | null; client?: () => Pick<OrgPlaneClient, "agentToken"> }): Hono`; `stationTokenRoutes = createStationTokenRoutes()`; `stationAudiences(plane: OrgPlaneConfig): string[]`. Response shape unchanged: `{ token, expiresIn }` — the node's `internal/stationtoken` reads only these (`apps/node-agent/internal/stationtoken/stationtoken.go:118-137`), so no node release is needed.

Node authentication and the station binding stay exactly as today (`station-token.ts:64-99`): the plane is asked only after the hub has proven the node and found its station's principal. Under the plane, the hub has no signing key to fall back on.

- [ ] **Step 1: Write the failing test**

Append to `apps/hub/src/routes/station-token.test.ts` (it already has `nodeId`, `nodeSecret`, `stationId`, `agentPrincipalId`, `unoccupied` from its `beforeAll`):

```ts
import { createStationTokenRoutes, stationAudiences } from "./station-token";
import { TEST_PLANE } from "../auth/org-plane/config";
import { OrgPlaneError } from "../services/org-plane/client";

describe("under the org plane", () => {
  const asked: Array<{ principal: string; audience: string | string[] }> = [];
  const planeApp = (agentToken: (p: string, a: string | string[]) => Promise<{ accessToken: string; expiresIn: number }>) =>
    new Hono().route(
      "/api",
      createStationTokenRoutes({ plane: () => TEST_PLANE, client: () => ({ agentToken }) }),
    );
  const post = (app: Hono, station: string, secret = nodeSecret) =>
    app.request(`/api/nodes/${nodeId}/stations/${station}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${secret}` },
    });

  test("asks the plane for the station's agent, for the hub's audience, and returns its token", async () => {
    const app = planeApp(async (principal, audience) => {
      asked.push({ principal, audience });
      return { accessToken: "plane-token", expiresIn: 300 };
    });
    const res = await post(app, stationId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "plane-token", expiresIn: 300 });
    expect(asked.at(-1)).toEqual({ principal: agentPrincipalId, audience: TEST_PLANE.audience });
  });

  test("a wrong node secret never reaches the plane", async () => {
    let called = false;
    const res = await post(planeApp(async () => ((called = true), { accessToken: "x", expiresIn: 300 })), stationId, "wrong");
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  test("an unoccupied station is still 409 without asking the plane", async () => {
    let called = false;
    const res = await post(planeApp(async () => ((called = true), { accessToken: "x", expiresIn: 300 })), unoccupied);
    expect(res.status).toBe(409);
    expect(called).toBe(false);
  });

  test.each([
    [423, "suspended", 403, "principal suspended"],
    [404, "unknown_principal", 409, "station's principal is unknown to the org plane"],
    [403, "not_permitted", 502, "the org plane refused this hub"],
    [0, "unreachable", 503, "the org plane is unreachable"],
  ])("plane %i %s → %i", async (status, code, want, message) => {
    const res = await post(planeApp(async () => { throw new OrgPlaneError(status, code); }), stationId);
    expect(res.status).toBe(want);
    expect(await res.json()).toEqual({ error: message });
  });

  test("the hub's own audience is the plane's, with configured work planes after it", () => {
    expect(stationAudiences(TEST_PLANE)[0]).toBe(TEST_PLANE.audience);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/station-token.test.ts`
Expected: FAIL — `createStationTokenRoutes` is not exported.

- [ ] **Step 3: Write the implementation**

In `apps/hub/src/routes/station-token.ts`, wrap the existing handler in a factory and branch after the `principalId` check (line 99):

```ts
import { decodeJwt } from "jose";
import { orgPlane, type OrgPlaneConfig } from "../auth/org-plane/config";
import { orgPlaneClient, OrgPlaneError, type OrgPlaneClient } from "../services/org-plane/client";
import { HUB_AUDIENCE, STATION_TOKEN_AUDIENCES } from "../config";
import { createLogger } from "../utils/logger";

const log = createLogger("station-token");

/** The plane's audience for this hub first, then any configured work planes (contract §3.4: string or array). */
export function stationAudiences(plane: OrgPlaneConfig): string[] {
  return [plane.audience, ...STATION_TOKEN_AUDIENCES.filter((a) => a !== HUB_AUDIENCE && a !== plane.audience)];
}

const PLANE_REFUSALS: Record<number, [number, string]> = {
  423: [403, "principal suspended"],
  404: [409, "station's principal is unknown to the org plane"],
  403: [502, "the org plane refused this hub"],
  0: [503, "the org plane is unreachable"],
};

export function createStationTokenRoutes(
  deps: { plane?: () => OrgPlaneConfig | null; client?: () => Pick<OrgPlaneClient, "agentToken"> } = {},
) {
  return new Hono().post("/nodes/:nodeId/stations/:stationId/token", async (c) => {
    // …lines 56-99 unchanged: node credential, station binding, occupying principal…

    const plane = (deps.plane ?? orgPlane)();
    if (plane) {
      const audiences = stationAudiences(plane);
      try {
        const { accessToken, expiresIn } = await (deps.client ?? orgPlaneClient)().agentToken(
          station.principalId,
          audiences.length === 1 ? audiences[0]! : audiences,
        );
        // Gap G5: the plane's act.sub names the hub, not the node. Keep the node in the hub's record.
        let jti: unknown;
        try {
          jti = decodeJwt(accessToken).jti;
        } catch {
          jti = null;
        }
        log.info("station token issued by the org plane", { nodeId, stationId, principal: station.principalId, jti });
        return c.json({ token: accessToken, expiresIn });
      } catch (e) {
        if (e instanceof OrgPlaneError) {
          const [status, message] = PLANE_REFUSALS[e.status] ?? [502, "the org plane refused this hub"];
          log.warn("org plane refused a station token", { nodeId, stationId, status: e.status, code: e.code });
          return c.json({ error: message }, status as 403 | 409 | 502 | 503);
        }
        throw e;
      }
    }

    // …lines 101-147 unchanged: buildTokenPayload + signServiceToken…
  });
}

export const stationTokenRoutes = createStationTokenRoutes();
```

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS, including every pre-existing case in the file (legacy mode). Revert-proof: move the plane branch above the node-credential check and watch "a wrong node secret never reaches the plane" fail.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/routes/station-token.ts apps/hub/src/routes/station-token.test.ts
git commit -m "feat(hub): station token exchange asks the org plane for the agent's token when configured"
```

---

### Task 8: The hub stops issuing under the plane

Under the plane the hub signs nothing. These routes mint or serve the hub's issuer and answer **410** with `{ error: "issuer_moved", issuer: <ORG_PLANE_ISSUER> }`:

| Route | Defined at | Mounted at `src/index.ts` |
|---|---|---|
| `GET /api/auth/jwks` | `src/index.ts:187-197` | 187 |
| `GET /api/auth/authorize`, `POST /api/auth/token/exchange` | `src/routes/auth-authorize.ts:210,383` | 213 |
| `POST /api/auth/devices/token`, `POST/GET /api/auth/devices`, `DELETE /api/auth/devices/:id` | `src/routes/devices.ts:123,192,218,231` | 236 |
| `POST /api/auth/service-token` | `src/routes/service-token.ts:27` | 242 |
| Better Auth catch-all `GET|POST /api/auth/*` (sign-in, sign-up, session, `GET /api/auth/token`) | `src/index.ts:244-246` | 244 |

One middleware on `/api/auth/*`, registered **before** `signupCheckMiddleware` (`src/index.ts:169`), covers all of them; in legacy mode it calls `next()` and nothing changes.

**Files:**
- Create: `apps/hub/src/auth/org-plane/retired.ts`
- Create: `apps/hub/src/auth/org-plane/retired.test.ts`
- Modify: `apps/hub/src/index.ts:169` (insert one `.use` above it)

**Interfaces:**
- Consumes: `orgPlane()`, `OrgPlaneConfig`, `TEST_PLANE` (Task 1).
- Produces: `retiredIssuerRoutes(plane?: () => OrgPlaneConfig | null): MiddlewareHandler`.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/auth/org-plane/retired.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { retiredIssuerRoutes } from "./retired";
import { TEST_PLANE } from "./config";

const app = (plane: typeof TEST_PLANE | null) =>
  new Hono()
    .use("/api/auth/*", retiredIssuerRoutes(() => plane))
    .all("/api/auth/*", (c) => c.text("legacy"));

describe("retiredIssuerRoutes", () => {
  test.each([
    ["GET", "/api/auth/jwks"],
    ["GET", "/api/auth/authorize?client=apn"],
    ["POST", "/api/auth/token/exchange"],
    ["POST", "/api/auth/devices/token"],
    ["GET", "/api/auth/devices"],
    ["POST", "/api/auth/service-token"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/auth/token"],
  ])("%s %s is 410 issuer_moved under the plane", async (method, path) => {
    const res = await app(TEST_PLANE).request(path, { method });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "issuer_moved", issuer: TEST_PLANE.issuer });
  });

  test("legacy mode passes everything through", async () => {
    expect(await (await app(null).request("/api/auth/jwks")).text()).toBe("legacy");
  });

  test("index.ts registers it before every /api/auth route", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "index.ts"), "utf8");
    const at = src.indexOf(".use('/api/auth/*', retiredIssuerRoutes())");
    expect(at).toBeGreaterThan(-1);
    for (const later of [".use('/api/auth/*', signupCheckMiddleware)", ".get('/api/auth/jwks'", ".route('/api/auth', deviceRoutes)", ".route('/api/auth', serviceTokenRoutes)", ".on(['GET', 'POST'], '/api/auth/*'"]) {
      expect(src.indexOf(later)).toBeGreaterThan(at);
    }
    expect(src.indexOf(".route('/', authorizeRoutes)")).toBeGreaterThan(at);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && bun test src/auth/org-plane/retired.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/auth/org-plane/retired.ts`:

```ts
import { createMiddleware } from "hono/factory";
import { orgPlane, type OrgPlaneConfig } from "./config";

/**
 * Under the plane the hub mints nothing and serves no key set (contract §4). 410, not 404:
 * the route existed and moved, and the body says where.
 */
export function retiredIssuerRoutes(plane: () => OrgPlaneConfig | null = orgPlane) {
  return createMiddleware(async (c, next) => {
    const p = plane();
    if (!p) return next();
    return c.json({ error: "issuer_moved", issuer: p.issuer }, 410);
  });
}
```

`apps/hub/src/index.ts` — immediately above line 169 (`.use('/api/auth/*', signupCheckMiddleware)`):

```ts
  // Under ORG_PLANE_* the hub is a pure resource server: every issuer route answers 410.
  .use('/api/auth/*', retiredIssuerRoutes())
```

`/api/auth/authorize` is mounted through `.route('/', authorizeRoutes)` at line 213, which is below 169, so the same middleware covers it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test` — Expected: PASS (existing source-order tests in `src/routes/devices.test.ts:255-268`, `tests/integration/service-token.test.ts:245-255`, `src/routes/auth-authorize.test.ts:469-471` still hold: nothing they order moved).

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/org-plane/retired.ts apps/hub/src/auth/org-plane/retired.test.ts apps/hub/src/index.ts
git commit -m "feat(hub): 410 issuer_moved for every hub issuer route when ORG_PLANE_* is set"
```

---

### Task 9: Principal and grant reads through the plane; Matrix sender via `GET /api/identities/matrix/:mxid`

After cutover the hub's `principals`, `principal_identities` and `principal_grants` are frozen copies (contract §4: dropped after the rollback window), so every read must come from the plane. The callers are many — `principalById` has 12 call sites, `principalHandle` 25, `getGrant` 11, `principalForUser` 14 (listed in `apps/hub/src/services/principals.ts` and `services/grants.ts` by `grep -rn`). Rather than touch each caller, the exported functions switch implementation internally; the callers keep their signatures.

**The §5.7 caveat, stated once.** Design §5.7 allows exactly one plane call on an authorization path: resolving a Matrix sender. Matrix inbound dispatch (`services/matrix-as/inbound.ts:468-489`) then reads the sender's grant — which, with the grant no longer in the hub, is a second plane read on the same path. It goes through the same 60-second cache with last-good-on-outage, so a sender seen in the last minute (or ever, while the plane is down) still resolves; a sender never seen while the plane is down is refused and told why. Every token-bearing path (`authMiddleware`, MCP, evidence, dispatchable, station token) authorizes from the token and does not use this directory.

**Files:**
- Create: `apps/hub/src/services/org-plane/directory.ts`
- Create: `apps/hub/src/services/org-plane/directory.test.ts`
- Modify: `apps/hub/src/services/principals.ts:29` (`createPrincipal`), `:72` (`principalForUser`), `:118` (`principalById`), `:165` (`suspendPrincipal`), `:173` (`restorePrincipal`), `:191` (`principalHandle`), `:220` (`listPrincipals`); add `humanPrincipalIdForUser`
- Modify: `apps/hub/src/services/grants.ts:71` (`getGrant`), `:93` (`setGrant`), `:131` (`deleteGrant`), `:136` (`listGrants`)
- Modify: `apps/hub/src/services/matrix-identity.ts:47-100` (`resolveMatrixId`)
- Modify: `apps/hub/src/services/matrix-as/gates.ts:587` (reason union), `:744-752`
- Modify: `apps/hub/src/services/matrix-as/elicitations.ts:411` (same handling)
- Modify: `apps/hub/src/services/matrix-as/inbound.ts:468`
- Create: `apps/hub/src/services/org-plane/plane-reads.test.ts`
- Modify: `apps/hub/src/routes/evidence.ts:102-111` (`principalIdFor`) and `:233-245` (`GET /api/evidence/principals/:principalId`)
- Modify: `apps/hub/src/routes/evidence.test.ts` (plane-mode case for the principals route)
- Create: `apps/hub/src/db/schema/legacy-user-principals.ts`, `apps/hub/src/db/drizzle-migrations/0093_legacy_user_principals.sql`; Modify: `apps/hub/src/db/schema/index.ts`

**Superwitness's principal lookup stays.** Superwitness's run join displays principals by calling `GET /api/evidence/principals/:principalId` (`apps/hub/src/routes/evidence.ts:233-245`), which today reads the hub's `principals` table directly with drizzle — not through `principalById` — so switching `principalById` alone would leave it reading a frozen table that Task 17 drops. This task backs it with the plane: the route reads `principalById` (plane-backed, via the hub's `svc_` with `principals:read`, cached 60 s with last-good), and `principalIdFor` keeps resolving a historical Better Auth user id (superpipeline's `decided_by_hub_sub` on decisions made before cutover) through `legacy_user_principals`, a permanent two-column copy of the `better-auth` identity mapping that this task creates, Task 13 fills, and Task 17 keeps. Response shape and status codes are unchanged (`{ id, kind, handle, suspended }`, 404 `not_found`), so **no superwitness change follows**; superwitness only has to hold a plane-issued service token for the hub's audience, which is its own P3 work (contract §4, "gets its service token from 3.3").

**Interfaces:**
- Consumes: `OrgPlaneClient`, `PlanePrincipal`, `PlaneKind`, `OrgPlaneError`, `orgPlaneClient`, `setOrgPlaneClientForTests` (Task 6); `orgPlane`, `setOrgPlaneForTests`, `TEST_PLANE` (Task 1).
- Produces:
  - `interface PrincipalDirectory { principal(id: string): Promise<PlanePrincipal | null>; identity(system: string, externalId: string): Promise<{ principalId: string; kind: PlaneKind; suspended: boolean } | null>; list(kind?: PlaneKind): Promise<PlanePrincipal[]>; invalidate(id?: string): void }`
  - `createPrincipalDirectory(o: { client: () => Pick<OrgPlaneClient, "getPrincipal" | "lookupIdentity" | "listPrincipals">; ttlMs?: number; now?: () => number }): PrincipalDirectory`
  - `principalDirectory(): PrincipalDirectory`, `setPrincipalDirectoryForTests(d: PrincipalDirectory | null): () => void`
  - `humanPrincipalIdForUser(userId: string): Promise<string | null>` in `services/principals.ts` — the human principal behind an `AuthUser.id`; under the plane the id *is* the principal.
  - `SUSPENDED_AT_UNKNOWN: Date` (= `new Date(0)`) — what `suspendedAt` reads as for a principal the plane reports suspended (the plane gives a boolean, callers test truthiness).
  - `GET /api/evidence/principals/:principalId` answers from `principalById` in both modes; under the plane a non-`prn_` segment resolves through `legacy_user_principals` (table created here, filled by Task 13).
  - `resolveMatrixId` throws `OrgPlaneError` (status 0) when the plane is unreachable and nothing is cached; `GateOutcome` reason union gains `"identity-unavailable"`.

- [ ] **Step 1: Write the failing tests**

`apps/hub/src/services/org-plane/directory.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createPrincipalDirectory } from "./directory";
import { OrgPlaneError, type PlanePrincipal } from "./client";

const P: PlanePrincipal = {
  id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "cody", displayName: "Cody", organizationId: "org_00000000000000000000",
  suspended: false, grant: { mayDispatch: [], mayGrantReach: false, scopes: [] },
};

function setup() {
  const state = { down: false, calls: 0 };
  let now = 1_000_000;
  const client = () => ({
    getPrincipal: async (id: string) => {
      state.calls++;
      if (state.down) throw new OrgPlaneError(0, "unreachable");
      return id === P.id ? P : null;
    },
    lookupIdentity: async () => {
      state.calls++;
      if (state.down) throw new OrgPlaneError(0, "unreachable");
      return { principalId: P.id, kind: "agent" as const, suspended: false };
    },
    listPrincipals: async (kind: string) => (kind === P.kind ? [P] : []),
  });
  const dir = createPrincipalDirectory({ client, ttlMs: 60_000, now: () => now });
  return { state, dir, advance: (ms: number) => (now += ms) };
}

describe("PrincipalDirectory", () => {
  test("caches for the TTL", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    await dir.principal(P.id);
    expect(state.calls).toBe(1);
    advance(60_000);
    await dir.principal(P.id);
    expect(state.calls).toBe(2);
  });

  test("serves a stale entry while the plane is down", async () => {
    const { state, dir, advance } = setup();
    await dir.principal(P.id);
    state.down = true;
    advance(10 * 60_000);
    expect(await dir.principal(P.id)).toEqual(P);
  });

  test("a cold miss while the plane is down throws, so callers fail closed and can say why", async () => {
    const { state, dir } = setup();
    state.down = true;
    await expect(dir.identity("matrix", "@x:id.test")).rejects.toBeInstanceOf(OrgPlaneError);
  });

  test("an unknown principal is cached as null too", async () => {
    const { state, dir } = setup();
    expect(await dir.principal("prn_bbbbbbbbbbbbbbbbbbbb")).toBeNull();
    await dir.principal("prn_bbbbbbbbbbbbbbbbbbbb");
    expect(state.calls).toBe(1);
  });

  test("invalidate(id) forces the next read", async () => {
    const { state, dir } = setup();
    await dir.principal(P.id);
    dir.invalidate(P.id);
    await dir.principal(P.id);
    expect(state.calls).toBe(2);
  });
});
```

`apps/hub/src/services/org-plane/plane-reads.test.ts`:

```ts
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { setOrgPlaneForTests, TEST_PLANE } from "../../auth/org-plane/config";
import { setPrincipalDirectoryForTests, type PrincipalDirectory } from "./directory";
import { OrgPlaneError, type PlanePrincipal } from "./client";
import { principalById, principalForUser, principalHandle, humanPrincipalIdForUser, SUSPENDED_AT_UNKNOWN } from "../principals";
import { getGrant } from "../grants";
import { resolveMatrixId } from "../matrix-identity";

const HUMAN: PlanePrincipal = {
  id: "prn_hhhhhhhhhhhhhhhhhhhh", kind: "human", handle: "op", displayName: "Op", organizationId: null,
  suspended: false,
  grant: { mayDispatch: ["prn_aaaaaaaaaaaaaaaaaaaa"], mayGrantReach: true, scopes: [] },
};
const AGENT: PlanePrincipal = { ...HUMAN, id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "cody", suspended: true, grant: null };

function dir(over: Partial<PrincipalDirectory> = {}): PrincipalDirectory {
  const all = new Map([HUMAN, AGENT].map((p) => [p.id, p]));
  return {
    principal: async (id) => all.get(id) ?? null,
    identity: async (system, ext) => (system === "matrix" && ext === "@op:id.test" ? { principalId: HUMAN.id, kind: "human", suspended: false } : null),
    list: async () => [...all.values()],
    invalidate: () => {},
    ...over,
  };
}

const restores: Array<() => void> = [];
beforeAll(ensurePgMigrations);
afterEach(() => restores.splice(0).forEach((r) => r()));
function plane(d = dir()) {
  restores.push(setOrgPlaneForTests(TEST_PLANE), setPrincipalDirectoryForTests(d));
}

describe("principal reads under the plane", () => {
  test("principalById maps the plane's principal; suspended reads as a truthy suspendedAt", async () => {
    plane();
    // The plane's principal read carries no email; nothing under the plane needs it.
    expect(await principalById(HUMAN.id)).toEqual({ id: HUMAN.id, kind: "human", suspendedAt: null, email: null, emailVerified: null });
    expect((await principalById(AGENT.id))?.suspendedAt).toBe(SUSPENDED_AT_UNKNOWN);
  });

  test("principalForUser: an AuthUser.id is a prn_, and only a human answers", async () => {
    plane();
    expect((await principalForUser(HUMAN.id))?.id).toBe(HUMAN.id);
    expect(await principalForUser(AGENT.id)).toBeNull();
  });

  test("principalHandle and getGrant read the plane's principal", async () => {
    plane();
    expect(await principalHandle(AGENT.id)).toBe("cody");
    expect(await getGrant(HUMAN.id)).toEqual(HUMAN.grant);
    expect(await getGrant(AGENT.id)).toBeNull();
  });

  test("humanPrincipalIdForUser is the identity under the plane", async () => {
    plane();
    expect(await humanPrincipalIdForUser(HUMAN.id)).toBe(HUMAN.id);
    expect(await humanPrincipalIdForUser("8b0c2f6e-1c1d-4e3a-9a57-0d6f3c2b1a90")).toBeNull();
  });
});

describe("Matrix sender under the plane", () => {
  test("a linked sender resolves through GET /api/identities/matrix/:mxid", async () => {
    plane();
    expect(await resolveMatrixId("@op:id.test")).toEqual({ kind: "principal", principalId: HUMAN.id });
  });

  test("an unlinked sender is null", async () => {
    plane();
    expect(await resolveMatrixId("@stranger:id.test")).toBeNull();
  });

  test("a plane outage with nothing cached throws OrgPlaneError rather than reading as 'unlinked'", async () => {
    plane(dir({ identity: async () => { throw new OrgPlaneError(0, "unreachable"); } }));
    await expect(resolveMatrixId("@op:id.test")).rejects.toBeInstanceOf(OrgPlaneError);
  });
});
```

Add to `apps/hub/src/services/matrix-as/gates.test.ts` (it builds `handleGateDecision` deps with fakes):

```ts
test("a plane outage while resolving the sender is refused as identity-unavailable, not unlinked", async () => {
  const result = await handleGateDecision(decisionEvent(), ROOM, {
    ...deps(),
    principalForMatrixId: async () => {
      throw new OrgPlaneError(0, "unreachable");
    },
  });
  expect(result).toEqual({ status: "refused", reason: "identity-unavailable" });
});
```

(`decisionEvent`, `ROOM` and `deps()` are whatever that file already uses for its "unlinked sender" case at the test for `reason: "unlinked-sender"`; reuse them.)

Add to `apps/hub/src/routes/evidence.test.ts` (superwitness's lookup — it already has a `get(path, token)` helper and a `serviceToken(reader)` minting helper used at lines 278-300):

```ts
describe("GET /api/evidence/principals/:id under the plane (superwitness's run join)", () => {
  test("answers from the plane's principal, same shape as before", async () => {
    const restores = [
      setOrgPlaneForTests(TEST_PLANE),
      setPrincipalDirectoryForTests({
        principal: async (id) =>
          id === "prn_aaaaaaaaaaaaaaaaaaaa"
            ? { id, kind: "agent", handle: "cody", displayName: "Cody", organizationId: "org_00000000000000000000", suspended: true, grant: null }
            : null,
        identity: async () => null,
        list: async () => [],
        invalidate: () => {},
      }),
    ];
    try {
      const app = createEvidenceRoutes({
        verifyPlane: async () => ({ ok: true, caller: { sub: "prn_ssssssssssssssssssss", principalKind: "service", tenantId: BOOTSTRAP_TENANT_ID, claims: { scope: "evidence:read" } as never } }),
      });
      const ok = await app.request("/api/evidence/principals/prn_aaaaaaaaaaaaaaaaaaaa", { headers: { Authorization: "Bearer t" } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "cody", suspended: true });
      const missing = await app.request("/api/evidence/principals/prn_bbbbbbbbbbbbbbbbbbbb", { headers: { Authorization: "Bearer t" } });
      expect(missing.status).toBe(404);
    } finally {
      restores.forEach((r) => r());
    }
  });
});
```

(Import `setPrincipalDirectoryForTests` from `../services/org-plane/directory` and `setOrgPlaneForTests, TEST_PLANE` from `../auth/org-plane/config`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/org-plane/ src/services/matrix-as/gates.test.ts`
Expected: FAIL — `./directory` missing; `humanPrincipalIdForUser`, `SUSPENDED_AT_UNKNOWN` not exported; gates throws instead of refusing.

- [ ] **Step 3: Write the directory**

`apps/hub/src/services/org-plane/directory.ts`:

```ts
/**
 * Principal reads from the plane, cached for 60 s, with the last good answer served while the
 * plane is unreachable — the same posture as the JWKS cache. 404 is an answer (cached as null);
 * a network failure or 5xx with nothing cached is thrown, so the caller fails closed and can say
 * the plane is down instead of "I do not recognise you".
 */
import { OrgPlaneError, orgPlaneClient, type OrgPlaneClient, type PlaneKind, type PlanePrincipal } from "./client";

type Identity = { principalId: string; kind: PlaneKind; suspended: boolean };
export interface PrincipalDirectory {
  principal(id: string): Promise<PlanePrincipal | null>;
  identity(system: string, externalId: string): Promise<Identity | null>;
  list(kind?: PlaneKind): Promise<PlanePrincipal[]>;
  invalidate(id?: string): void;
}

const transient = (e: unknown) => e instanceof OrgPlaneError && (e.status === 0 || e.status >= 500);

export function createPrincipalDirectory(o: {
  client: () => Pick<OrgPlaneClient, "getPrincipal" | "lookupIdentity" | "listPrincipals">;
  ttlMs?: number;
  now?: () => number;
}): PrincipalDirectory {
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { value: unknown; at: number }>();

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value as T;
    try {
      const value = await load();
      cache.set(key, { value, at: now() });
      return value;
    } catch (e) {
      if (hit && transient(e)) return hit.value as T;
      throw e;
    }
  }

  return {
    principal: (id) => cached(`p:${id}`, () => o.client().getPrincipal(id)),
    identity: (system, ext) => cached(`i:${system}:${ext}`, () => o.client().lookupIdentity(system, ext)),
    // The plane lists one kind per call (contract §3.5); "all" is three calls, cached as one.
    list: (kind) =>
      cached(`l:${kind ?? "*"}`, async () =>
        kind
          ? o.client().listPrincipals(kind)
          : (await Promise.all((["human", "agent", "service"] as const).map((k) => o.client().listPrincipals(k)))).flat(),
      ),
    invalidate: (id) => {
      if (!id) return cache.clear();
      cache.delete(`p:${id}`);
      for (const k of cache.keys()) if (k.startsWith("l:")) cache.delete(k);
    },
  };
}

let singleton: PrincipalDirectory | null = null;
let override: PrincipalDirectory | null = null;
export function principalDirectory(): PrincipalDirectory {
  if (override) return override;
  singleton ??= createPrincipalDirectory({ client: orgPlaneClient });
  return singleton;
}
export function setPrincipalDirectoryForTests(d: PrincipalDirectory | null): () => void {
  const previous = override;
  override = d;
  return () => {
    override = previous;
  };
}
```

- [ ] **Step 4: Switch the reads**

`apps/hub/src/services/principals.ts` — add near the top:

```ts
import { orgPlane } from "../auth/org-plane/config";
import { principalDirectory } from "./org-plane/directory";
import { orgPlaneClient, type PlanePrincipal } from "./org-plane/client";

/** The plane reports suspension as a boolean; callers test `suspendedAt` for truthiness. */
export const SUSPENDED_AT_UNKNOWN = new Date(0);

function fromPlane(p: PlanePrincipal): ResolvedPrincipal {
  return { id: p.id, kind: p.kind, suspendedAt: p.suspended ? SUSPENDED_AT_UNKNOWN : null, email: null, emailVerified: null };
}
```

and as the first statement of each function:

```ts
// principalById(id)
if (orgPlane()) {
  const p = await principalDirectory().principal(id);
  return p ? fromPlane(p) : null;
}

// principalForUser(userId) — under the plane an AuthUser.id is the human's prn_.
if (orgPlane()) {
  const p = await principalDirectory().principal(userId);
  return p && p.kind === "human" ? fromPlane(p) : null;
}

// principalHandle(id)
if (orgPlane()) return (await principalDirectory().principal(id))?.handle ?? null;

// listPrincipals()
if (orgPlane()) {
  return (await principalDirectory().list()).map((p) => ({
    id: p.id, kind: p.kind, handle: p.handle, displayName: p.displayName,
    userId: p.kind === "human" ? p.id : null,
    suspendedAt: p.suspended ? SUSPENDED_AT_UNKNOWN : null,
  }));
}

// createPrincipal(input, exec) — the plane creates agents only (contract §3.5); humans are
// created by signing up, services by the operator's `scripts/service.ts`.
if (orgPlane()) {
  if (input.kind !== "agent") throw new Error(`the org plane creates ${input.kind} principals itself`);
  const { id } = await orgPlaneClient().createAgent({ handle: input.handle, displayName: input.displayName ?? input.handle });
  principalDirectory().invalidate();
  return id;
}

// suspendPrincipal / restorePrincipal
if (orgPlane()) throw new Error("principal suspension is managed by the org plane");
```

New export:

```ts
/** The human principal behind an AuthUser.id. Under the plane they are the same string. */
export async function humanPrincipalIdForUser(userId: string): Promise<string | null> {
  if (orgPlane()) return /^prn_[0-9a-f]{20}$/.test(userId) ? userId : null;
  return (await principalForUser(userId))?.id ?? null;
}
```

`apps/hub/src/services/grants.ts` — first statement of each:

```ts
// getGrant(principalId)
if (orgPlane()) return (await principalDirectory().principal(principalId))?.grant ?? null;

// setGrant(principalId, grant, exec) — PUT replaces, so scopes the caller did not name are kept.
if (orgPlane()) {
  const current = grant.scopes === undefined ? (await principalDirectory().principal(principalId))?.grant : null;
  await orgPlaneClient().putGrant(principalId, {
    mayDispatch: grant.mayDispatch,
    mayGrantReach: grant.mayGrantReach,
    scopes: grant.scopes ?? current?.scopes ?? [],
  });
  principalDirectory().invalidate(principalId);
  return;
}

// deleteGrant / listGrants
if (orgPlane()) throw new Error("grants are managed by the org plane");
```

`apps/hub/src/services/matrix-identity.ts` — inside `resolveMatrixId`, replace the `principalRows` query with a mode switch (the station half stays local — stations are the hub's):

```ts
  const principalLookup = orgPlane()
    ? principalDirectory()
        .identity("matrix", mxid)
        .then((r) => (r ? [{ principalId: r.principalId }] : []))
    : db.select({ principalId: principalIdentities.principalId }).from(principalIdentities)
        .where(and(eq(principalIdentities.system, "matrix"), eq(principalIdentities.externalId, mxid)))
        .limit(2);
  const [stationRows, principalRows] = await Promise.all([stationQuery, principalLookup]);
```

(`stationQuery` is the existing `db.select(...).from(stations)...` expression, unchanged. An `OrgPlaneError` from the directory propagates out of `resolveMatrixId`.)

`apps/hub/src/services/matrix-as/gates.ts` — add `| "identity-unavailable"` to the reason union at line 587 and wrap line 744:

```ts
  let principal: Awaited<ReturnType<GateDeps["principalForMatrixId"]>>;
  try {
    principal = await deps.principalForMatrixId(event.sender);
  } catch (error) {
    // The one plane call design §5.7 allows. Down is not "unlinked": say which.
    log.warn("could not resolve a gate decision's sender", { sender: event.sender, error: String(error) });
    return { status: "refused", reason: "identity-unavailable" };
  }
```

(`GateDeps` is the deps interface declared at `gates.ts:661`; use its actual name.) Apply the same try/catch at `elicitations.ts:411`, returning `{ status: "refused", code: "IDENTITY_UNAVAILABLE" }`. In `inbound.ts:468` wrap `resolveMatrixId` and on `OrgPlaneError` call `say("I cannot check who you are right now — the account service is unreachable. Try again in a minute.")` and return.

`apps/hub/src/routes/evidence.ts` — the principals route reads through `principalById` instead of the table:

```ts
    .get("/api/evidence/principals/:principalId", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks, EVIDENCE_READ, deps.verifyPlane);
      if (!auth.ok) return c.json(refusal(auth.status), auth.status);
      const id = await principalIdFor(c.req.param("principalId"));
      if (!id) return c.json({ error: "not_found" }, 404);
      const p = await principalById(id);
      if (!p) return c.json({ error: "not_found" }, 404);
      // Still answered when suspended: a decision made before the suspension is still theirs.
      const handle = await principalHandle(id);
      return c.json({ id: p.id, kind: p.kind, handle, suspended: p.suspendedAt !== null });
    })
```

and `principalIdFor`, after the `PrincipalId` fast path, reads the permanent map under the plane:

```ts
  if (orgPlane()) {
    const [row] = await db
      .select({ principalId: legacyUserPrincipals.principalId })
      .from(legacyUserPrincipals)
      .where(eq(legacyUserPrincipals.userId, segment))
      .limit(1);
    return row?.principalId ?? null;
  }
```

`apps/hub/src/db/schema/legacy-user-principals.ts` (new; add `export * from "./legacy-user-principals";` to `apps/hub/src/db/schema/index.ts`):

```ts
import { pgTable, text } from "drizzle-orm/pg-core";

/**
 * Better Auth user id → human prn_, frozen at cutover by scripts/rewrite-user-ids.ts.
 * Permanent (Task 17 keeps it): other planes recorded hub user ids before the cutover
 * (superpipeline's decided_by_hub_sub), and those must keep resolving after the auth tables go.
 */
export const legacyUserPrincipals = pgTable("legacy_user_principals", {
  userId: text("user_id").primaryKey(),
  principalId: text("principal_id").notNull(),
});
```

`apps/hub/src/db/drizzle-migrations/0093_legacy_user_principals.sql` (via `bun run db:generate --name legacy_user_principals`):

```sql
CREATE TABLE IF NOT EXISTS "legacy_user_principals" (
	"user_id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL
);
```

Empty until Task 13's script fills it at cutover; harmless in legacy mode.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test` — Expected: PASS (whole suite: legacy branches untouched). Revert-proof: drop the `p.kind === "human"` guard in `principalForUser` and watch "only a human answers" fail.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/db/schema/legacy-user-principals.ts apps/hub/src/db/schema/index.ts apps/hub/src/db/drizzle-migrations/ apps/hub/src/routes/evidence.ts apps/hub/src/routes/evidence.test.ts apps/hub/src/services/org-plane/directory.ts apps/hub/src/services/org-plane/directory.test.ts apps/hub/src/services/org-plane/plane-reads.test.ts apps/hub/src/services/principals.ts apps/hub/src/services/grants.ts apps/hub/src/services/matrix-identity.ts apps/hub/src/services/matrix-as/gates.ts apps/hub/src/services/matrix-as/gates.test.ts apps/hub/src/services/matrix-as/elicitations.ts apps/hub/src/services/matrix-as/inbound.ts
git commit -m "feat(hub): principal, grant and Matrix-sender reads through the org plane, cached with last-good"
```

---

### Task 10: Gate approvals from chat come from the plane (contract §3.4b)

`mintPrincipalAssertion` (`apps/hub/src/auth/service-signing.ts:241-250`) is the hub's last signer after Tasks 7–8. It is called through the `mint(principalId)` dependency of `resolveGateAtSuperpipeline` (`services/matrix-as/gates.ts:845-859`) and `answerElicitationAtSuperpipeline` (`services/matrix-as/elicitations.ts:273-286`), wired at `services/matrix-as/index.ts:413-414` and `:488-489`. Under the plane the hub must not sign, and the plane's `POST /api/token/assertion` takes the sender's **Matrix identity**, not a `prn_` — the plane resolves the human itself so that no caller can name whom to assert. So the sender's mxid has to reach `mint`. Today it stops at `handleGateDecision` (`gates.ts:744`, `event.sender`) and `handleElicitationAnswer` (`elicitations.ts:411`).

The hub still resolves the sender first (Task 9: `principalForMatrixId`, used for the "is this a person?" check at `gates.ts:774-781` and the receipt). As defence in depth it checks that the plane's token names the same principal it resolved; a mismatch means the identity link changed between the two reads, and the answer is refused rather than recorded under someone else.

**Files:**
- Modify: `apps/hub/src/auth/service-signing.ts` (add `assertPrincipal`, `AssertionMismatch`)
- Modify: `apps/hub/src/services/matrix-as/gates.ts:679-686` (`resolveGate` input gains `senderMxid`), `:784-791` (pass `event.sender`), `:845-859` (`resolveGateAtSuperpipeline` input gains `senderMxid`; `mint` takes a subject object)
- Modify: `apps/hub/src/services/matrix-as/elicitations.ts:273-286` and the `answer` dependency at `:364` / its call at `:420` (same two changes)
- Modify: `apps/hub/src/services/matrix-as/index.ts:413-414,488-489`
- Modify: `apps/hub/src/auth/service-signing.test.ts`, `apps/hub/src/services/matrix-as/gates.test.ts`, `apps/hub/src/services/matrix-as/elicitations.test.ts`

**Interfaces:**
- Consumes: `orgPlane()` (Task 1); `OrgPlaneClient.assertionToken(identity, audience)`, `OrgPlaneError` (Task 6).
- Produces:
  - `interface AssertionSubject { principalId: string; senderMxid: string }`
  - `assertPrincipal(input: AssertionSubject & { audience: string }, deps?: { client?: () => Pick<OrgPlaneClient, "assertionToken"> }): Promise<string>` — legacy: `mintPrincipalAssertion({ principalId, audiences: [audience] })` (the mxid is unused); plane: `assertionToken({ system: "matrix", externalId: senderMxid }, audience)`, then checks the token's `sub` equals `principalId`.
  - `class AssertionMismatch extends Error`
  - `resolveGateAtSuperpipeline` / `answerElicitationAtSuperpipeline` deps: `mint(subject: AssertionSubject): Promise<string>`; inputs gain `senderMxid: string`.
  - `GateDeps.resolveGate` and the elicitation `answer` dependency inputs gain `senderMxid: string`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/hub/src/auth/service-signing.test.ts`:

```ts
import { SignJWT } from "jose";
import { AssertionMismatch, assertPrincipal } from "./service-signing";
import { setOrgPlaneForTests, TEST_PLANE } from "./org-plane/config";
import { OrgPlaneError } from "../services/org-plane/client";
import { serviceSigningKeys } from "../db/schema/service-keys";

/** An unsigned-enough JWT: assertPrincipal only decodes `sub`; Superpipeline verifies the signature. */
const tokenFor = (sub: string) =>
  new SignJWT({ sub }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("k".repeat(32)));

describe("assertPrincipal under the plane (contract §3.4b)", () => {
  const SUBJECT = { principalId: "prn_hhhhhhhhhhhhhhhhhhhh", senderMxid: "@op:id.test" };

  test("sends the sender's Matrix identity, returns the plane's token, touches no hub key", async () => {
    const before = (await db.select().from(serviceSigningKeys)).length;
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      const asked: unknown[] = [];
      const plane = await tokenFor(SUBJECT.principalId);
      const token = await assertPrincipal(
        { ...SUBJECT, audience: "https://app.superpipeline.test" },
        { client: () => ({ assertionToken: async (identity, audience) => (asked.push({ identity, audience }), { accessToken: plane, expiresIn: 120 }) }) },
      );
      expect(token).toBe(plane);
      expect(asked).toEqual([{ identity: { system: "matrix", externalId: "@op:id.test" }, audience: "https://app.superpipeline.test" }]);
    } finally {
      restore();
    }
    expect((await db.select().from(serviceSigningKeys)).length).toBe(before);
  });

  test("a plane token naming a different principal is refused", async () => {
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      const other = await tokenFor("prn_oooooooooooooooooooo");
      const err = await assertPrincipal(
        { ...SUBJECT, audience: "https://a" },
        { client: () => ({ assertionToken: async () => ({ accessToken: other, expiresIn: 120 }) }) },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(AssertionMismatch);
    } finally {
      restore();
    }
  });

  test.each([
    [404, "unknown_identity"],
    [409, "not_human"],
    [423, "suspended"],
    [0, "unreachable"],
  ])("a plane refusal %i %s propagates as OrgPlaneError, never a hub-signed fallback", async (status, code) => {
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      const err = await assertPrincipal(
        { ...SUBJECT, audience: "https://a" },
        { client: () => ({ assertionToken: async () => { throw new OrgPlaneError(status, code); } }) },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(OrgPlaneError);
    } finally {
      restore();
    }
  });

  test("legacy mode still signs with the hub's key, as today", async () => {
    const human = await createPrincipal({ kind: "human", handle: `assert-legacy-${Date.now()}` });
    const token = await assertPrincipal({ principalId: human, senderMxid: "@x:id.test", audience: "https://a" });
    expect(decodeJwt(token).sub).toBe(human);
    expect(decodeJwt(token).act).toEqual({ sub: BRIDGE_ACTOR });
  });
});
```

(Use the file's existing imports for `db`, `createPrincipal`, `decodeJwt`, `BRIDGE_ACTOR`; add any that are missing. If legacy `buildTokenPayload` refuses a human with no linked user in this file's setup, create the human the way the file's existing `mintPrincipalAssertion` test does.)

Add to `apps/hub/src/services/matrix-as/gates.test.ts`, beside the existing "resolved" case that builds `handleGateDecision` deps with a fake `resolveGate`:

```ts
test("the sender's mxid reaches resolveGate, so the plane can resolve the human itself", async () => {
  const seen: Array<{ principalId: string; senderMxid: string }> = [];
  await handleGateDecision(decisionEvent(), ROOM, {
    ...deps(),
    resolveGate: async (input) => {
      seen.push({ principalId: input.principalId, senderMxid: input.senderMxid });
      return { ok: true };
    },
  });
  expect(seen).toEqual([{ principalId: HUMAN_PRINCIPAL, senderMxid: decisionEvent().sender }]);
});

test("resolveGateAtSuperpipeline hands mint both the principal and the sender", async () => {
  const minted: unknown[] = [];
  await resolveGateAtSuperpipeline(
    { boardId: "b", gateId: "g", decision: "approve" as never, comment: null, principalId: "prn_hhhhhhhhhhhhhhhhhhhh", senderMxid: "@op:id.test" },
    { baseUrl: "https://sp.test", mint: async (s) => (minted.push(s), "t"), fetch: (async () => new Response("{}", { status: 200 })) as never },
  );
  expect(minted).toEqual([{ principalId: "prn_hhhhhhhhhhhhhhhhhhhh", senderMxid: "@op:id.test" }]);
});
```

(`decisionEvent`, `ROOM`, `deps()` and the human principal constant are whatever that file's existing resolved-decision case uses; use the decision option id that case uses instead of `"approve"`.) Add the matching pair to `elicitations.test.ts` for `answer` / `answerElicitationAtSuperpipeline`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/auth/service-signing.test.ts src/services/matrix-as/gates.test.ts src/services/matrix-as/elicitations.test.ts`
Expected: FAIL — `assertPrincipal`/`AssertionMismatch` not exported; `senderMxid` absent from `resolveGate`'s input.

- [ ] **Step 3: Write the implementation**

Append to `apps/hub/src/auth/service-signing.ts`:

```ts
import { decodeJwt } from "jose";
import { orgPlane } from "./org-plane/config";
import { orgPlaneClient, type OrgPlaneClient } from "../services/org-plane/client";

export interface AssertionSubject {
  /** Resolved by the hub from the sender (Task 9); used for the legacy mint and the check below. */
  principalId: string;
  /** The Matrix sender. Under the plane this, not the prn_, is what is asserted (contract §3.4b). */
  senderMxid: string;
}

export class AssertionMismatch extends Error {
  constructor(expected: string, got: unknown) {
    super(`the org plane asserted ${String(got)} for a sender this hub resolved to ${expected}`);
    this.name = "AssertionMismatch";
  }
}

/**
 * A human's approval, carried to another plane as that human. Legacy: the hub signs it.
 * Under the org plane only the plane signs, resolving the human from the Matrix identity itself.
 */
export async function assertPrincipal(
  input: AssertionSubject & { audience: string },
  deps: { client?: () => Pick<OrgPlaneClient, "assertionToken"> } = {},
): Promise<string> {
  if (!orgPlane()) return mintPrincipalAssertion({ principalId: input.principalId, audiences: [input.audience] });
  const { accessToken } = await (deps.client ?? orgPlaneClient)().assertionToken(
    { system: "matrix", externalId: input.senderMxid },
    input.audience,
  );
  const sub = decodeJwt(accessToken).sub;
  if (sub !== input.principalId) throw new AssertionMismatch(input.principalId, sub);
  return accessToken;
}
```

(`decodeJwt` may already be imported in this file via `jose`; merge the import.)

`apps/hub/src/services/matrix-as/gates.ts`:
- `resolveGate(input: { …; principalId: string; senderMxid: string })` at `:679-686`.
- At `:784-791` add `senderMxid: event.sender,` to the object passed to `deps.resolveGate`.
- `resolveGateAtSuperpipeline(input: { …; principalId: string; senderMxid: string }, deps: { baseUrl: string; mint(subject: AssertionSubject): Promise<string>; fetch?: typeof fetch })`, and `:859` becomes `const token = await deps.mint({ principalId: input.principalId, senderMxid: input.senderMxid });`.

`apps/hub/src/services/matrix-as/elicitations.ts`: the same three changes for `answer` (`:364`, call at `:420` passing `senderMxid: event.sender`) and `answerElicitationAtSuperpipeline` (`:273-286`).

`apps/hub/src/services/matrix-as/index.ts` `:413-414` and `:488-489`:

```ts
                mint: (subject) => assertPrincipal({ ...subject, audience: superpipelineBaseUrl }),
```

A thrown `mint` already surfaces through each function's existing failure path as a failed receipt; if `gates.test.ts` has no case where `mint` throws, add one asserting the outcome is `{ ok: false, … }` and the room gets the failure receipt, not a crash.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/auth/ src/services/matrix-as/` — Expected: PASS. Revert-proof: delete the `sub !== input.principalId` check and watch "a plane token naming a different principal is refused" fail.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/service-signing.ts apps/hub/src/auth/service-signing.test.ts apps/hub/src/services/matrix-as/gates.ts apps/hub/src/services/matrix-as/gates.test.ts apps/hub/src/services/matrix-as/elicitations.ts apps/hub/src/services/matrix-as/elicitations.test.ts apps/hub/src/services/matrix-as/index.ts
git commit -m "feat(hub): gate and elicitation assertions come from the org plane's /api/token/assertion when configured"
```

---

### Task 11: Agent principals are created at the plane

Two hub paths create agent principals today:

- `POST /api/admin/stations/:stationId/setup` — `apps/hub/src/routes/station-setup.ts:218-228` inserts into `principals` inside the setup transaction; with `dispatch: "me"` it finds the caller's human principal through `principal_identities` (`:254-271`) and appends the agent to their `mayDispatch` (`:279-292`). Its options route (`:122-156`) lists unplaced agents from the local tables.
- `POST /api/admin/agents` — `apps/hub/src/routes/agents-admin.ts:100-131` via `createPrincipal({ kind: "agent", … })` (already switched by Task 9).

Under the plane the agent is created with `POST /api/principals` **before** the local transaction (a remote call cannot join it), its Matrix id is linked with `PUT /api/principals/:id/identities/matrix` so the plane's identity lookup can tell it is an agent (agentpod#608), and if the local transaction then fails the new principal is suspended so it cannot be used half-placed (the contract has no delete).

**Files:**
- Create: `apps/hub/src/services/org-plane/agent-placement.ts`
- Create: `apps/hub/src/services/org-plane/agent-placement.test.ts`
- Modify: `apps/hub/src/routes/station-setup.ts:122-156,218-292`

**Interfaces:**
- Consumes: `orgPlaneClient`, `OrgPlaneClient`, `PlanePrincipal` (Task 6); `principalDirectory` (Task 9); `bridgeUserId(handle, domain)` (`apps/hub/src/services/matrix-as/names.ts`); `stationSetupMatrixDomain()` (`station-setup.ts:16`).
- Produces:
  - `createPlaneAgent(input: { handle: string; displayName: string; matrixDomain: string | null }, deps?): Promise<string>` — create + link Matrix.
  - `checkPlaneAgent(id: string, deps?): Promise<"ok" | "not-found" | "suspended">`
  - `grantDispatchTo(humanId: string, agentId: string, deps?): Promise<void>` — read-modify-write of the human's grant, keeping `mayGrantReach` and `scopes`.
  - `abandonPlaneAgent(id: string, deps?): Promise<void>` — suspends; logs on failure.
  - `deps` everywhere: `{ client?: () => Pick<OrgPlaneClient, "createAgent" | "linkIdentity" | "putGrant" | "suspend">; directory?: () => Pick<PrincipalDirectory, "principal" | "invalidate"> }`.

- [ ] **Step 1: Write the failing test**

`apps/hub/src/services/org-plane/agent-placement.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { abandonPlaneAgent, checkPlaneAgent, createPlaneAgent, grantDispatchTo } from "./agent-placement";
import type { PlanePrincipal } from "./client";

function fakes(principals: Record<string, PlanePrincipal> = {}) {
  const calls: string[] = [];
  const client = () => ({
    createAgent: async (i: { handle: string; displayName: string }) => (calls.push(`create ${i.handle}`), { id: "prn_cccccccccccccccccccc" }),
    linkIdentity: async (id: string, system: string, ext: string) => void calls.push(`link ${id} ${system} ${ext}`),
    putGrant: async (id: string, g: unknown) => void calls.push(`grant ${id} ${JSON.stringify(g)}`),
    suspend: async (id: string) => void calls.push(`suspend ${id}`),
  });
  const directory = () => ({ principal: async (id: string) => principals[id] ?? null, invalidate: () => {} });
  return { calls, deps: { client, directory } };
}

const human = (grant: PlanePrincipal["grant"]): PlanePrincipal => ({
  id: "prn_hhhhhhhhhhhhhhhhhhhh", kind: "human", handle: "op", displayName: null, organizationId: null,
  suspended: false, grant,
});

describe("agent placement under the plane", () => {
  test("creates the agent and links its Matrix id", async () => {
    const { calls, deps } = fakes();
    expect(await createPlaneAgent({ handle: "cody", displayName: "Cody", matrixDomain: "id.test" }, deps)).toBe("prn_cccccccccccccccccccc");
    expect(calls).toEqual(["create cody", "link prn_cccccccccccccccccccc matrix @agent_cody:id.test"]);
  });

  test("grantDispatchTo appends once and keeps reach and scopes", async () => {
    const { calls, deps } = fakes({ prn_hhhhhhhhhhhhhhhhhhhh: human({ mayDispatch: ["prn_x"], mayGrantReach: true, scopes: ["runs:write"] }) });
    await grantDispatchTo("prn_hhhhhhhhhhhhhhhhhhhh", "prn_cccccccccccccccccccc", deps);
    await grantDispatchTo("prn_hhhhhhhhhhhhhhhhhhhh", "prn_x", deps);
    expect(calls[0]).toBe(`grant prn_hhhhhhhhhhhhhhhhhhhh ${JSON.stringify({ mayDispatch: ["prn_x", "prn_cccccccccccccccccccc"], mayGrantReach: true, scopes: ["runs:write"] })}`);
    expect(calls).toHaveLength(1); // already present: no write
  });

  test("a human with no grant gets one naming just the agent", async () => {
    const { calls, deps } = fakes({ prn_hhhhhhhhhhhhhhhhhhhh: human(null) });
    await grantDispatchTo("prn_hhhhhhhhhhhhhhhhhhhh", "prn_cccccccccccccccccccc", deps);
    expect(calls[0]).toContain(JSON.stringify({ mayDispatch: ["prn_cccccccccccccccccccc"], mayGrantReach: false, scopes: [] }));
  });

  test("checkPlaneAgent refuses humans, unknowns and suspended agents", async () => {
    const agent = { ...human(null), id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent" as const };
    const { deps } = fakes({ [agent.id]: agent, susp: { ...agent, id: "susp", suspended: true }, prn_hhhhhhhhhhhhhhhhhhhh: human(null) });
    expect(await checkPlaneAgent(agent.id, deps)).toBe("ok");
    expect(await checkPlaneAgent("susp", deps)).toBe("suspended");
    expect(await checkPlaneAgent("prn_hhhhhhhhhhhhhhhhhhhh", deps)).toBe("not-found");
    expect(await checkPlaneAgent("nope", deps)).toBe("not-found");
  });

  test("abandonPlaneAgent suspends", async () => {
    const { calls, deps } = fakes();
    await abandonPlaneAgent("prn_cccccccccccccccccccc", deps);
    expect(calls).toEqual(["suspend prn_cccccccccccccccccccc"]);
  });
});
```

Add to `apps/hub/src/routes/station-setup.test.ts` (it already seeds a station owned by its test user; reuse its app builder and fixtures):

```ts
test("under the plane, a new agent is created remotely and the local transaction never inserts into principals", async () => {
  const restore = [setOrgPlaneForTests(TEST_PLANE), setOrgPlaneClientForTests(fakeClient), setPrincipalDirectoryForTests(fakeDirectory)];
  try {
    const before = (await db.select().from(principals)).length;
    const res = await post(stationId, { requestId: crypto.randomUUID(), agent: { kind: "new", handle: `p3-${RUN}`, displayName: "P3" }, dispatch: "none" });
    expect(res.status).toBe(200);
    expect((await res.json()).principalId).toBe("prn_cccccccccccccccccccc");
    expect((await db.select().from(principals)).length).toBe(before);
  } finally {
    restore.forEach((r) => r());
  }
});
```

where `fakeClient` implements `createAgent` → `{ id: "prn_cccccccccccccccccccc" }`, `linkIdentity`/`putGrant`/`suspend` → `undefined`, and the rest throw; `fakeDirectory.principal` returns `null`. (Check the request body against `inputSchema` at the top of `station-setup.ts`; use the existing test's valid body with only `agent` changed.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/org-plane/agent-placement.test.ts src/routes/station-setup.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/services/org-plane/agent-placement.ts`:

```ts
import { bridgeUserId } from "../matrix-as/names";
import { orgPlaneClient, type OrgPlaneClient } from "./client";
import { principalDirectory, type PrincipalDirectory } from "./directory";
import { createLogger } from "../../utils/logger";

const log = createLogger("agent-placement");

type Deps = {
  client?: () => Pick<OrgPlaneClient, "createAgent" | "linkIdentity" | "putGrant" | "suspend">;
  directory?: () => Pick<PrincipalDirectory, "principal" | "invalidate">;
};

export async function createPlaneAgent(
  input: { handle: string; displayName: string; matrixDomain: string | null },
  deps: Deps = {},
): Promise<string> {
  const client = (deps.client ?? orgPlaneClient)();
  const { id } = await client.createAgent({ handle: input.handle, displayName: input.displayName });
  if (input.matrixDomain) await client.linkIdentity(id, "matrix", bridgeUserId(input.handle, input.matrixDomain));
  return id;
}

export async function checkPlaneAgent(id: string, deps: Deps = {}): Promise<"ok" | "not-found" | "suspended"> {
  const p = await (deps.directory ?? principalDirectory)().principal(id);
  if (!p || p.kind !== "agent") return "not-found";
  return p.suspended ? "suspended" : "ok";
}

export async function grantDispatchTo(humanId: string, agentId: string, deps: Deps = {}): Promise<void> {
  const directory = (deps.directory ?? principalDirectory)();
  const current = (await directory.principal(humanId))?.grant ?? { mayDispatch: [], mayGrantReach: false, scopes: [] };
  if (current.mayDispatch.includes(agentId)) return;
  // Read-modify-write: two placements by the same human in the same instant can lose one append.
  // The hub's local version serialised this under a row lock; the plane's PUT cannot. Recorded as a
  // known race in the plan's risks.
  await (deps.client ?? orgPlaneClient)().putGrant(humanId, { ...current, mayDispatch: [...current.mayDispatch, agentId] });
  directory.invalidate(humanId);
}

export async function abandonPlaneAgent(id: string, deps: Deps = {}): Promise<void> {
  try {
    await (deps.client ?? orgPlaneClient)().suspend(id);
  } catch (error) {
    log.error("could not suspend an agent whose placement failed; suspend it at the plane", { id, error: String(error) });
  }
}
```

`apps/hub/src/routes/station-setup.ts`, inside the POST handler — before `db.transaction`:

```ts
      const plane = orgPlane();
      let planeAgent: string | null = null;
      if (plane && input.agent.kind === "new") {
        planeAgent = await createPlaneAgent({
          handle: input.agent.handle,
          displayName: input.agent.displayName,
          matrixDomain: stationSetupMatrixDomain(),
        });
      }
      if (plane && input.agent.kind === "existing") {
        const state = await checkPlaneAgent(input.agent.principalId);
        if (state === "not-found") return c.json({ error: "Agent not found" }, 404);
        if (state === "suspended") return c.json({ error: "This agent is suspended" }, 403);
      }
```

inside the transaction, replace the `if (input.agent.kind === "new") { … insert(principals) … } else { … }` block's two arms with:

```ts
          if (input.agent.kind === "new") {
            id = planeAgent ?? prefixedId("prn");
            if (!planeAgent) {
              await tx.insert(principals).values({ id, kind: "agent", orgId: BOOTSTRAP_ORG_ID, handle: input.agent.handle, displayName: input.agent.displayName });
            }
          } else {
            id = input.agent.principalId;
            if (!plane) {
              // …existing SELECT … FOR UPDATE checks, unchanged…
            }
            // the placement check (stations.principalId = id) stays local in both modes
          }
```

and replace the `dispatch === "me"` block's body under the plane with a marker that runs **after** commit:

```ts
          if (input.dispatch === "me" && !plane) {
            // …existing principal_identities lookup + principal_grants upsert, unchanged…
          }
```

after the transaction resolves (before `return c.json({ principalId, matrix: … })`):

```ts
        if (plane && input.dispatch === "me") {
          const me = await humanPrincipalIdForUser(userId);
          if (!me) return c.json({ error: "Your active operator identity is required to grant dispatch access" }, 403);
          await grantDispatchTo(me, principalId);
        }
```

and in the `catch (e)` arm, first thing: `if (planeAgent) await abandonPlaneAgent(planeAgent);`.

The options route (`:122-156`) under the plane:

```ts
    if (orgPlane()) {
      const all = await listPrincipals();
      const placed = new Set((await db.select({ id: stations.principalId }).from(stations)).map((r) => r.id));
      const grants = await Promise.all(all.filter((p) => p.kind === "human").map(async (p) => ({ handle: p.handle, grant: await getGrant(p.id) })));
      return c.json({
        agents: all
          .filter((p) => p.kind === "agent" && !p.suspendedAt && !placed.has(p.id))
          .map((a) => ({ id: a.id, handle: a.handle, displayName: a.displayName, dispatchers: grants.filter((g) => g.grant?.mayDispatch.includes(a.id)).map((g) => g.handle) })),
        matrixDomain: stationSetupMatrixDomain(),
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command, then the whole hub suite. Expected: PASS. Revert-proof: remove the `if (planeAgent) await abandonPlaneAgent(planeAgent)` line and add a test where the transaction throws a 409 (station already occupied) — the fake client must record `suspend prn_cccccccccccccccccccc`; watch it fail without the line.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/org-plane/agent-placement.ts apps/hub/src/services/org-plane/agent-placement.test.ts apps/hub/src/routes/station-setup.ts apps/hub/src/routes/station-setup.test.ts
git commit -m "feat(hub): station setup creates agents at the org plane and links their Matrix id"
```

---

### Task 12: The operator seat, and admin routes the plane now owns (decision D3, D4)

**Files:**
- Create: `apps/hub/src/db/schema/operators.ts`; add `export * from "./operators";` to `apps/hub/src/db/schema/index.ts`
- Create: `apps/hub/src/db/drizzle-migrations/0094_hub_operators.sql` (generate with `cd apps/hub && bun run db:generate --name hub_operators`, then check the SQL matches below)
- Modify: `apps/hub/src/models/admin-users.ts:342-349` (`isUserAdmin`)
- Modify: `apps/hub/src/services/grant-reach.ts:186-201` (`isAdminPrincipal`)
- Modify: `apps/hub/src/routes/admin.ts:51-75` (retire routes under the plane)
- Create: `apps/hub/src/routes/me.ts` — `GET /api/me`; mount in `apps/hub/src/index.ts` after `.route('/api/admin', adminRouter)` (line 328)
- Create: `apps/hub/tests/integration/org-plane-admin.test.ts`

**Interfaces:**
- Consumes: `orgPlane`, `setOrgPlaneForTests`, `TEST_PLANE` (Task 1); `adminMiddleware` (`apps/hub/src/auth/admin-middleware.ts`).
- Produces:
  - table `hub_operators (principal_id text primary key, created_at timestamp not null default now(), created_by text)` and drizzle `hubOperators`.
  - `isUserAdmin(userId)` under the plane: `EXISTS hub_operators WHERE principal_id = userId`.
  - `retiredUnderPlane(plane?: () => OrgPlaneConfig | null): MiddlewareHandler` → `410 { error: "managed_by_org_plane", url: <ORG_PLANE_URL> }`.
  - `GET /api/me` → `{ id: string, email: string | null, isAdmin: boolean, issuer: "hub" | "org-plane" }` — what the console reads instead of Better Auth's `role` (Task 14).

Retired under the plane (D3): `GET|POST /api/admin/users`, `GET /api/admin/users/:id`, `POST /api/admin/users/:id/{ban,unban}`, `PUT /api/admin/users/:id/role` (`routes/admin.ts:117-301,452`), `/api/admin/settings/signup*` (`:369-450`), all of `/api/admin/grants*` (`routes/admin-grants.ts`, mounted `admin.ts:57`), `/api/admin/service-principals*` (`admin.ts:65`), `POST /api/admin/principals/:id/{suspend,restore}` (`routes/admin-principals.ts:59,76`). `GET /api/admin/principals` stays (reads through Task 9).

- [ ] **Step 1: Write the failing test**

`apps/hub/tests/integration/org-plane-admin.test.ts`:

```ts
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { hubOperators } from "../../src/db/schema/operators";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { setOrgPlaneForTests, TEST_PLANE } from "../../src/auth/org-plane/config";
import { isUserAdmin } from "../../src/models/admin-users";
import { adminRouter } from "../../src/routes/admin";
import { meRoutes } from "../../src/routes/me";

const OP = `prn_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
let restore = () => {};
beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(hubOperators).values({ principalId: OP });
});
afterEach(() => restore());
afterAll(async () => {
  await db.delete(hubOperators).where(eq(hubOperators.principalId, OP));
});

/** adminRouter applies authMiddleware itself; stub the caller the way the plane branch would. */
const asCaller = (id: string) =>
  new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id, authType: "org_plane", tenantId: "fleet_00000000000000000000" });
      await next();
    })
    .route("/api/admin", adminRouter)
    .route("/api", meRoutes);

describe("operator seat under the plane", () => {
  test("isUserAdmin reads hub_operators", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    expect(await isUserAdmin(OP)).toBe(true);
    expect(await isUserAdmin("prn_00000000000000000000")).toBe(false);
  });

  test("legacy isUserAdmin ignores hub_operators", async () => {
    expect(await isUserAdmin(OP)).toBe(false);
  });

  test.each([
    ["GET", "/api/admin/users"],
    ["PUT", "/api/admin/grants/prn_aaaaaaaaaaaaaaaaaaaa"],
    ["GET", "/api/admin/grants"],
    ["POST", "/api/admin/service-principals"],
    ["POST", "/api/admin/principals/prn_aaaaaaaaaaaaaaaaaaaa/suspend"],
    ["POST", "/api/admin/settings/signup/enable"],
  ])("%s %s is 410 managed_by_org_plane for an operator", async (method, path) => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await asCaller(OP).request(path, { method, headers: { Authorization: "Bearer x", Origin: "https://console.agentpod.dev" } });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "managed_by_org_plane", url: TEST_PLANE.url });
  });

  test("GET /api/me says who the caller is and whether they are an operator", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const body = await (await asCaller(OP).request("/api/me")).json();
    expect(body).toEqual({ id: OP, email: null, isAdmin: true, issuer: "org-plane" });
  });
});
```

Note: `adminRouter.use("*", authMiddleware)` (`routes/admin.ts:51`) runs again inside the router. Under the plane with a stubbed `user` and a bogus bearer it would 401; so the retirement middleware must run **before** `authMiddleware` in `admin.ts` for the retired paths — which is also correct in production (a retired route need not authenticate to say it moved). Register it first.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/org-plane-admin.test.ts` — Expected: FAIL, `../../src/db/schema/operators` missing.

- [ ] **Step 3: Write the implementation**

`apps/hub/src/db/schema/operators.ts`:

```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Who may operate this hub, by principal id. AgentPod's own seat (design §4: product seats stay
 * in each product). Read only when ORG_PLANE_* is set; seeded from `user.role = 'admin'` by
 * scripts/rewrite-user-ids.ts at cutover.
 */
export const hubOperators = pgTable("hub_operators", {
  principalId: text("principal_id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"),
});
```

`apps/hub/src/db/drizzle-migrations/0094_hub_operators.sql`:

```sql
CREATE TABLE IF NOT EXISTS "hub_operators" (
	"principal_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
```

(plus the `meta/_journal.json` entry and snapshot `drizzle-kit generate` writes.)

`apps/hub/src/models/admin-users.ts`:

```ts
export async function isUserAdmin(userId: string): Promise<boolean> {
  if (orgPlane()) {
    const [row] = await db.select({ id: hubOperators.principalId }).from(hubOperators).where(eq(hubOperators.principalId, userId)).limit(1);
    return !!row;
  }
  // legacy, unchanged
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  return row?.role === "admin";
}
```

`apps/hub/src/services/grant-reach.ts` `isAdminPrincipal`: first statement `if (orgPlane()) return isUserAdmin(principalId);`.

`apps/hub/src/routes/admin.ts` — above line 51:

```ts
import { createMiddleware } from "hono/factory";
import { orgPlane, type OrgPlaneConfig } from "../auth/org-plane/config";

const RETIRED: Array<[method: string | null, pattern: RegExp]> = [
  [null, /^\/api\/admin\/users(\/|$)/],
  [null, /^\/api\/admin\/settings\/signup(\/|$)/],
  [null, /^\/api\/admin\/grants(\/|$)/],
  [null, /^\/api\/admin\/service-principals(\/|$)/],
  ["POST", /^\/api\/admin\/principals\/[^/]+\/(suspend|restore)$/],
];

export function retiredUnderPlane(plane: () => OrgPlaneConfig | null = orgPlane) {
  return createMiddleware(async (c, next) => {
    const p = plane();
    if (!p) return next();
    const hit = RETIRED.some(([m, re]) => (m === null || m === c.req.method) && re.test(c.req.path));
    return hit ? c.json({ error: "managed_by_org_plane", url: p.url }, 410) : next();
  });
}

adminRouter.use("*", retiredUnderPlane());
```

`apps/hub/src/routes/me.ts`:

```ts
import { Hono } from "hono";
import { orgPlane } from "../auth/org-plane/config";
import { isUserAdmin } from "../models/admin-users";

export const meRoutes = new Hono().get("/me", async (c) => {
  const u = c.get("user");
  return c.json({ id: u.id, email: u.email ?? null, isAdmin: await isUserAdmin(u.id), issuer: orgPlane() ? "org-plane" : "hub" });
});
```

Mount in `apps/hub/src/index.ts` after line 328: `.route('/api', meRoutes)                                  // GET /api/me`.

- [ ] **Step 4: Run tests to verify they pass**

Run the Step 2 command, then the whole hub suite. Expected: PASS. Revert-proof: register `retiredUnderPlane` after `authMiddleware` and watch the 410 cases turn 401.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/db/schema/operators.ts apps/hub/src/db/schema/index.ts apps/hub/src/db/drizzle-migrations/ apps/hub/src/models/admin-users.ts apps/hub/src/services/grant-reach.ts apps/hub/src/routes/admin.ts apps/hub/src/routes/me.ts apps/hub/src/index.ts apps/hub/tests/integration/org-plane-admin.test.ts
git commit -m "feat(hub): hub_operators seat, GET /api/me, and 410 for admin routes the org plane owns"
```

---

### Task 13: The `user.id` → `prn_` rewrite, as a rehearsable script

Decisions D1 and D2 apply: this is an operator script, dry run by default, reversible, one transaction, never run by a migration. P4 runs it at cutover in this order — stop the hub; `--apply`; set `ORG_PLANE_*`; start the hub — and for rollback: stop; unset `ORG_PLANE_*`; `--apply --reverse`; start. The hub must never run under the plane against un-rewritten columns, or under Better Auth against rewritten ones: every human's fleet would read as empty.

The column inventory is in the "Hub `user.id` column inventory" section above: 23 rewritten columns, 6 composite owner FKs dropped and re-created around the rewrite, 18 user FKs dropped (forward) or re-added `NOT VALID` (reverse).

Two other cutover facts the script owns:

- **Bootstrap tenant mapping.** Migrations already map `fleet_00000000000000000000` to `external_source = 'org-plane'`, `external_id = 'org_00000000000000000000'` (verified on a freshly migrated database), and the plane keeps that org id (design §4 "The seeded `org_00000000000000000000` … keeps its id"). So the operator's first plane token finds the existing tenant through Task 4 instead of creating an empty one. The script **verifies** this mapping and refuses to apply if it is missing or points elsewhere — an empty fleet on first sign-in is the failure it prevents.
- **Seeds** `legacy_user_principals` (Task 9) with every mapping, and `hub_operators` (Task 12) with the principal of every `user.role = 'admin'`.

**Files:**
- Create: `apps/hub/scripts/rewrite-user-ids.ts`
- Create: `apps/hub/tests/integration/rewrite-user-ids.test.ts`
- Modify: `docs/OPERATING.md` (new section "Cutover: rewriting user ids", the four-step order above, and the dry-run output explained)

**Interfaces:**
- Consumes: tables `legacy_user_principals` (Task 9), `hub_operators` (Task 12); `principal_identities`, `principals`, `"user"`, `tenants`.
- Produces (all exported from `scripts/rewrite-user-ids.ts`):
  - `interface UserIdColumn { table: string; column: string; fk: string | null; onDelete: "CASCADE" | "SET NULL" | null }`
  - `USER_ID_COLUMNS: readonly UserIdColumn[]` (23 entries), `NOT_REWRITTEN: readonly string[]` (`"table.column"`), `OWNER_FKS: readonly string[]` (6 names)
  - `type Direction = "forward" | "reverse"`
  - `interface RewritePlan { direction: Direction; counts: Array<{ table: string; column: string; rows: number; toRewrite: number; alreadyTarget: number; unmapped: number }>; unmapped: Array<{ table: string; column: string; value: string; rows: number }>; collisions: Array<{ principalId: string; userIds: string[] }>; operators: string[]; tenantMapping: "ok" | "missing" | "conflict" }`
  - `planRewrite(sql: Sql, opts: { direction: Direction; extra?: Record<string, string>; org?: string }): Promise<RewritePlan>` — reads only.
  - `applyRewrite(sql: Sql, opts: { direction: Direction; extra?: Record<string, string>; org?: string }): Promise<RewritePlan>` — throws `RewriteRefused` (with the plan) before changing anything if `unmapped`, `collisions` or (forward) `tenantMapping !== "ok"`.
  - CLI: `bun run scripts/rewrite-user-ids.ts [--apply] [--reverse] [--map <from>=<to> …] [--org org_…] [--json]`.

- [ ] **Step 1: Write the failing test**

`apps/hub/tests/integration/rewrite-user-ids.test.ts`:

```ts
/**
 * The rewrite runs against a SCRATCH database (as migration-race.test.ts does): --apply drops
 * foreign keys, and doing that to the shared test database would break the ~81 test files that
 * clean up through ON DELETE CASCADE.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "node:path";
import {
  applyRewrite, NOT_REWRITTEN, OWNER_FKS, planRewrite, RewriteRefused, USER_ID_COLUMNS,
} from "../../scripts/rewrite-user-ids";

const BASE = process.env.DATABASE_URL ?? "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
const SCRATCH = `rewrite_user_ids_${Date.now()}`;
const admin = postgres(BASE.replace(/\/[^/]+$/, "/postgres"), { max: 1 });
let sql: ReturnType<typeof postgres>;

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222"; // an admin
const P1 = "prn_1111111111111111aaaa";
const P2 = "prn_2222222222222222bbbb";
const ORPHAN = "default-user";

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);
  sql = postgres(BASE.replace(/\/[^/]+$/, `/${SCRATCH}`), { max: 2 });
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await migrate(drizzle(sql), { migrationsFolder: join(import.meta.dir, "..", "..", "src", "db", "drizzle-migrations") });

  await sql`INSERT INTO "user" (id, name, email, role) VALUES (${U1}, 'One', 'one@example.com', 'user'), (${U2}, 'Two', 'two@example.com', 'admin')`;
  await sql`INSERT INTO principals (id, kind, org_id, handle) VALUES (${P1}, 'human', 'org_00000000000000000000', 'one'), (${P2}, 'human', 'org_00000000000000000000', 'two')`;
  await sql`INSERT INTO principal_identities (id, principal_id, system, external_id) VALUES ('pid_1', ${P1}, 'better-auth', ${U1}), ('pid_2', ${P2}, 'better-auth', ${U2})`;
  await sql`INSERT INTO system_settings (key, value, updated_by) VALUES ('k1', 'v', ${U1}), ('k2', 'v', ${U2})`;
  await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES
    ('a1', 'fleet_00000000000000000000', ${U1}, 'node_x', 's', 'v'),
    ('a2', 'fleet_00000000000000000000', ${U1}, 'node_x', 's', 'v')`;
});

afterAll(async () => {
  await sql?.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.end();
});

describe("the inventory is the schema, not a memory", () => {
  test("every FK to user.id is either rewritten or named as not rewritten", async () => {
    const live = await sql<{ col: string }[]>`
      SELECT c.conrelid::regclass::text || '.' || a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'public."user"'::regclass`;
    const expected = [
      ...USER_ID_COLUMNS.filter((c) => c.fk).map((c) => `${c.table}.${c.column}`),
      "account.user_id", "session.user_id", "device_credentials.user_id",
    ].sort();
    expect(live.map((r) => r.col).sort()).toEqual(expected); // 21 today: 18 rewritten + 3 auth
  });

  test("every owner FK the script drops exists", async () => {
    const rows = await sql<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conname = ANY(${OWNER_FKS as string[]})`;
    expect(rows.map((r) => r.conname).sort()).toEqual([...OWNER_FKS].sort());
  });

  test("23 columns", () => expect(USER_ID_COLUMNS).toHaveLength(23));
});

describe("dry run", () => {
  test("counts per column and names what it cannot map", async () => {
    await sql`INSERT INTO station_audit (id, tenant_id, user_id, node_id, station_key, verb) VALUES ('a3', 'fleet_00000000000000000000', ${ORPHAN}, 'node_x', 's', 'v')`;
    const plan = await planRewrite(sql, { direction: "forward" });
    expect(plan.counts.find((c) => c.table === "station_audit")).toEqual({ table: "station_audit", column: "user_id", rows: 3, toRewrite: 2, alreadyTarget: 0, unmapped: 1 });
    expect(plan.unmapped).toEqual([{ table: "station_audit", column: "user_id", value: ORPHAN, rows: 1 }]);
    expect(plan.operators).toEqual([P2]);
    expect(plan.tenantMapping).toBe("ok");
    // a dry run changes nothing
    expect((await sql`SELECT user_id FROM station_audit WHERE id = 'a1'`)[0]!.user_id).toBe(U1);
  });

  test("refuses to apply while any value is unmapped, and changes nothing", async () => {
    const err = await applyRewrite(sql, { direction: "forward" }).catch((e) => e);
    expect(err).toBeInstanceOf(RewriteRefused);
    expect((await sql`SELECT updated_by FROM system_settings WHERE key = 'k1'`)[0]!.updated_by).toBe(U1);
    const fks = await sql`SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_updated_by_user_id_fk'`;
    expect(fks).toHaveLength(1);
  });
});

describe("apply, then reverse", () => {
  test("forward rewrites every value, drops user FKs, keeps owner FKs, seeds the map and operators", async () => {
    const plan = await applyRewrite(sql, { direction: "forward", extra: { [ORPHAN]: P2 } });
    expect(plan.unmapped).toEqual([]);
    expect((await sql`SELECT user_id FROM station_audit ORDER BY id`).map((r) => r.user_id)).toEqual([P1, P1, P2]);
    expect((await sql`SELECT updated_by FROM system_settings ORDER BY key`).map((r) => r.updated_by)).toEqual([P1, P2]);
    expect(await sql`SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_updated_by_user_id_fk'`).toHaveLength(0);
    expect((await sql`SELECT conname FROM pg_constraint WHERE conname = ANY(${OWNER_FKS as string[]})`).length).toBe(OWNER_FKS.length);
    expect((await sql`SELECT principal_id FROM hub_operators`).map((r) => r.principal_id)).toEqual([P2]);
    expect((await sql`SELECT user_id, principal_id FROM legacy_user_principals ORDER BY user_id`).map((r) => [r.user_id, r.principal_id])).toEqual([[U1, P1], [U2, P2]]);
  });

  test("forward is idempotent: a second run finds everything already rewritten", async () => {
    const plan = await planRewrite(sql, { direction: "forward" });
    expect(plan.counts.every((c) => c.toRewrite === 0)).toBe(true);
  });

  test("reverse restores user ids and re-adds the FKs NOT VALID (a plane-only human's row would not block it)", async () => {
    await applyRewrite(sql, { direction: "reverse", extra: { [P2]: U2 } });
    expect((await sql`SELECT updated_by FROM system_settings ORDER BY key`).map((r) => r.updated_by)).toEqual([U1, U2]);
    const fk = await sql<{ convalidated: boolean }[]>`SELECT convalidated FROM pg_constraint WHERE conname = 'system_settings_updated_by_user_id_fk'`;
    expect(fk).toEqual([{ convalidated: false }]);
  });
});
```

(The `INSERT INTO principal_identities` columns are `id, principal_id, system, external_id` with `created_at` defaulted — checked against a migrated database. `station_audit` requires `tenant_id`; `params_summary` and `result` default.)

Note on the reverse case: `ORPHAN` was mapped to `P2` going forward, so going back `P2` is ambiguous (`U2` or `default-user`); the reverse map is built from `principal_identities` (giving `P2 → U2`), and `extra` overrides it. A reverse run reports any `prn_` with no Better Auth identity (a human who first signed up at the plane during the window) as unmapped and refuses, exactly like forward; the operator decides with `--map`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/rewrite-user-ids.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/rewrite-user-ids'`.

- [ ] **Step 3: Write the script**

`apps/hub/scripts/rewrite-user-ids.ts`:

```ts
/**
 * Rewrite every hub column that holds a Better Auth user id to the human's prn_ id — or back.
 *
 * DRY RUN IS THE DEFAULT. `bun run scripts/rewrite-user-ids.ts` prints, per column, how many
 * rows it would rewrite, how many are already rewritten, and every value it cannot map. Only
 * `--apply` changes anything, in ONE transaction that either completes or leaves the database
 * as it was. See docs/OPERATING.md "Cutover: rewriting user ids" for when to run it.
 *
 * The inventory below was enumerated from pg_constraint on a freshly migrated database, and
 * tests/integration/rewrite-user-ids.test.ts fails if a migration adds an FK to "user" that is
 * not listed here.
 */
import type { Sql } from "postgres";

export interface UserIdColumn { table: string; column: string; fk: string | null; onDelete: "CASCADE" | "SET NULL" | null }

export const USER_ID_COLUMNS: readonly UserIdColumn[] = [
  { table: "admin_audit_log", column: "admin_user_id", fk: "admin_audit_log_admin_user_id_user_id_fk", onDelete: "SET NULL" },
  { table: "admin_audit_log", column: "target_user_id", fk: "admin_audit_log_target_user_id_user_id_fk", onDelete: "SET NULL" },
  { table: "agent_tasks", column: "user_id", fk: "agent_tasks_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "bridge_agents", column: "created_by", fk: "bridge_agents_created_by_user_id_fk", onDelete: "SET NULL" },
  { table: "cloudflare_sandboxes", column: "user_id", fk: "cloudflare_sandboxes_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "enrollment_tokens", column: "user_id", fk: "enrollment_tokens_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "matrix_missions", column: "user_id", fk: "matrix_missions_user_id_fkey", onDelete: "CASCADE" },
  { table: "nodes", column: "user_id", fk: "nodes_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "provisioned_runtimes", column: "user_id", fk: "provisioned_runtimes_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "skill_artifacts", column: "user_id", fk: "skill_artifacts_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "skill_operations", column: "user_id", fk: "skill_operations_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "skill_release_cohorts", column: "user_id", fk: "skill_release_cohorts_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "station_setups", column: "user_id", fk: "station_setups_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "station_speech", column: "updated_by", fk: "station_speech_updated_by_user_id_fk", onDelete: "SET NULL" },
  { table: "station_transcription", column: "updated_by", fk: "station_transcription_updated_by_user_id_fk", onDelete: "SET NULL" },
  { table: "stations", column: "user_id", fk: "stations_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "system_settings", column: "updated_by", fk: "system_settings_updated_by_user_id_fk", onDelete: "SET NULL" },
  { table: "trusted_skill_releases", column: "user_id", fk: "trusted_skill_releases_user_id_user_id_fk", onDelete: "CASCADE" },
  // No foreign key, same values (checked against their writers):
  { table: "acp_sessions", column: "user_id", fk: null, onDelete: null },
  { table: "station_audit", column: "user_id", fk: null, onDelete: null },
  { table: "trusted_skill_release_artifacts", column: "user_id", fk: null, onDelete: null },
  { table: "declared_harness_config", column: "declared_by", fk: null, onDelete: null },
  { table: "harness_config_opt_out", column: "opted_out_by", fk: null, onDelete: null },
];

/** FKs to "user" this script leaves alone (auth tables, dropped in Task 17), and non-FK columns that hold something else. */
export const NOT_REWRITTEN: readonly string[] = [
  "account.user_id",
  "session.user_id",
  "device_credentials.user_id",
  "oauth_codes.user_id", // 60-second rows, no FK
  "live_activity_tokens.user_id", // a Matrix id, not a user id
];

/** Composite (…, tenant_id, user_id) FKs between product tables; NOT DEFERRABLE, so dropped and re-created. */
export const OWNER_FKS: readonly string[] = [
  "skill_operations_artifact_owner_fk",
  "skill_operations_station_owner_fk",
  "skill_release_cohorts_release_owner_fk",
  "station_setups_owner_fk",
  "trusted_skill_release_artifacts_artifact_owner_fk",
  "trusted_skill_release_artifacts_release_owner_fk",
];

const BOOTSTRAP_TENANT = "fleet_00000000000000000000";
const BOOTSTRAP_ORG = "org_00000000000000000000";
const PRN = /^prn_[0-9a-f]{20}$/;

export type Direction = "forward" | "reverse";
export interface RewritePlan {
  direction: Direction;
  counts: Array<{ table: string; column: string; rows: number; toRewrite: number; alreadyTarget: number; unmapped: number }>;
  unmapped: Array<{ table: string; column: string; value: string; rows: number }>;
  collisions: Array<{ principalId: string; userIds: string[] }>;
  operators: string[];
  tenantMapping: "ok" | "missing" | "conflict";
}

export class RewriteRefused extends Error {
  constructor(readonly plan: RewritePlan, reason: string) {
    super(`refusing to apply: ${reason}`);
    this.name = "RewriteRefused";
  }
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function mapping(sql: Sql, direction: Direction, extra: Record<string, string>): Promise<Map<string, string>> {
  const rows = await sql<{ user_id: string; principal_id: string }[]>`
    SELECT pi.external_id AS user_id, pi.principal_id
    FROM principal_identities pi JOIN principals p ON p.id = pi.principal_id
    WHERE pi.system = 'better-auth' AND p.kind = 'human'`;
  const m = new Map<string, string>();
  for (const r of rows) direction === "forward" ? m.set(r.user_id, r.principal_id) : m.set(r.principal_id, r.user_id);
  for (const [from, to] of Object.entries(extra)) m.set(from, to);
  return m;
}

export async function planRewrite(
  sql: Sql,
  opts: { direction: Direction; extra?: Record<string, string>; org?: string },
): Promise<RewritePlan> {
  const map = await mapping(sql, opts.direction, opts.extra ?? {});
  const isTarget = (v: string) => (opts.direction === "forward" ? PRN.test(v) : !PRN.test(v));
  const counts: RewritePlan["counts"] = [];
  const unmapped: RewritePlan["unmapped"] = [];

  for (const c of USER_ID_COLUMNS) {
    const groups = await sql.unsafe<{ v: string; n: number }[]>(
      `SELECT ${q(c.column)} AS v, count(*)::int AS n FROM ${q(c.table)} WHERE ${q(c.column)} IS NOT NULL GROUP BY 1`,
    );
    const row = { table: c.table, column: c.column, rows: 0, toRewrite: 0, alreadyTarget: 0, unmapped: 0 };
    for (const g of groups) {
      row.rows += g.n;
      if (map.has(g.v)) row.toRewrite += g.n;
      else if (isTarget(g.v)) row.alreadyTarget += g.n;
      else {
        row.unmapped += g.n;
        unmapped.push({ table: c.table, column: c.column, value: g.v, rows: g.n });
      }
    }
    counts.push(row);
  }

  const collisions = (
    await sql<{ principal_id: string; user_ids: string[] }[]>`
      SELECT principal_id, array_agg(external_id ORDER BY external_id) AS user_ids
      FROM principal_identities WHERE system = 'better-auth'
      GROUP BY principal_id HAVING count(*) > 1`
  ).map((r) => ({ principalId: r.principal_id, userIds: r.user_ids }));

  const operators = (
    await sql<{ principal_id: string }[]>`
      SELECT pi.principal_id FROM "user" u
      JOIN principal_identities pi ON pi.system = 'better-auth' AND pi.external_id = u.id
      WHERE u.role = 'admin' ORDER BY 1`
  ).map((r) => r.principal_id);

  const org = opts.org ?? BOOTSTRAP_ORG;
  const [t] = await sql<{ external_source: string | null; external_id: string | null }[]>`
    SELECT external_source, external_id FROM tenants WHERE id = ${BOOTSTRAP_TENANT}`;
  const tenantMapping = !t || t.external_id === null ? "missing" : t.external_source === "org-plane" && t.external_id === org ? "ok" : "conflict";

  return { direction: opts.direction, counts, unmapped, collisions, operators, tenantMapping };
}

export async function applyRewrite(
  sql: Sql,
  opts: { direction: Direction; extra?: Record<string, string>; org?: string },
): Promise<RewritePlan> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    const plan = await planRewrite(tx as unknown as Sql, opts);
    if (plan.unmapped.length > 0) throw new RewriteRefused(plan, `${plan.unmapped.length} value(s) have no mapping; pass --map`);
    if (plan.collisions.length > 0) throw new RewriteRefused(plan, "a principal has more than one Better Auth identity");
    if (opts.direction === "forward" && plan.tenantMapping !== "ok") {
      throw new RewriteRefused(plan, `bootstrap tenant mapping is ${plan.tenantMapping}`);
    }

    const owners = await tx<{ tbl: string; conname: string; def: string }[]>`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE contype = 'f' AND conname = ANY(${OWNER_FKS as string[]})`;
    for (const o of owners) await tx.unsafe(`ALTER TABLE ${o.tbl} DROP CONSTRAINT ${q(o.conname)}`);

    if (opts.direction === "forward") {
      for (const c of USER_ID_COLUMNS) if (c.fk) await tx.unsafe(`ALTER TABLE ${q(c.table)} DROP CONSTRAINT IF EXISTS ${q(c.fk)}`);
    }

    const map = await mapping(tx as unknown as Sql, opts.direction, opts.extra ?? {});
    await tx`CREATE TEMP TABLE _uid_map (src text PRIMARY KEY, dst text NOT NULL) ON COMMIT DROP`;
    const pairs = [...map.entries()].map(([src, dst]) => ({ src, dst }));
    for (let i = 0; i < pairs.length; i += 1000) await tx`INSERT INTO _uid_map ${tx(pairs.slice(i, i + 1000), "src", "dst")}`;
    for (const c of USER_ID_COLUMNS) {
      await tx.unsafe(
        `UPDATE ${q(c.table)} t SET ${q(c.column)} = m.dst FROM _uid_map m WHERE t.${q(c.column)} = m.src`,
      );
    }

    for (const o of owners) await tx.unsafe(`ALTER TABLE ${o.tbl} ADD CONSTRAINT ${q(o.conname)} ${o.def}`);

    if (opts.direction === "forward") {
      await tx`
        INSERT INTO legacy_user_principals (user_id, principal_id)
        SELECT pi.external_id, pi.principal_id FROM principal_identities pi
        JOIN principals p ON p.id = pi.principal_id
        WHERE pi.system = 'better-auth' AND p.kind = 'human'
        ON CONFLICT (user_id) DO NOTHING`;
      for (const id of plan.operators) {
        await tx`INSERT INTO hub_operators (principal_id, created_by) VALUES (${id}, 'rewrite-user-ids') ON CONFLICT DO NOTHING`;
      }
    } else {
      for (const c of USER_ID_COLUMNS) {
        if (!c.fk) continue;
        await tx.unsafe(
          `ALTER TABLE ${q(c.table)} ADD CONSTRAINT ${q(c.fk)} FOREIGN KEY (${q(c.column)}) REFERENCES "user"(id) ON DELETE ${c.onDelete} NOT VALID`,
        );
      }
    }
    return plan;
  }) as Promise<RewritePlan>;
}

function printPlan(plan: RewritePlan): void {
  console.log(`direction: ${plan.direction}`);
  console.table(plan.counts);
  console.log(`operators to seed: ${plan.operators.join(", ") || "(none)"}`);
  console.log(`bootstrap tenant → org mapping: ${plan.tenantMapping}`);
  if (plan.collisions.length) console.log("principals with several Better Auth ids:", plan.collisions);
  if (plan.unmapped.length) {
    console.log("UNMAPPED — pass --map <value>=<id> for each, or the apply refuses:");
    console.table(plan.unmapped);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const direction: Direction = args.includes("--reverse") ? "reverse" : "forward";
  const extra: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a === "--map") {
      const [from, to] = (args[i + 1] ?? "").split("=");
      if (!from || !to) throw new Error("--map takes <from>=<to>");
      extra[from] = to;
    }
  });
  const orgIdx = args.indexOf("--org");
  const org = orgIdx >= 0 ? args[orgIdx + 1] : undefined;
  const { rawSql, closeDatabase } = await import("../src/db/drizzle");
  try {
    const plan = args.includes("--apply")
      ? await applyRewrite(rawSql, { direction, extra, org })
      : await planRewrite(rawSql, { direction, extra, org });
    if (args.includes("--json")) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    console.log(args.includes("--apply") ? "APPLIED." : "Dry run — nothing changed. Re-run with --apply.");
    process.exitCode = plan.unmapped.length > 0 ? 2 : 0;
  } catch (e) {
    if (e instanceof RewriteRefused) {
      printPlan(e.plan);
      console.error(e.message);
      process.exitCode = 2;
    } else throw e;
  } finally {
    await closeDatabase();
  }
}
```

Add the "Cutover: rewriting user ids" section to `docs/OPERATING.md` with: the four-step forward order and the rollback order (from this task's intro), "always run the dry run first and read the UNMAPPED table", "`DEFAULT_USER_ID` (default `default-user`) is the usual unmapped value — map it to the operator's `prn_` and set `DEFAULT_USER_ID` to the same `prn_` before starting the hub under the plane", and "the script holds `lock_timeout = 10s`; stop the hub first so it never waits on the hub's own locks".

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS (9 tests). Revert-proof: (a) remove `"station_audit"` from `USER_ID_COLUMNS` and watch "counts per column" fail; (b) add a dummy FK to `"user"` in the scratch DB before the inventory test (`ALTER TABLE nodes ADD COLUMN x text REFERENCES "user"(id)`) and watch "every FK … named" fail — then remove both.

- [ ] **Step 5: Rehearse against a copy of production (no code change)**

On `infra`, `pg_dump` the hub database into a scratch database and run the dry run and `--apply` against it with `DATABASE_URL` pointing at the copy. Paste the dry-run table into the PR description. This is the rehearsal design §8 requires; it is not optional for P4.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/scripts/rewrite-user-ids.ts apps/hub/tests/integration/rewrite-user-ids.test.ts docs/OPERATING.md
git commit -m "feat(hub): rehearsable user.id → prn_ rewrite script with dry run, reverse, and FK handling"
```

---

### Task 14: Console signs in through the plane (PKCE, `agentpod-console`)

Today the console's only auth client is Better Auth's (`apps/console/src/lib/stores/auth.svelte.ts:10,31-36`): email sign-in (`:217`), sign-up (`:263`), sign-out (`:306`), session restore via `getSession()` (`:149`), and the admin role from the session (`:157`). Under the plane the console asks the hub which issuer to use (`GET /public/org-plane`, Task 1), runs authorization code + PKCE S256 against the plane as the public client `agentpod-console`, and keeps tokens **in memory only** — the contract: "A product that cannot hold one securely re-runs authorize; the plane's session makes that silent." A reload therefore re-runs authorize, silently when the plane's session is alive. The admin role comes from `GET /api/me` (Task 12), so every existing `auth.user?.role === "admin"` check (`command-palette.svelte:34`, `ContextRail.svelte:70`, `nodes/[id]/+page.svelte:96`, `fleet.svelte.ts:127`, `settings/+page.svelte:70-73`) keeps working unchanged.

Legacy mode (the hub answers `{ issuer: null }`, or is an older hub that 404s the route): today's Better Auth flow, unchanged.

**Files:**
- Create: `apps/console/src/lib/auth/pkce.ts`, `apps/console/src/lib/auth/pkce.test.ts`
- Create: `apps/console/src/lib/auth/org-plane.ts`, `apps/console/src/lib/auth/org-plane.test.ts`
- Create: `apps/console/src/routes/auth/callback/+page.svelte`, `apps/console/src/routes/auth/callback/page.svelte.test.ts`
- Modify: `apps/console/src/lib/stores/auth.svelte.ts` (`initAuth` `:133-170`, `logout` `:299-315`, `getToken` `:332-336`; new `setPlane`)
- Modify: `apps/console/src/lib/stores/connection.svelte.ts:133-143` (discover the plane after the health probe)
- Modify: `apps/console/src/routes/login/+page.svelte` (plane mode: one "Continue with your Super Jackfruit account" button; the email form and sign-up toggle only in legacy mode)
- Modify: `apps/console/src/routes/+layout.svelte:25` (`publicRoutes` gains `/auth/callback`)
- Modify: `apps/console/src/lib/stores/auth.svelte.test.ts`

**Interfaces:**
- Consumes: hub `GET /public/org-plane` → `{ issuer: null } | { issuer, url, audience }` (Task 1); hub `GET /api/me` → `{ id, email, isAdmin, issuer }` (Task 12); plane `/api/auth/oauth2/authorize`, `/api/auth/oauth2/token` (contract §3.1).
- Produces:
  - `pkce.ts`: `randomUrlSafe(bytes: number): string`, `challengeFor(verifier: string): Promise<string>`
  - `org-plane.ts`:
    - `interface PlaneDiscovery { issuer: string; url: string; audience: string }`
    - `CLIENT_ID = "agentpod-console"`, `SCOPE = "openid profile email offline_access"`
    - `discoverPlane(hub: string, fetchFn?: typeof fetch): Promise<PlaneDiscovery | null>`
    - `beginSignIn(plane: PlaneDiscovery, opts: { returnTo: string; origin?: string; storage?: Storage; navigate?: (url: string) => void }): Promise<void>`
    - `completeSignIn(params: URLSearchParams, plane: PlaneDiscovery, opts?: { origin?: string; storage?: Storage; fetchFn?: typeof fetch; now?: () => number }): Promise<{ returnTo: string }>`
    - `planeAccessToken(plane: PlaneDiscovery, opts?: { minValiditySec?: number; fetchFn?: typeof fetch; now?: () => number }): Promise<string | null>` — refreshes with the in-memory refresh token when the access token has under `minValiditySec` (default 30) left; `null` when signed out or refresh fails.
    - `signOutLocal(storage?: Storage): void`, `wasSignedIn(storage?: Storage): boolean` (a non-secret sessionStorage flag, so a reload re-runs authorize silently instead of showing /login).
  - `auth.svelte.ts`: `setPlane(p: PlaneDiscovery | null): void`, `currentPlane(): PlaneDiscovery | null`; `getToken(): Promise<string | null>` returns the plane token under the plane, `null` in legacy mode (as today).

- [ ] **Step 1: Write the failing tests**

`apps/console/src/lib/auth/pkce.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { challengeFor, randomUrlSafe } from "./pkce";

describe("pkce", () => {
  test("verifier is base64url and long enough (RFC 7636: 43-128 chars)", () => {
    const v = randomUrlSafe(48);
    expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  test("S256 challenge of the RFC 7636 appendix B vector", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
```

`apps/console/src/lib/auth/org-plane.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { beginSignIn, completeSignIn, discoverPlane, planeAccessToken, signOutLocal, wasSignedIn } from "./org-plane";

const PLANE = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };
const ORIGIN = "https://console.test";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  sessionStorage.clear();
  signOutLocal();
});

describe("discoverPlane", () => {
  test("null issuer and a 404 (older hub) both mean legacy", async () => {
    expect(await discoverPlane("https://hub.test", async () => json(200, { issuer: null }))).toBeNull();
    expect(await discoverPlane("https://hub.test", async () => json(404, {}))).toBeNull();
  });
  test("a configured hub names the plane", async () => {
    expect(await discoverPlane("https://hub.test", async () => json(200, PLANE))).toEqual(PLANE);
  });
});

describe("authorization code + PKCE", () => {
  test("beginSignIn sends client, redirect, S256 challenge, state and resource", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/nodes", origin: ORIGIN, navigate: (u) => (went = u) });
    const u = new URL(went);
    expect(u.origin + u.pathname).toBe("https://accounts.test/api/auth/oauth2/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "agentpod-console",
      redirect_uri: "https://console.test/auth/callback",
      code_challenge_method: "S256",
      resource: "https://hub.test",
    });
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  test("completeSignIn checks state, posts the verifier with resource, and holds the token in memory", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/nodes", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    const fetchFn = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init!.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("agentpod-console");
      expect(body.get("resource")).toBe("https://hub.test");
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      return json(200, { access_token: "at1", token_type: "Bearer", expires_in: 300, refresh_token: "rt1" });
    });
    const out = await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, { origin: ORIGIN, fetchFn: fetchFn as never, now: () => 0 });
    expect(out).toEqual({ returnTo: "/nodes" });
    expect(await planeAccessToken(PLANE, { now: () => 0 })).toBe("at1");
    expect(wasSignedIn()).toBe(true);
    expect(JSON.stringify(sessionStorage)).not.toContain("rt1"); // the refresh token never leaves memory
  });

  test("a state mismatch is refused and no token request is made", async () => {
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: () => {} });
    const fetchFn = vi.fn();
    await expect(completeSignIn(new URLSearchParams({ code: "c", state: "forged" }), PLANE, { fetchFn: fetchFn as never })).rejects.toThrow(/state/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("an access token about to expire is refreshed with the rotating refresh token", async () => {
    let went = "";
    await beginSignIn(PLANE, { returnTo: "/", origin: ORIGIN, navigate: (u) => (went = u) });
    const state = new URL(went).searchParams.get("state")!;
    await completeSignIn(new URLSearchParams({ code: "c", state }), PLANE, {
      origin: ORIGIN, now: () => 0,
      fetchFn: (async () => json(200, { access_token: "at1", expires_in: 300, refresh_token: "rt1" })) as never,
    });
    const refresh = vi.fn(async (_u: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init!.body));
      expect([body.get("grant_type"), body.get("refresh_token"), body.get("resource")]).toEqual(["refresh_token", "rt1", "https://hub.test"]);
      return json(200, { access_token: "at2", expires_in: 300, refresh_token: "rt2" });
    });
    expect(await planeAccessToken(PLANE, { now: () => 280_000, fetchFn: refresh as never })).toBe("at2");
  });

  test("signOutLocal forgets tokens and the signed-in flag", async () => {
    signOutLocal();
    expect(await planeAccessToken(PLANE)).toBeNull();
    expect(wasSignedIn()).toBe(false);
  });
});
```

Add to `apps/console/src/lib/stores/auth.svelte.test.ts` (it mocks `better-auth/svelte` at `:13-25`):

```ts
import * as plane from "$lib/auth/org-plane";
import { setPlane, initAuth, auth, logout, getToken, clearAuthSession, setAuthApiUrl } from "./auth.svelte";

describe("under the org plane", () => {
  const P = { issuer: "https://accounts.test", url: "https://accounts.test", audience: "https://hub.test" };

  test("initAuth restores the user from /api/me with the plane token, never Better Auth", async () => {
    clearAuthSession();
    setAuthApiUrl("https://hub.test");
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "prn_hhhhhhhhhhhhhhhhhhhh", email: "op@example.com", isAdmin: true, issuer: "org-plane" }), { status: 200 }),
    );
    await initAuth();
    expect(fetchSpy).toHaveBeenCalledWith("https://hub.test/api/me", expect.objectContaining({ headers: { Authorization: "Bearer at1" } }));
    expect(auth.user?.role).toBe("admin");
    expect(mockAuthClient.getSession).not.toHaveBeenCalled();
  });

  test("getToken returns the plane token; logout signs out locally", async () => {
    setPlane(P);
    vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
    const out = vi.spyOn(plane, "signOutLocal");
    expect(await getToken()).toBe("at1");
    await logout();
    expect(out).toHaveBeenCalled();
    expect(mockAuthClient.signOut).not.toHaveBeenCalled();
  });

  test("legacy mode: getToken is still null", async () => {
    setPlane(null);
    expect(await getToken()).toBeNull();
  });
});
```

`apps/console/src/routes/auth/callback/page.svelte.test.ts`:

```ts
import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
import { goto } from "$app/navigation";
import * as plane from "$lib/auth/org-plane";
import * as authStore from "$lib/stores/auth.svelte";
import Page from "./+page.svelte";

beforeEach(() => vi.restoreAllMocks());

test("completes the sign-in and goes to where the user was going", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  vi.spyOn(plane, "completeSignIn").mockResolvedValue({ returnTo: "/nodes" });
  vi.spyOn(authStore, "initAuth").mockResolvedValue();
  window.history.replaceState({}, "", "/auth/callback?code=c&state=s");
  render(Page);
  await waitFor(() => expect(goto).toHaveBeenCalledWith("/nodes", { replaceState: true }));
});

test("an error from the plane is shown, not swallowed", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  window.history.replaceState({}, "", "/auth/callback?error=access_denied&error_description=Denied");
  const { findByText } = render(Page);
  expect(await findByText(/Denied/)).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/console && pnpm test -- src/lib/auth src/lib/stores/auth.svelte.test.ts src/routes/auth`
Expected: FAIL — modules not found; `setPlane` not exported.

- [ ] **Step 3: Write the implementation**

`apps/console/src/lib/auth/pkce.ts`:

```ts
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomUrlSafe(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
```

`apps/console/src/lib/auth/org-plane.ts`:

```ts
/**
 * Signing in through the organization plane (contract §3.1): authorization code + PKCE S256,
 * public client `agentpod-console`, `resource` = the hub's audience. Tokens live in memory only;
 * a reload re-runs authorize, which the plane's own session makes silent.
 */
import { challengeFor, randomUrlSafe } from "./pkce";

export interface PlaneDiscovery { issuer: string; url: string; audience: string }
export const CLIENT_ID = "agentpod-console";
export const SCOPE = "openid profile email offline_access";
const PENDING = "agentpod.pkce";
const SIGNED_IN = "agentpod.planeSignedIn";

let tokens: { access: string; expiresAt: number; refresh: string | null } | null = null;

const store = (s?: Storage) => s ?? sessionStorage;
const redirectUri = (origin: string) => `${origin}/auth/callback`;

export async function discoverPlane(hub: string, fetchFn: typeof fetch = fetch): Promise<PlaneDiscovery | null> {
  try {
    const res = await fetchFn(`${hub.replace(/\/$/, "")}/public/org-plane`);
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<PlaneDiscovery> & { issuer: string | null };
    return body.issuer && body.url && body.audience ? { issuer: body.issuer, url: body.url, audience: body.audience } : null;
  } catch {
    return null;
  }
}

export async function beginSignIn(
  plane: PlaneDiscovery,
  opts: { returnTo: string; origin?: string; storage?: Storage; navigate?: (url: string) => void },
): Promise<void> {
  const origin = opts.origin ?? window.location.origin;
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  store(opts.storage).setItem(PENDING, JSON.stringify({ verifier, state, returnTo: opts.returnTo }));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(origin),
    scope: SCOPE,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
    resource: plane.audience,
  });
  (opts.navigate ?? ((u: string) => window.location.assign(u)))(`${plane.url}/api/auth/oauth2/authorize?${q}`);
}

async function tokenRequest(plane: PlaneDiscovery, body: Record<string, string>, fetchFn: typeof fetch, now: () => number) {
  const res = await fetchFn(`${plane.url}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID, resource: plane.audience }).toString(),
  });
  if (!res.ok) throw new Error(`The account service refused the sign-in (HTTP ${res.status}).`);
  const j = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
  tokens = { access: j.access_token, expiresAt: now() + j.expires_in * 1000, refresh: j.refresh_token ?? tokens?.refresh ?? null };
}

export async function completeSignIn(
  params: URLSearchParams,
  plane: PlaneDiscovery,
  opts: { origin?: string; storage?: Storage; fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<{ returnTo: string }> {
  const s = store(opts.storage);
  const pending = JSON.parse(s.getItem(PENDING) ?? "null") as { verifier: string; state: string; returnTo: string } | null;
  s.removeItem(PENDING);
  const error = params.get("error");
  if (error) throw new Error(params.get("error_description") ?? error);
  if (!pending || params.get("state") !== pending.state) throw new Error("Sign-in state did not match; start again.");
  await tokenRequest(
    plane,
    { grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: redirectUri(opts.origin ?? window.location.origin), code_verifier: pending.verifier },
    opts.fetchFn ?? fetch,
    opts.now ?? Date.now,
  );
  s.setItem(SIGNED_IN, "1");
  return { returnTo: pending.returnTo || "/" };
}

export async function planeAccessToken(
  plane: PlaneDiscovery,
  opts: { minValiditySec?: number; fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now;
  if (!tokens) return null;
  if (tokens.expiresAt - now() > (opts.minValiditySec ?? 30) * 1000) return tokens.access;
  if (!tokens.refresh) return null;
  try {
    await tokenRequest(plane, { grant_type: "refresh_token", refresh_token: tokens.refresh }, opts.fetchFn ?? fetch, now);
    return tokens.access;
  } catch {
    tokens = null;
    return null;
  }
}

export function signOutLocal(storage?: Storage): void {
  tokens = null;
  try {
    store(storage).removeItem(SIGNED_IN);
    store(storage).removeItem(PENDING);
  } catch {
    // storage unavailable: nothing to clear
  }
}

export function wasSignedIn(storage?: Storage): boolean {
  try {
    return store(storage).getItem(SIGNED_IN) === "1";
  } catch {
    return false;
  }
}
```

`apps/console/src/lib/stores/auth.svelte.ts` — add:

```ts
import { planeAccessToken, signOutLocal, type PlaneDiscovery } from "$lib/auth/org-plane";

let plane: PlaneDiscovery | null = null;
export function setPlane(p: PlaneDiscovery | null) { plane = p; }
export function currentPlane(): PlaneDiscovery | null { return plane; }
```

In `initAuth()`, before `const client = getAuthClient()`:

```ts
  if (plane && currentApiUrl) {
    isLoading = true;
    try {
      const token = await planeAccessToken(plane);
      if (token) {
        const res = await fetch(`${currentApiUrl}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const me = (await res.json()) as { id: string; email: string | null; isAdmin: boolean };
          sessionData = { user: { id: me.id, email: me.email ?? "", name: null, image: null, role: me.isAdmin ? "admin" : null } };
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn’t restore your session.";
    } finally {
      isLoading = false;
      isInitialized = true;
    }
    return;
  }
```

`logout()`: first line inside `try`: `if (plane) { signOutLocal(); sessionData = null; return; }`.
`getToken()`: `return plane ? planeAccessToken(plane) : null;`.
`clearAuthSession()`: also `plane = null`.

`apps/console/src/lib/stores/connection.svelte.ts` after `setAuthApiUrl(normalised);` (line 143):

```ts
      setPlane(await discoverPlane(normalised));
```

`apps/console/src/routes/auth/callback/+page.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { completeSignIn } from "$lib/auth/org-plane";
  import { currentPlane, initAuth } from "$lib/stores/auth.svelte";

  let message = $state("Signing you in…");

  onMount(async () => {
    const p = currentPlane();
    if (!p) {
      message = "This hub does not use an account service. Return to sign-in.";
      return;
    }
    try {
      const { returnTo } = await completeSignIn(new URLSearchParams(window.location.search), p);
      await initAuth();
      await goto(returnTo, { replaceState: true });
    } catch (err) {
      message = err instanceof Error ? err.message : "Sign-in failed.";
    }
  });
</script>

<main class="flex min-h-screen items-center justify-center p-4">
  <p role="status">{message}</p>
</main>
```

`apps/console/src/routes/+layout.svelte:25`: `const publicRoutes = ["/login", "/auth/callback"];`. In the guard effect (`:77-87`), before `goto("/login")`:

```ts
      const p = currentPlane();
      if (p && wasSignedIn()) {
        void beginSignIn(p, { returnTo: currentPath }); // silent when the plane's session is alive
        return;
      }
```

Because `initAuth()` already set `isInitialized`, the layout must re-run `initAuth()` after the callback — the callback page does that (`await initAuth()` above) but `initAuth` returns early once initialized; add `export function resetAuthInit() { isInitialized = false; }` to `auth.svelte.ts` and call it in the callback before `initAuth()`.

`apps/console/src/routes/login/+page.svelte`: when `currentPlane()` is non-null, render only

```svelte
<button class="btn btn-primary w-full" onclick={() => beginSignIn(currentPlane()!, { returnTo: resolveReturnTo(page.url) })}>
  Continue with your Super Jackfruit account
</button>
```

and hide the email form, the sign-up toggle and the `signup-status` fetch (`:38`). (`resolveReturnTo` is the existing helper from `$lib/utils/return-to.ts`; use the same argument the page passes today at `:95-103`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/console && pnpm check && pnpm test && pnpm build` — Expected: PASS. Revert-proof: drop the `state` comparison in `completeSignIn` and watch "a state mismatch is refused" fail.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib/auth apps/console/src/routes/auth apps/console/src/lib/stores/auth.svelte.ts apps/console/src/lib/stores/auth.svelte.test.ts apps/console/src/lib/stores/connection.svelte.ts apps/console/src/routes/login/+page.svelte apps/console/src/routes/+layout.svelte
git commit -m "feat(console): sign in through the org plane with PKCE as agentpod-console when the hub names one"
```

---

### Task 15: Console sends the plane token on every hub request, socket and stream

Today every hub call relies on the Better Auth cookie (`credentials: "include"`): `http()` (`apps/console/src/lib/api/client.ts:29-50`), `apiRequest()` (`lib/api/admin.ts:42-75`), `readFile`/`readImage` (`client.ts:315-356`), `fetchVoicePreview` (`lib/api/speech.ts:154-156`), the log `EventSource` (`lib/components/stations/LogTail.svelte:76-80`), and the two WebSockets (`lib/api/terminal.ts:67-68`, `lib/api/acp.ts:114-115`), which send no credential of their own. `lib/api/my-grant.ts:44` reads `mayGrantReach` from the hub's `GET /api/auth/token`, which is 410 under the plane (Task 8). Browsers cannot set headers on `WebSocket` or `EventSource`, so those carry `?token=`, which `authMiddleware` already reads (`apps/hub/src/auth/middleware.ts:158`, kept in Task 5).

**Files:**
- Modify: `apps/console/src/lib/api/client.ts` (new `authFetch`, `withToken`; `http`, `readFile`, `readImage`)
- Modify: `apps/console/src/lib/api/admin.ts:42-75`, `apps/console/src/lib/api/speech.ts:154-156`
- Modify: `apps/console/src/lib/api/terminal.ts:66-68`, `apps/console/src/lib/api/acp.ts:113-115` (accept a token)
- Modify: `apps/console/src/lib/components/stations/Terminal.svelte:147`, `apps/console/src/lib/components/stations/chat/acp-chat.svelte.ts:584`, `apps/console/src/lib/components/stations/LogTail.svelte:76-80`
- Modify: `apps/console/src/lib/api/my-grant.ts:40-55`
- Modify: `apps/console/src/lib/api/terminal.test.ts`, `apps/console/src/lib/api/acp.test.ts`, `apps/console/src/lib/api/my-grant.test.ts`; Create: `apps/console/src/lib/api/auth-fetch.test.ts`

**Interfaces:**
- Consumes: `getToken(): Promise<string | null>`, `currentPlane()` (Task 14).
- Produces:
  - `authFetch(url: string, init?: RequestInit): Promise<Response>` — with a token: `Authorization: Bearer`, `credentials: "omit"`; without: today's `credentials: "include"`.
  - `withToken(url: string, token: string | null): string` — appends `token=` (URL-encoded) when non-null.
  - `createTerminalClient(stationId: string, token?: string | null)`, `createAcpSocket(sessionId: string, token?: string | null)`.
  - `SOCKET_MIN_VALIDITY_SEC = 60` — callers ask `getToken` for a token that outlives the upgrade.

- [ ] **Step 1: Write the failing tests**

`apps/console/src/lib/api/auth-fetch.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as authStore from "$lib/stores/auth.svelte";
import { authFetch, http, withToken } from "./client";

beforeEach(() => vi.restoreAllMocks());

describe("authFetch", () => {
  test("legacy: the cookie, exactly as today", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue(null);
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await authFetch("https://hub.test/api/nodes");
    expect(f).toHaveBeenCalledWith("https://hub.test/api/nodes", { credentials: "include" });
  });

  test("plane: a bearer token and no cookie", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await authFetch("https://hub.test/api/nodes", { method: "POST" });
    const init = f.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer at1");
    expect(init.credentials).toBe("omit");
    expect(init.method).toBe("POST");
  });

  test("http() goes through authFetch", async () => {
    vi.spyOn(authStore, "getToken").mockResolvedValue("at1");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    await http("/api/nodes");
    expect(new Headers(f.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer at1");
  });

  test("withToken encodes and only appends when there is a token", () => {
    expect(withToken("wss://h/x", null)).toBe("wss://h/x");
    expect(withToken("wss://h/x", "a.b+c")).toBe("wss://h/x?token=a.b%2Bc");
    expect(withToken("https://h/x?y=1", "t")).toBe("https://h/x?y=1&token=t");
  });
});
```

Add to `apps/console/src/lib/api/terminal.test.ts` (it already stubs `WebSocket`; if it captures the constructor URL as `lastUrl` or similar, use that, else add a `vi.stubGlobal("WebSocket", …)` that records the URL):

```ts
test("opens the terminal socket with a token fresh enough to last", async () => {
  const urls: string[] = [];
  vi.stubGlobal("WebSocket", class { constructor(u: string) { urls.push(u); } addEventListener() {} send() {} close() {} } as never);
  createTerminalClient("st_1", "at1");
  expect(urls[0]).toMatch(/\/api\/stations\/st_1\/terminal\?token=at1$/);
});
```

and in `Terminal.svelte`'s caller path, the `getToken` call must pass `SOCKET_MIN_VALIDITY_SEC`; pin it in `apps/console/src/lib/stores/auth.svelte.test.ts`:

```ts
test("getToken(minValiditySec) passes the floor to the plane", async () => {
  setPlane({ issuer: "i", url: "u", audience: "a" });
  const spy = vi.spyOn(plane, "planeAccessToken").mockResolvedValue("at1");
  await getToken(60);
  expect(spy).toHaveBeenCalledWith({ issuer: "i", url: "u", audience: "a" }, { minValiditySec: 60 });
});
```

Add the same socket assertion to `acp.test.ts` for `createAcpSocket("s_1", "at1")` → `/api/acp/sessions/s_1/ws?token=at1`.

In `my-grant.test.ts`:

```ts
test("under the plane, reach is read from the console's own token, not GET /api/auth/token", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  const payload = btoa(JSON.stringify({ mayGrantReach: false })).replace(/=+$/, "");
  vi.spyOn(authStore, "getToken").mockResolvedValue(`h.${payload}.s`);
  const httpSpy = vi.spyOn(client, "http");
  forgetMyReach();
  expect(await myReach()).toEqual({ mayGrantReach: false });
  expect(httpSpy).not.toHaveBeenCalled();
});
```

(Use the file's existing exported function name for the reach getter if it is not `myReach`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/console && pnpm test -- src/lib/api src/lib/stores/auth.svelte.test.ts` — Expected: FAIL (`authFetch`/`withToken` missing, sockets carry no token, `getToken` takes no argument).

- [ ] **Step 3: Write the implementation**

`apps/console/src/lib/api/client.ts`:

```ts
import { clearAuthSession, getToken } from "$lib/stores/auth.svelte";

export const SOCKET_MIN_VALIDITY_SEC = 60;

/** Bearer when the console holds a plane token; the hub cookie otherwise (legacy, unchanged). */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) return fetch(url, { credentials: "include", ...init });
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers, credentials: "omit" });
}

/** WebSocket and EventSource cannot send headers; the hub reads `?token=` for them. */
export function withToken(url: string, token: string | null): string {
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}
```

In `http()`, replace `fetch(\`${hubUrl()}${path}\`, { credentials: "include", ...init })` with `authFetch(\`${hubUrl()}${path}\`, init)`. Same replacement in `readFile`, `readImage`, `admin.ts` `apiRequest` (drop its `credentials: "include"` and call `authFetch(url, init)`), and `speech.ts` `fetchVoicePreview`.

`apps/console/src/lib/stores/auth.svelte.ts`: `export async function getToken(minValiditySec?: number): Promise<string | null> { return plane ? planeAccessToken(plane, minValiditySec ? { minValiditySec } : {}) : null; }`.

`terminal.ts` / `acp.ts`:

```ts
export function createTerminalClient(stationId: string, token: string | null = null): TerminalClient {
  const wsUrl = withToken(`${hubUrl().replace(/^http/, "ws")}/api/stations/${stationId}/terminal`, token);
```

```ts
export function createAcpSocket(sessionId: string, token: string | null = null): AcpSocket {
  const wsUrl = withToken(`${hubUrl().replace(/^http/, "ws")}/api/acp/sessions/${sessionId}/ws`, token);
```

Callers — `Terminal.svelte:147`: `const c = createTerminalClient(stationId, await getToken(SOCKET_MIN_VALIDITY_SEC));` (make the enclosing function `async` if it is not); `acp-chat.svelte.ts:584`: `const s = createAcpSocket(session.id, await getToken(SOCKET_MIN_VALIDITY_SEC));`. Every reconnect path re-fetches the token the same way (the hub authenticates the upgrade only, so an open socket outlives its token, but a reconnect needs a fresh one).

`LogTail.svelte:76-80`:

```ts
    const token = await getToken(SOCKET_MIN_VALIDITY_SEC);
    const url = withToken(logsUrl(stationId), token);
    es = new EventSource(url, { withCredentials: token === null });
```

(make the enclosing `connect` function `async`.)

`my-grant.ts`:

```ts
  cached = (async () => {
    try {
      const token = currentPlane() ? await getToken() : (await http<{ token?: string }>("/api/auth/token")).token;
      const claims = token ? claimsOf(token) : null;
      if (!claims || typeof claims.mayGrantReach !== "boolean") return PERMITTED;
      return { mayGrantReach: claims.mayGrantReach };
    } catch {
      return PERMITTED;
    }
  })();
```

and call `forgetMyReach()` from `logout()` in `auth.svelte.ts` (today it is never called after sign-out — `my-grant.ts:57`).

The console's devices page (`lib/api/devices.ts:30,33` → `/api/auth/devices`, 410 under the plane): when `currentPlane()` is set, the settings page shows "Devices are managed in your Super Jackfruit account" linking to `${currentPlane().url}` instead of the list. Same for `/admin/users` and `/admin/grants` pages (the hub answers `410 managed_by_org_plane` with `url`, Task 12): render the 410 body's `url` as a link instead of an error.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/console && pnpm check && pnpm test && pnpm build` — Expected: PASS. Revert-proof: make `authFetch` always use `credentials: "include"` and no header, and watch "plane: a bearer token and no cookie" fail.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/lib apps/console/src/routes
git commit -m "feat(console): bearer plane tokens on fetches, ?token= on sockets and log streams"
```

---

### Task 16: `fleet login` uses the plane's device flow

Today `fleet login` runs authorization code + PKCE with a loopback redirect against the hub (`apps/node-agent/cmd/agentpod-fleet/fleet_login.go:74-201`: `GET {hub}/api/auth/authorize`, `POST {hub}/api/auth/token/exchange`), then mints a hub device credential (`internal/fleetcred/device.go:175-209`, `POST {hub}/api/auth/devices`), and every later command exchanges it at `POST {hub}/api/auth/devices/token?client=apn` (`device.go:129-167`) through `Resolve` (`device.go:224-252`). Under the plane all three hub routes answer 410 (Task 8).

Under the plane (`GET {hub}/public/org-plane` names one), `fleet login` runs contract §3.2: `POST {plane}/api/auth/device/code { client_id: "apn", scope: "openid" }`, prints `verification_uri_complete` and the user code, polls `POST {plane}/api/auth/device/token` until it answers `{ "device_credential": "dev_…:…" }`, stores that as the device credential (with the plane's URL and the hub's audience), and exchanges it at `POST {plane}/api/token/device { audience }`. An older hub (404 on discovery) or `{ issuer: null }` keeps today's flow unchanged. No new environment variable: the hub says where the plane is.

**Files:**
- Create: `apps/node-agent/internal/fleetcred/plane.go`
- Create: `apps/node-agent/internal/fleetcred/plane_test.go`
- Modify: `apps/node-agent/internal/fleetcred/device.go:40-45` (`Device` gains three fields), `:224-252` (`Resolve` branches on `PlaneURL`)
- Create: `apps/node-agent/cmd/agentpod-fleet/fleet_login_plane.go`
- Modify: `apps/node-agent/cmd/agentpod-fleet/fleet_login.go:79` (discover first)
- Modify: `apps/node-agent/cmd/agentpod-fleet/fleet.go:187-204` (`fleetLogout`: a plane credential is revoked at the plane's Devices page, not the hub)
- Modify: `apps/node-agent/cmd/agentpod-fleet/fleet_login_test.go` (plane login end to end)
- Modify: `apps/node-agent/cmd/agentpod-fleet/help.go:55-62` (help text: "signs in through your hub's account service when it has one")

**Interfaces:**
- Consumes: hub `GET /public/org-plane` (Task 1); plane endpoints (contract §3.2).
- Produces (package `fleetcred`):
  - `type Plane struct { Issuer, URL, Audience string }`
  - `func DiscoverPlane(hub string) (*Plane, error)` — `nil, nil` for legacy (404 or `issuer: null`).
  - `type DeviceCode struct { DeviceCode, UserCode, VerificationURI, VerificationURIComplete string; ExpiresIn, Interval int }` (JSON: RFC 8628 names)
  - `func StartDeviceFlow(p Plane) (DeviceCode, error)`
  - `var ErrAuthorizationPending, ErrSlowDown, ErrAccessDenied, ErrDeviceCodeExpired error`
  - `func PollDeviceToken(p Plane, deviceCode string) (Device, error)` — one poll.
  - `func WaitForDevice(p Plane, dc DeviceCode, sleep func(time.Duration)) (Device, error)`
  - `func ExchangeAtPlane(d Device) (string, error)`
  - `Device` gains `PlaneURL string \`json:"plane_url,omitempty"\``, `Issuer string \`json:"issuer,omitempty"\``, `Audience string \`json:"audience,omitempty"\``.

- [ ] **Step 1: Write the failing tests**

`apps/node-agent/internal/fleetcred/plane_test.go`:

```go
package fleetcred

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const devCred = "dev_0123456789abcdef0123:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"

// fakePlane is the hub (discovery) and the plane in one server; polls answer pending N times.
func fakePlane(t *testing.T, pendingPolls int) (*httptest.Server, *[]string) {
	t.Helper()
	var seen []string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/public/org-plane":
			_ = json.NewEncoder(w).Encode(map[string]string{"issuer": srv.URL, "url": srv.URL, "audience": "https://hub.test"})
		case "/api/auth/device/code":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["client_id"] != "apn" || body["scope"] != "openid" {
				t.Errorf("device/code body = %v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_code": "dc1", "user_code": "ABCD-EFGH", "verification_uri": srv.URL + "/device",
				"verification_uri_complete": srv.URL + "/device?user_code=ABCD-EFGH", "expires_in": 600, "interval": 5,
			})
		case "/api/auth/device/token":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["grant_type"] != "urn:ietf:params:oauth:grant-type:device_code" || body["device_code"] != "dc1" || body["client_id"] != "apn" {
				t.Errorf("device/token body = %v", body)
			}
			if pendingPolls > 0 {
				pendingPolls--
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"device_credential":"` + devCred + `"}`))
		case "/api/token/device":
			if got := r.Header.Get("Authorization"); got != "Bearer "+devCred {
				t.Errorf("exchange presented %q", got)
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["audience"] != "https://hub.test" {
				t.Errorf("audience = %q", body["audience"])
			}
			_, _ = w.Write([]byte(`{"access_token":"plane-token","token_type":"Bearer","expires_in":300}`))
		default:
			http.NotFound(w, r)
		}
	}))
	return srv, &seen
}

func TestDiscoverPlaneLegacyAndConfigured(t *testing.T) {
	legacy := httptest.NewServer(http.NotFoundHandler())
	defer legacy.Close()
	if p, err := DiscoverPlane(legacy.URL); p != nil || err != nil {
		t.Fatalf("404 must mean legacy, got %+v %v", p, err)
	}
	null := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"issuer":null}`)) }))
	defer null.Close()
	if p, err := DiscoverPlane(null.URL); p != nil || err != nil {
		t.Fatalf("issuer:null must mean legacy, got %+v %v", p, err)
	}
	srv, _ := fakePlane(t, 0)
	defer srv.Close()
	p, err := DiscoverPlane(srv.URL)
	if err != nil || p == nil || p.Audience != "https://hub.test" {
		t.Fatalf("got %+v %v", p, err)
	}
}

func TestDeviceFlowWaitsThroughPendingAndHonoursTheInterval(t *testing.T) {
	srv, _ := fakePlane(t, 2)
	defer srv.Close()
	p := Plane{Issuer: srv.URL, URL: srv.URL, Audience: "https://hub.test"}
	dc, err := StartDeviceFlow(p)
	if err != nil {
		t.Fatal(err)
	}
	var slept []time.Duration
	d, err := WaitForDevice(p, dc, func(s time.Duration) { slept = append(slept, s) })
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != "dev_0123456789abcdef0123" || !strings.HasPrefix(d.Secret, "AbCd") || d.PlaneURL != srv.URL || d.Audience != "https://hub.test" {
		t.Fatalf("device = %+v", d)
	}
	if len(slept) != 3 || slept[0] != 5*time.Second {
		t.Fatalf("slept %v, want three waits of the 5s interval", slept)
	}
}

func TestSlowDownAddsFiveSeconds(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"slow_down"}`))
			return
		}
		_, _ = w.Write([]byte(`{"device_credential":"` + devCred + `"}`))
	}))
	defer srv.Close()
	var slept []time.Duration
	_, err := WaitForDevice(Plane{URL: srv.URL}, DeviceCode{DeviceCode: "dc", Interval: 5, ExpiresIn: 600}, func(s time.Duration) { slept = append(slept, s) })
	if err != nil {
		t.Fatal(err)
	}
	if slept[1] != 10*time.Second {
		t.Fatalf("after slow_down the wait should grow to 10s, slept %v", slept)
	}
}

func TestAccessDeniedStopsAtOnce(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"access_denied"}`))
	}))
	defer srv.Close()
	_, err := WaitForDevice(Plane{URL: srv.URL}, DeviceCode{DeviceCode: "dc", Interval: 5, ExpiresIn: 600}, func(time.Duration) {})
	if !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("err = %v", err)
	}
}

func TestAMalformedDeviceCredentialIsRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"an RFC 8628 token response, not ours"}`))
	}))
	defer srv.Close()
	if _, err := PollDeviceToken(Plane{URL: srv.URL}, "dc"); err == nil {
		t.Fatal("a response without device_credential must be an error")
	}
}

func TestResolveExchangesAPlaneDeviceAtThePlane(t *testing.T) {
	withConfigDir(t)
	srv, seen := fakePlane(t, 0)
	defer srv.Close()
	hub := srv.URL
	if err := SaveDevice(Device{ID: "dev_0123456789abcdef0123", Secret: strings.SplitN(devCred, ":", 2)[1], Hub: hub, PlaneURL: srv.URL, Audience: "https://hub.test"}); err != nil {
		t.Fatal(err)
	}
	c, err := Resolve(hub)
	if err != nil || c.Token != "plane-token" {
		t.Fatalf("Resolve = %+v %v", c, err)
	}
	for _, s := range *seen {
		if strings.HasPrefix(s, "POST /api/auth/devices/token") {
			t.Fatal("a plane credential must never be sent to the hub's exchange")
		}
	}
}
```

Append to `apps/node-agent/cmd/agentpod-fleet/fleet_login_test.go`:

```go
// A hub that names an org plane: login runs the device flow there, prints the code, and the next
// command works from the stored device credential. The fake approves after one pending poll.
func TestLoginUsesThePlaneDeviceFlowWhenTheHubNamesOne(t *testing.T) {
	bin := build(t)
	home := t.TempDir()
	var srv *httptest.Server
	polls := 0
	tok := jwtish("prn_plane_login", "human")
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/public/org-plane":
			fmt.Fprintf(w, `{"issuer":%q,"url":%q,"audience":"https://hub.test"}`, srv.URL, srv.URL)
		case "/api/auth/device/code":
			fmt.Fprintf(w, `{"device_code":"dc","user_code":"WXYZ-1234","verification_uri":"%s/device","verification_uri_complete":"%s/device?user_code=WXYZ-1234","expires_in":600,"interval":1}`, srv.URL, srv.URL)
		case "/api/auth/device/token":
			polls++
			if polls == 1 {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
				return
			}
			_, _ = w.Write([]byte(`{"device_credential":"dev_0123456789abcdef0123:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"}`))
		case "/api/token/device":
			fmt.Fprintf(w, `{"access_token":%q,"token_type":"Bearer","expires_in":300}`, tok)
		default:
			http.Error(w, `{"error":"issuer_moved"}`, http.StatusGone)
		}
	}))
	defer srv.Close()

	out, code := runLogin(t, bin, srv.URL, home, "login")
	if code != 0 {
		t.Fatalf("login failed (%d):\n%s", code, out)
	}
	if !strings.Contains(out, "WXYZ-1234") || !strings.Contains(out, "prn_plane_login") {
		t.Fatalf("login must show the user code and who signed in:\n%s", out)
	}
	if strings.Contains(out, "/api/auth/authorize") {
		t.Fatalf("the loopback flow must not run against a plane hub:\n%s", out)
	}
}
```

(Add `"fmt"`, `"net/http"`, `"net/http/httptest"` to the file's imports if absent.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/node-agent && go test -race ./internal/fleetcred/ ./cmd/agentpod-fleet/`
Expected: FAIL — `undefined: DiscoverPlane`, `Device` has no field `PlaneURL`.

- [ ] **Step 3: Write the implementation**

`apps/node-agent/internal/fleetcred/plane.go`:

```go
package fleetcred

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Plane is the organization plane a hub defers to, as GET {hub}/public/org-plane names it.
type Plane struct {
	Issuer   string `json:"issuer"`
	URL      string `json:"url"`
	Audience string `json:"audience"`
}

// DeviceCode is the RFC 8628 device authorization response.
type DeviceCode struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

var (
	ErrAuthorizationPending = errors.New("authorization pending")
	ErrSlowDown             = errors.New("slow down")
	ErrAccessDenied         = errors.New("the sign-in was denied")
	ErrDeviceCodeExpired    = errors.New("the sign-in code expired; run fleet login again")
)

var planeHTTP = &http.Client{Timeout: 30 * time.Second}
var devCredential = regexp.MustCompile(`^(dev_[0-9a-f]{20}):([A-Za-z0-9_-]{43})$`)

func postJSON(url string, body any, bearer string) (*http.Response, error) {
	b, _ := json.Marshal(body)
	req, err := http.NewRequest("POST", url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return planeHTTP.Do(req)
}

// DiscoverPlane asks the hub. nil, nil means the hub issues its own tokens (legacy).
func DiscoverPlane(hub string) (*Plane, error) {
	res, err := planeHTTP.Get(strings.TrimRight(hub, "/") + "/public/org-plane")
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", hub, err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	var out struct {
		Issuer   *string `json:"issuer"`
		URL      string  `json:"url"`
		Audience string  `json:"audience"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != 200 {
		return nil, fmt.Errorf("the hub's org-plane answer was unreadable (%d)", res.StatusCode)
	}
	if out.Issuer == nil || *out.Issuer == "" {
		return nil, nil
	}
	return &Plane{Issuer: *out.Issuer, URL: strings.TrimRight(out.URL, "/"), Audience: out.Audience}, nil
}

func StartDeviceFlow(p Plane) (DeviceCode, error) {
	res, err := postJSON(p.URL+"/api/auth/device/code", map[string]string{"client_id": ClientID, "scope": "openid"}, "")
	if err != nil {
		return DeviceCode{}, fmt.Errorf("could not reach the account service: %w", err)
	}
	defer res.Body.Close()
	var dc DeviceCode
	if err := json.NewDecoder(res.Body).Decode(&dc); err != nil || res.StatusCode != 200 || dc.DeviceCode == "" {
		return DeviceCode{}, fmt.Errorf("the account service refused to start a sign-in (%d)", res.StatusCode)
	}
	return dc, nil
}

// PollDeviceToken polls once. The success body is NOT an RFC 8628 token response: it is
// { "device_credential": "dev_<20 hex>:<43 base64url>" } (contract §3.2).
func PollDeviceToken(p Plane, deviceCode string) (Device, error) {
	res, err := postJSON(p.URL+"/api/auth/device/token", map[string]string{
		"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
		"device_code": deviceCode,
		"client_id":   ClientID,
	}, "")
	if err != nil {
		return Device{}, fmt.Errorf("could not reach the account service: %w", err)
	}
	defer res.Body.Close()
	var out struct {
		DeviceCredential string `json:"device_credential"`
		Error            string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	switch out.Error {
	case "authorization_pending":
		return Device{}, ErrAuthorizationPending
	case "slow_down":
		return Device{}, ErrSlowDown
	case "access_denied":
		return Device{}, ErrAccessDenied
	case "expired_token":
		return Device{}, ErrDeviceCodeExpired
	}
	m := devCredential.FindStringSubmatch(out.DeviceCredential)
	if res.StatusCode != 200 || m == nil {
		return Device{}, fmt.Errorf("the account service's answer held no device credential (%d)", res.StatusCode)
	}
	return Device{ID: m[1], Secret: m[2], PlaneURL: p.URL, Issuer: p.Issuer, Audience: p.Audience}, nil
}

// WaitForDevice polls at the server's interval (RFC 8628 §3.5: +5s on slow_down) until approved,
// denied, or the code expires.
func WaitForDevice(p Plane, dc DeviceCode, sleep func(time.Duration)) (Device, error) {
	interval := time.Duration(dc.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	var waited time.Duration
	limit := time.Duration(dc.ExpiresIn) * time.Second
	for limit <= 0 || waited < limit {
		sleep(interval)
		waited += interval
		d, err := PollDeviceToken(p, dc.DeviceCode)
		switch {
		case err == nil:
			return d, nil
		case errors.Is(err, ErrAuthorizationPending):
			continue
		case errors.Is(err, ErrSlowDown):
			interval += 5 * time.Second
			continue
		default:
			return Device{}, err
		}
	}
	return Device{}, ErrDeviceCodeExpired
}

// ExchangeAtPlane turns the stored device credential into a 5-minute access token for the hub.
func ExchangeAtPlane(d Device) (string, error) {
	res, err := postJSON(strings.TrimRight(d.PlaneURL, "/")+"/api/token/device", map[string]string{"audience": d.Audience}, d.ID+":"+d.Secret)
	if err != nil {
		return "", fmt.Errorf("could not reach the account service: %w", err)
	}
	defer res.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil || res.StatusCode != 200 || out.AccessToken == "" {
		return "", fmt.Errorf("the account service refused this device credential (%d)", res.StatusCode)
	}
	return out.AccessToken, nil
}
```

`device.go` — `Device` struct:

```go
type Device struct {
	ID     string `json:"id"`
	Secret string `json:"secret"`
	Hub    string `json:"hub,omitempty"`
	Name   string `json:"name,omitempty"`
	// Set when the credential was issued by the organization plane rather than the hub.
	PlaneURL string `json:"plane_url,omitempty"`
	Issuer   string `json:"issuer,omitempty"`
	Audience string `json:"audience,omitempty"`
}
```

In `Resolve`, replace `token, err := ExchangeDevice(hub, d)` with:

```go
	var token string
	if d.PlaneURL != "" {
		token, err = ExchangeAtPlane(d)
	} else {
		token, err = ExchangeDevice(hub, d)
	}
```

`apps/node-agent/cmd/agentpod-fleet/fleet_login_plane.go`:

```go
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fleetcred"
)

// fleetLoginPlane signs in through the organization plane's device flow (contract §3.2).
func fleetLoginPlane(hub string, p fleetcred.Plane) {
	dc, err := fleetcred.StartDeviceFlow(p)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("To sign in, open:\n\n  %s\n\nand confirm the code %s\n\n", dc.VerificationURIComplete, dc.UserCode)
	openBrowser(dc.VerificationURIComplete)

	d, err := fleetcred.WaitForDevice(p, dc, time.Sleep)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	d.Hub = hub
	d.Name = deviceName()
	if err := fleetcred.SaveDevice(d); err != nil {
		fmt.Fprintf(os.Stderr, "could not store the device credential: %v\n", err)
		os.Exit(1)
	}
	token, err := fleetcred.ExchangeAtPlane(d)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := fleetcred.Save(token, hub); err != nil {
		fmt.Fprintf(os.Stderr, "could not store the token: %v\n", err)
		os.Exit(1)
	}
	if c, err := fleetcred.Inspect(token); err == nil {
		fmt.Printf("Signed in as %s (%s)\n", c.Subject, c.PrincipalKind)
	}
	fmt.Printf("Device credential stored at %s\n", fleetcred.DevicePath())
}
```

`fleet_login.go` after `hub := hubBase()` (line 79):

```go
	plane, err := fleetcred.DiscoverPlane(hub)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if plane != nil {
		fleetLoginPlane(hub, *plane)
		return
	}
```

`fleet.go` `fleetLogout` — at the top of the `if d, err := fleetcred.LoadDevice(); err == nil {` block:

```go
		if d.PlaneURL != "" {
			// The plane owns this credential; the hub's revoke route is gone (410).
			fmt.Printf("Signed out on this machine. To revoke %s everywhere, remove it under Devices at %s\n", d.ID, d.PlaneURL)
		} else if err := fleetcred.RevokeDevice(hub, d); err != nil {
			// …existing message…
		}
```

(restructure the existing `if err := fleetcred.RevokeDevice(...)` into the `else if` shown.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/node-agent && go test -race ./...` — Expected: PASS (the legacy login tests still pass: `newFakeHub` serves no `/public/org-plane`, so discovery answers 404 → legacy). Revert-proof: in `Resolve`, always call `ExchangeDevice` and watch `TestResolveExchangesAPlaneDeviceAtThePlane` fail.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/fleetcred/ apps/node-agent/cmd/agentpod-fleet/
git commit -m "feat(node-agent): fleet login uses the org plane's device flow when the hub names one"
```

---

### Task 17: Drop the hub's auth and principal tables — **run only after P4 + 7 days**

> **Do not start this task until P4's cutover has been live for seven days with no rollback.** Design §8: "The hub's auth tables stay, read-only, for 7 days, then are dropped." Merging it earlier destroys the rollback (Task 13 `--reverse` needs `principal_identities` and `"user"`). Write it, review it, keep the PR in draft until the date.

What goes (contract §4: "its `principals`, `principal_identities`, `principal_grants`, `device_credentials`, `service_credentials`, `oauth_codes`, `jwks` and Better Auth tables are dropped after the rollback window"), plus the two hub-only tables that exist only to serve them: `service_signing_keys` (design §5.4 "retires the hub's plaintext `service_signing_keys`") and `organizations` (the FK target of `principals.org_id`; the plane owns organizations). What stays: `legacy_user_principals` (Task 9), `hub_operators` (Task 12), `tenants`.

Before the drop the code that reads these tables must go, or the hub fails at boot (drizzle schema imports) and in tests. That makes this the task that also deletes the legacy branches: after it, `ORG_PLANE_*` is required.

**Files:**
- Create: `apps/hub/src/db/drizzle-migrations/0095_drop_hub_auth.sql`
- Delete: `apps/hub/src/db/schema/{auth,devices,service-credentials,service-keys,oauth,grants,identities}.ts` and the `principals`/`organizations` parts of `organization.ts`; their exports from `schema/index.ts`
- Delete: `apps/hub/src/auth/{drizzle-auth,index,jwt-claims,service-signing,cookie-config.test,drizzle-schema-check.test,jwt-claims.test,service-signing.test,hub-token-middleware.test}.ts`, `apps/hub/src/auth/testdata/token_claims.v7.json`, `apps/hub/tests/unit/jwt-issuer.test.ts`
- Delete: `apps/hub/src/routes/{auth-authorize,devices,service-token,admin-grants,admin-service-principals}.ts` and their tests; `apps/hub/src/services/{principal-identities,device-credentials,service-credentials}.ts` and tests (names: whatever `grep -rln "deviceCredentials\|serviceCredentials" apps/hub/src/services` lists)
- Modify: every `if (orgPlane())` / legacy pair added in Tasks 5–15: delete the legacy arm
- Modify: `apps/hub/src/auth/org-plane/config.ts` — all five settings become required (`readOrgPlaneConfig({})` returns an error)
- Modify: `apps/hub/src/db/schema/*.ts` — remove every `.references(() => user.id, …)` (21 sites listed in the column inventory)
- Modify: `apps/hub/tests/helpers/database.ts` — `createTestUser` no longer inserts into `"user"`; it returns a `prn_` id
- Create: `apps/hub/tests/integration/hub-auth-dropped.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: a hub with no `user` table, no signing key, and `ORG_PLANE_*` mandatory.

- [ ] **Step 1: Write the failing test**

`apps/hub/tests/integration/hub-auth-dropped.test.ts`:

```ts
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { beforeAll, describe, expect, test } from "bun:test";
import { rawSql } from "../../src/db/drizzle";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { readOrgPlaneConfig } from "../../src/auth/org-plane/config";

const DROPPED = [
  "user", "session", "account", "verification", "jwks",
  "principals", "principal_identities", "principal_grants", "organizations",
  "device_credentials", "service_credentials", "service_signing_keys", "oauth_codes",
];
const KEPT = ["legacy_user_principals", "hub_operators", "tenants", "nodes", "stations"];

beforeAll(ensurePgMigrations);

describe("after the rollback window", () => {
  test("the hub's auth and principal tables are gone; the cutover's own tables remain", async () => {
    const rows = await rawSql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`;
    const tables = new Set(rows.map((r) => r.t));
    expect(DROPPED.filter((t) => tables.has(t))).toEqual([]);
    expect(KEPT.filter((t) => !tables.has(t))).toEqual([]);
  });

  test("no foreign key points at a dropped table", async () => {
    const rows = await rawSql`
      SELECT conname FROM pg_constraint WHERE contype = 'f' AND confrelid::regclass::text = ANY(${DROPPED.map((t) => `"${t}"`).concat(DROPPED)})`;
    expect(rows).toHaveLength(0);
  });

  test("the hub holds no signing key (design §9)", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(new URL("../../src/auth/", import.meta.url))).not.toContain("service-signing.ts");
  });

  test("ORG_PLANE_* is now required", () => {
    expect(readOrgPlaneConfig({}).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/hub-auth-dropped.test.ts` — Expected: FAIL (tables exist).

- [ ] **Step 3: Write the migration**

`apps/hub/src/db/drizzle-migrations/0095_drop_hub_auth.sql`:

```sql
-- After P4 + 7 days only. Idempotent: the cutover script already dropped the 18 product→user FKs.
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_admin_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "admin_audit_log" DROP CONSTRAINT IF EXISTS "admin_audit_log_target_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "agent_tasks" DROP CONSTRAINT IF EXISTS "agent_tasks_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "bridge_agents" DROP CONSTRAINT IF EXISTS "bridge_agents_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "cloudflare_sandboxes" DROP CONSTRAINT IF EXISTS "cloudflare_sandboxes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "enrollment_tokens" DROP CONSTRAINT IF EXISTS "enrollment_tokens_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "matrix_missions" DROP CONSTRAINT IF EXISTS "matrix_missions_user_id_fkey";--> statement-breakpoint
ALTER TABLE "nodes" DROP CONSTRAINT IF EXISTS "nodes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "provisioned_runtimes" DROP CONSTRAINT IF EXISTS "provisioned_runtimes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skill_artifacts" DROP CONSTRAINT IF EXISTS "skill_artifacts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skill_operations" DROP CONSTRAINT IF EXISTS "skill_operations_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "skill_release_cohorts" DROP CONSTRAINT IF EXISTS "skill_release_cohorts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "station_setups" DROP CONSTRAINT IF EXISTS "station_setups_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "station_speech" DROP CONSTRAINT IF EXISTS "station_speech_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "station_transcription" DROP CONSTRAINT IF EXISTS "station_transcription_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "stations" DROP CONSTRAINT IF EXISTS "stations_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "system_settings" DROP CONSTRAINT IF EXISTS "system_settings_updated_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "trusted_skill_releases" DROP CONSTRAINT IF EXISTS "trusted_skill_releases_user_id_user_id_fk";--> statement-breakpoint
DROP TABLE IF EXISTS "oauth_codes";--> statement-breakpoint
DROP TABLE IF EXISTS "device_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "service_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "service_signing_keys";--> statement-breakpoint
DROP TABLE IF EXISTS "principal_grants";--> statement-breakpoint
DROP TABLE IF EXISTS "principal_identities";--> statement-breakpoint
DROP TABLE IF EXISTS "principals";--> statement-breakpoint
DROP TABLE IF EXISTS "organizations";--> statement-breakpoint
DROP TABLE IF EXISTS "session";--> statement-breakpoint
DROP TABLE IF EXISTS "account";--> statement-breakpoint
DROP TABLE IF EXISTS "verification";--> statement-breakpoint
DROP TABLE IF EXISTS "jwks";--> statement-breakpoint
DROP TABLE IF EXISTS "user";
```

Before writing it, re-run the inventory query from the plan header against a freshly migrated database (as in this plan's "Hub `user.id` column inventory") — a migration added between now and then may have added an FK — and confirm `\dt` names for the Better Auth tables (`verification`, `jwks`; any admin-plugin table) with `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`. Also check for FKs **into** `principals` (`stations.principal_id`, `matrix_rooms.principal_id`, `acp_runs.agent_principal_id`, `station_setups.principal_id`): `SELECT conname, conrelid::regclass FROM pg_constraint WHERE confrelid = 'principals'::regclass` and add a `DROP CONSTRAINT IF EXISTS` line for each before `DROP TABLE "principals"` — the columns stay as plain `prn_` text.

- [ ] **Step 4: Delete the legacy code paths and fix the suite**

Delete the files listed above; remove each legacy arm; make `readOrgPlaneConfig({})` return `{ ok: false, errors: [{ field: "ORG_PLANE_ISSUER", message: "required" }, …] }`; change `tests/helpers/database.ts` `createTestUser` to return `{ id: \`prn_${hex20}\`, … }` without an insert; and run the full suite repeatedly, fixing every test that inserted into `"user"` or relied on `ON DELETE CASCADE` from it (about 81 files — `grep -rln 'delete(user)\|DELETE FROM "user"' apps/hub`): each must now delete its own rows in `afterAll`. Also set `TEST_PLANE` as the process-wide config for the hub suite in `apps/hub/bunfig.toml`'s preload (the existing preload file) via `setOrgPlaneForTests(TEST_PLANE)`.

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test && bun run typecheck` — Expected: suite PASS; typecheck no worse than `typecheck-known-red.txt` (update the baseline file only where a known-red file was deleted).

- [ ] **Step 5: Commit**

```bash
git add -A apps/hub fixtures
git commit -m "feat(hub)!: drop the hub's auth and principal tables after the rollback window; ORG_PLANE_* required"
```

---

## After the last task

- Open one PR per task (or per small group: 1–2, 3–5, 6–8, 9–12, 13, 14–15, 16, 17), each green on `contract`, `hub`, `node-agent`, `console`, `worker`. `worker` (`cloudflare/worker-v2`) is untouched by this plan and must stay green unchanged.
- P3's "done when" (design §10): "Each passes against the staging plane." Before handing to P4, run the hub with `ORG_PLANE_*` pointed at the staging plane and check, against the real deployment: a console sign-in at phone width; `fleet login` + `fleet nodes`; a station token exchange from a real node (`apn` logs show a 300 s token); a Matrix message from a linked human resolving through the plane; the plane stopped while a valid token is presented (hub still admits it).
- Release note: `apn` needs no new release for station tokens (response shape unchanged), but `fleet login` under the plane needs the Task 16 binary; tag a release before P4.

## Risks and open questions

Contract commit `cbc3098` resolved the earlier gaps (human assertion, principal reads, multi-audience agent tokens, migrated humans' ids). What remains:

1. **Gate approvals from chat need the plane up.** Contract §3.4b names this as the design's one online dependency. Task 9 refuses a decision as `identity-unavailable` when the sender cannot be resolved, and Task 10 records a failed receipt when the assertion is refused or the plane is unreachable.
2. **§5.7 is bent on Matrix inbound dispatch.** The sender's grant now lives at the plane, so a Matrix message needs a plane read for identity **and** grant (cached together, 60 s, last good). A cold cache during a plane outage is refused with an explicit message. Accepting this is a charter-level call, not a code one.
3. **Station tokens name the hub, not the node, in `act`.** The hub logs `{nodeId, stationId, principal, jti}` per exchange to keep the attribution (Task 7).
4. **`grantDispatchTo` is a read-modify-write.** Two placements by one human at the same instant can lose an append (the local version held a row lock). Low frequency; the fix is a plane-side "append to mayDispatch" operation if it ever bites.
5. **Ordering at cutover is load-bearing.** The hub must be stopped while the rewrite runs and must start under the plane only after it (Task 13 intro). A hub restarted in the wrong mode shows every operator an empty fleet. P4's runbook owns this; `docs/OPERATING.md` gets the steps in Task 13.
6. **`DEFAULT_USER_ID` / `API_TOKEN`.** The static API token keeps working under the plane (it is configuration, not an issuer) and acts as `config.defaultUserId`. Its rows are the usual "unmapped" value; P4 must map it (`--map default-user=<operator prn_>`) and set `DEFAULT_USER_ID` to the same `prn_`.
7. **Console sessions do not survive a reload without a plane session.** Tokens are memory-only by design (contract §3.1); a reload re-runs authorize, silent only if the plane's session is alive. Noted so nobody "fixes" it with localStorage.
8. **Humans' Matrix identities** (`principal_identities` with `system = 'matrix'`) move to the plane in P4's export, not here. Until they do, every human sender is "unlinked" under the plane and §3.4b answers `unknown_identity`. P4's checklist must include them.

## Self-review

**Spec coverage** (contract §4, AgentPod bullets, and the eight scope items):

| Requirement | Task |
|---|---|
| Hub verifies with `ORG_PLANE_*`, no dual-accept, unset = today | 1, 3, 4, 5 (all five verifying doors) |
| Hub mints no tokens; station exchange via `POST /api/token/agent` with the hub's `svc_` (`ORG_PLANE_SERVICE_CREDENTIAL_FILE`) | 1, 6, 7, 10 |
| Device/service/code-exchange/authorize routes and JWKS disabled under the plane | 8 |
| Gate/elicitation assertions via `POST /api/token/assertion` (contract §3.4b) | 10 |
| Agent principal creation via `POST /api/principals` | 11 (station setup), 9 (`createPrincipal` for `POST /api/admin/agents`) |
| Grants admin routes: proxied or removed, decided and justified | 12 (decision D3: removed, 410) |
| Matrix sender → `GET /api/identities/matrix/:mxid`, availability caveat | 9 |
| `user.id` FK inventory from the schema, migration that drops FKs and rewrites, rehearsable with dry run counts | header inventory (21 FK + 5 non-FK; 23 rewritten) + 13 |
| Console PKCE sign-in as `agentpod-console`, token handling, sign-out | 14, 15 |
| `fleet login` device flow → `device_credential` → `/api/token/device`, Go tests | 16 |
| Fixture `token_claims.json` → contract (tenant out, org/ent in), TS/Go round trip green | 2 |
| Cleanup after the rollback window, marked | 17 |
| Superwitness's `GET /api/evidence/principals/:id` keeps working | 9 (plane-backed, `legacy_user_principals`; no superwitness change) |
| `ent` enforcement with the exact 403 body; first-sight tenant | 4, 5 |
| Every task shippable with `ORG_PLANE_*` unset; CI green | each task's "legacy mode unchanged" case; Task 17 explicitly gated |

**Placeholder scan.** No TBD/TODO. Three places tell the implementer to reuse an existing test file's fixtures by role rather than by name (`evidence.test.ts`, `gates.test.ts`, `station-setup.test.ts`), because those files' local helper names were not all read; each names the existing case to copy from.

**Type consistency.** `OrgPlaneConfig`/`orgPlane()`/`setOrgPlaneForTests`/`TEST_PLANE` (Task 1) are used with those names in Tasks 3–17. `PlaneBearerResult`/`verifyPlaneBearer` (Task 5) match their uses in Tasks 5 and 9. `OrgPlaneClient` method names (Task 6: `agentToken`, `assertionToken(identity, audience)`, `createAgent`, `putGrant`, `linkIdentity`, `lookupIdentity`, `getPrincipal`, `listPrincipals`, `suspend`, `unsuspend`) match Tasks 7, 9, 10, 11. `PrincipalDirectory` (`principal`, `identity`, `list`, `invalidate`) matches Tasks 9 and 11. Migration numbers: 0093 `legacy_user_principals` (Task 9), 0094 `hub_operators` (Task 12), 0095 drop (Task 17) — if another PR lands a migration first, renumber with `drizzle-kit generate`, never by hand.

**Review Focus.** Each of the five lines has a named test in its owning task (Task 3 ×2, Task 4, Task 13, Task 15).
