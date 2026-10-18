# Forge API Access — Hub, Contract, Sealing and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can grant, verify, rotate and revoke repository-restricted forge API access for a station from the `fleet` CLI, with the hub minting and sealing tokens it never stores, and reassignment revoking access.

**Architecture:** New verbs and a `forge.api` capability in the contract; a `station_forge_api_grants` table and a service that owns the lifecycle state machine behind an injectable provider adapter (Forgejo first, GitHub App and supplied modes next) and an injectable broker; routes gated by the existing reach check plus admin; occupancy and deletion hooks that revoke; sealing in TypeScript (hub) and Go (CLI) against stk's frozen conformance vector. The node side is a separate plan.

**Tech Stack:** Bun + Hono + Drizzle/Postgres (hub), zod (contract), Go (fleet CLI), `libsodium-wrappers` (TS sealing), `golang.org/x/crypto/nacl/box` (Go sealing).

**Spec:** `docs/superpowers/specs/2026-10-17-forge-api-access-design.md`. stk side: supertoolkit `docs/forge-broker-design.md` and `docs/handover-v1.md` (envelope frozen). Companion plan: `docs/superpowers/plans/2026-10-17-forge-api-access-node.md`.

## Global Constraints

- A token is never stored, logged, returned by an API, put in an audit row, a node frame, an error message or a transcript. It exists in hub memory only between `mint` and `seal`, inside one function.
- Tenant isolation: the new table is in `TENANT_SCOPED_TABLES`; every query is tenant-scoped.
- The forge account is derived from the station's occupying principal (`principalHandle(station.principalId)`), never from a request body or a node.
- Operator actions require `requireIssueCredentials` AND the admin check. Do not copy `station-git-identity.ts`'s ownership-only authorisation.
- Frames carry ids, mode, repositories, preset/rules and sealed blobs, never plaintext. A node without the `forge.api` capability gets a clean error; success needs a positive acknowledgement.
- SSH and API grants stay independent: no change to `station_git_identities`.
- Hub tests need pgvector Postgres on :5434 and an explicit `DATABASE_URL` (see `TESTING.md`); tests for routes build a minimal Hono app and never import `src/index.ts`; no sleeps (`pollUntil` in `tests/helpers/wait.ts`). Hub typecheck is known-red (`typecheck-known-red.txt`): do not widen it.
- TDD: failing test first; every guard gets a revert-proof check. Contract changes land first.
- Branch trunk-based off `main`; check PR state (`gh pr list`/`tea pr list`) before every push; commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A minted token cannot leak: assert against the real token string in hub logs, `station_audit` rows, `acp_events`, HTTP responses, thrown error messages and the sealed row (only ciphertext), including on every failure path (mint ok then seal fails, deliver fails, verify fails).
2. Mint succeeded, delivery failed: the token handle is persisted before delivery is attempted, so reconcile can retry or revoke; a retry never mints a second token for the same generation.
3. Reassignment/unassign/evict/delete/un-adopt never block on the forge, always leave the grant in `revoking` (not lost, not cascade-deleted), and the retry job eventually revokes at the provider.
4. Authority: a station owner who is not an admin, an admin without reach, an agent token, and a node credential each get 403 on grant/rotate/revoke; the account cannot be redirected by a body field.
5. Version skew: a node that does not advertise `forge.api`, or that answers with an unknown-verb error or an empty ack, leaves the grant `provisioned`/`failed` with a clear reason, never `delivered`.
6. Sealing is interoperable: the TS and Go sealers open with stk's vector keypair via the Go reference, and the TS/Go open of stk's recorded envelope matches the recorded material.

---

### Task 1: Contract verbs and capability

**Files:**
- Modify: `packages/contract/src/protocol.ts` (verb params near the `git.identity.*` entries, `VERB_RESULTS` near its git-identity results, the capability list), `packages/contract/tests/*`
- Create: `packages/contract/src/forge-api.ts`

**Interfaces:**
- Produces:
  - `ForgeApiMode = z.enum(["minted","app","supplied"])`, `ForgeApiProvider = z.enum(["forgejo","gitea","github","bitbucket"])`, `ForgeApiPreset = z.enum(["read","issues","pull-requests","maintain","none"])`.
  - `ForgeApiRule = z.object({ allow: z.string().optional(), deny: z.string().optional(), when: z.record(z.unknown()).optional() })`.
  - Verbs: `forge.api.deliver {stationId, stationKey, grantId, provider, instance (base URL), mode, serviceName, repositories: string[], preset, rules: ForgeApiRule[], allowGraphql: boolean, sealed: string, expectLogin: string}`; `forge.api.policy {stationId, grantId, preset, rules, allowGraphql}`; `forge.api.verify {stationId, grantId, expectLogin}`; `forge.api.revoke {stationId, grantId}`; `forge.api.status {stationId}`.
  - Results: deliver → `{ok: boolean, isolation: "separate-user"|"same-user", stored: boolean}`; verify → `{ok: boolean, login?: string, reason?: string, isolation: ...}`; revoke → `{removed: boolean}`; policy → `{ok: boolean, error?: string}`; status → `{grants: {grantId, present: boolean, isolation}[]}`.
  - Capability `forge.api` added to the capability enum (and to whatever exhaustive record the hub checks, e.g. `REACH_BEARING` in `services/grant-reach.ts`: it is reach-bearing).
- Consumes: nothing.

- [ ] **Step 1: Write failing tests**: `forge-api verbs parse a full deliver frame`, `deliver rejects a frame carrying a field named token or secret or password` (strict schemas), `sealed must start with stk-handover-v1:`, `unknown capability is not silently dropped` (the existing `reportUnknownCapabilities` path), `VERB_RESULTS has an entry for every forge.api verb`.
- [ ] **Step 2:** `cd packages/contract && bun test` — expect FAIL.
- [ ] **Step 3: Implement** the schemas strict (`.strict()`), the verbs, results and the capability.
- [ ] **Step 4:** `bun test` in `packages/contract`, then `cd apps/hub && DATABASE_URL=… bun test tests/unit` for anything exhaustive over capabilities — expect PASS.
- [ ] **Step 5: Commit** `feat(contract): forge.api verbs and capability`.

### Task 2: Schema, migration, tenant scope

**Files:**
- Create: `apps/hub/src/db/schema/forge-api-grants.ts`, `apps/hub/src/db/drizzle-migrations/0100_station_forge_api_grants.sql` (+ meta snapshot via `drizzle-kit generate`), `apps/hub/tests/integration/forge-api-grants-schema.test.ts`
- Modify: `apps/hub/src/db/schema/index.ts`, `apps/hub/src/db/tenant-scope.ts` (`TENANT_SCOPED_TABLES`)

**Interfaces:**
- Produces `stationForgeApiGrants` with columns: `id` (text pk), `tenantId` (fk tenants, restrict), `stationId` (text, NOT a cascading FK: `references(stations.id)` with `onDelete: "restrict"` plus `stationIdSnapshot` text so a tombstone survives), `provider`, `instance`, `mode`, `principalId`, `account`, `expectedLogin`, `repositories` (jsonb string[]), `preset`, `rules` (jsonb), `allowGraphql` (bool), `state` (text: `authorised|provisioned|delivered|verified|failed|revoking|revoked`), `stateReason`, `tokenHandle` (jsonb `{id?:number,name:string}` nullable), `generation` (int), `isolation` (text nullable), `sealedBlob` (text nullable), `sealedExpiresAt` (timestamptz nullable), `createdBy`, `createdAt`, `deliveredAt`, `verifiedAt`, `revokedAt`, `updatedAt`. Unique partial index on (`stationId`,`provider`,`instance`) where `state <> 'revoked'`. Index on (`state`,`updatedAt`) for the reconcile sweep.
- A separate counter so `generation` never resets across re-grants: `generation` of a new grant starts at `max(generation)+1` over all rows (including tombstones) for (`stationIdSnapshot`,`provider`,`instance`).

- [ ] **Step 1: Write failing integration tests**: `rejects a second live grant for the same station/provider/instance`, `allows a new grant after the previous is revoked`, `deleting a station with a live grant is refused by the FK (restrict)`, `a revoked tombstone survives`, `tenant scope lists the table`, `generation continues across re-grants`.
- [ ] **Step 2:** run against Postgres :5434 — expect FAIL.
- [ ] **Step 3: Implement** schema, migration, index export and tenant-scope entry. Generate the migration with the repo's drizzle workflow and commit the snapshot.
- [ ] **Step 4:** run the new test and the existing tenant-scope tests — expect PASS.
- [ ] **Step 5: Commit** `feat(hub): station_forge_api_grants table`.

### Task 3: Sealing (TypeScript and Go) against the vector

**Files:**
- Create: `apps/hub/src/services/handover-seal.ts`, `apps/hub/tests/unit/handover-seal.test.ts`, `packages/contract/fixtures/handover-v1.json` (verbatim copy of supertoolkit `testdata/handover-v1.json`), `apps/node-agent/internal/handoverseal/seal.go`, `apps/node-agent/internal/handoverseal/seal_test.go`
- Modify: `apps/hub/package.json` (add `libsodium-wrappers` pinned), `apps/node-agent/go.mod` (x/crypto already present — confirm)

**Interfaces:**
- Produces: TS `sealHandover(publicKey: string, material: Record<string,string>): Promise<string>` returning `stk-handover-v1:<base64url-nopad sealed box>`; `parseHandoverPublicKey(s: string): Uint8Array` (32 bytes, throws on bad prefix/size). Go `handoverseal.Seal(publicKey string, material map[string]string) (string, error)` and `ParsePublicKey`.
- Consumes: the vector fixture; for opening in tests, the vector's private key.

- [ ] **Step 1: Write failing tests** in both languages: `seals material that the vector private key opens` (open with the vector key in-test using libsodium / `box.OpenAnonymous`), `two seals of the same material differ`, `the envelope contains no plaintext`, `rejects a key without the stk-handover-v1 prefix`, `rejects wrong length`, `rejects empty material`, `opens the recorded vector envelope to the recorded material` (verifies the reference envelope is openable by the test opener, proving the opener and the format agree).
- [ ] **Step 2:** `bun test apps/hub/tests/unit/handover-seal.test.ts` and `go test ./internal/handoverseal` — expect FAIL.
- [ ] **Step 3: Implement** using `crypto_box_seal` / `box.SealAnonymous`. No logging of inputs.
- [ ] **Step 4:** run both — expect PASS.
- [ ] **Step 5: Commit** `feat: seal credentials to a station's stk key (hub and CLI)`.

### Task 4: Provider adapters (Forgejo; GitHub App/supplied bookkeeping)

**Files:**
- Create: `apps/hub/src/services/forge-api/providers.ts`, `forgejo.ts`, `github.ts`, tests under `apps/hub/src/services/forge-api/*.test.ts`
- Modify: `apps/hub/src/services/forge.ts` (`mintAgentToken` takes `scopes`, requires non-empty `repositories`, returns `{id, name, secret}`; `revokeAgentToken` unchanged behaviour)

**Interfaces:**
- Produces: `interface ForgeProvider { kind; modes; mint?(account, spec: {name, scopes, repositories: {owner,name}[]}): Promise<{id:number; name:string; secret:string}>; revoke?(account, handle: {id?:number; name:string}): Promise<void>; expectedIdentity(grant): string; scopesFor(preset): string[] }`; `getProvider(kind)`. Forgejo: scopes per preset `read→["read:repository"]`, `issues→["read:repository","write:issue"]`, `pull-requests→["read:repository","write:issue","write:repository"]`, `maintain→["write:repository","write:issue"]`; `none` is refused for minted mode (a minted token needs a preset's scopes); token name `agentpod-<grantId>-g<generation>`. GitHub: modes `["app","supplied"]`, no `mint`, `expectedIdentity` = `${appSlug}[bot]` (app) or the declared login (supplied).
- Consumes: Task 2 row type.

- [ ] **Step 1: Write failing tests** with a fetch stub: `forgejo mint sends scopes and repositories as {owner,name} objects and returns the sha1 as secret`, `mint without repositories throws before any request`, `mint error messages never include a response body or the token`, `scopesFor each preset`, `revoke treats 404 as success`, `github has no mint`, `token name is unique per generation`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.** Keep `forge.test.ts` green.
- [ ] **Step 4:** `bun test src/services` in `apps/hub` — expect PASS.
- [ ] **Step 5: Commit** `feat(hub): forge provider adapters`.

### Task 5: Lifecycle service — grant, mint, seal, deliver (minted mode)

**Files:**
- Create: `apps/hub/src/services/station-forge-api.ts`, `apps/hub/tests/integration/station-forge-api.test.ts`

**Interfaces:**
- Produces: `createForgeApiGrant(deps, input: {tenantId, stationId, actor, provider, instance, mode, repositories, preset, rules, allowGraphql, expectedLogin?}): Promise<Grant>` and `deliverGrant(deps, grantId)`; `deps = {db, broker, providers, now, stationPublicKey(stationId): Promise<string>}`. Flow for minted: insert `authorised` (account from the occupant; 409 `no-occupant` otherwise) → mint → persist `tokenHandle`, state `provisioned` in one update → seal with the station's stk key → store `sealedBlob` + 24 h expiry → `broker.request(nodeId, "forge.api.deliver", …)` → on ack `delivered`, clear blob. Any failure leaves the row in a defined state with a reason that contains no secret.
- Consumes: Tasks 1–4.

- [ ] **Step 1: Write failing integration tests** (stub broker/provider): `happy path ends delivered with no blob and no token anywhere`, `account comes from the occupant even if the input names another`, `no occupant → refused before any mint`, `mint ok then seal fails → provisioned with handle persisted, reason has no secret`, `deliver fails (node offline) → provisioned, blob kept, retry delivers without minting again`, `node answers unknown verb → failed with reason, not delivered`, `a second grant request for the same generation reuses the token handle instead of minting`, `a thrown error never contains the secret` (spy on every log/audit/db write).
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.** The secret lives in a local variable between `mint` and `seal` only.
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(hub): grant, mint, seal and deliver forge API access`.

### Task 6: Verify, rotate, revoke, supplied and app modes

**Files:**
- Modify: `apps/hub/src/services/station-forge-api.ts`, integration tests

**Interfaces:**
- Produces: `verifyGrant(deps, grantId)` (sends `forge.api.verify` with `expectLogin`; `verified` on ok, else `failed` with the node's reason), `rotateGrant(deps, grantId)` (minted: mint generation n+1, deliver, verify, THEN revoke n; verification failure leaves n live and reports `rotation-failed`), `revokeGrant(deps, grantId)` (state `revoking`; provider revoke first for minted; app: nothing; supplied: state note `revocation-pending-operator`; then `forge.api.revoke` best effort; `revoked` only after the provider step succeeded or is not applicable), `acceptSuppliedSecret(deps, grantId, sealed: string)` (operator-sealed blob relayed to the node without the hub opening it), `registerAppGrant` (app mode: stores ids, relays the sealed App key).
- Consumes: Task 5.

- [ ] **Step 1: Write failing tests**: `verify moves delivered→verified and records the login`, `wrong login → failed wrong-identity`, `rotation keeps the old token live when verification fails`, `rotation revokes the old generation only after the new verifies`, `revoke with node offline still revokes at the provider and leaves the wipe queued`, `revoke when the provider is down stays revoking and is retried (not lost)`, `supplied revoke reports revocation-pending-operator`, `the hub never opens a supplied blob` (pass a blob that cannot be decrypted and assert it is relayed byte-identical).
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(hub): verify, rotate and revoke forge API grants`.

### Task 7: Routes, authority and audit

**Files:**
- Create: `apps/hub/src/routes/station-forge-api.ts`, `apps/hub/tests/integration/station-forge-api-routes.test.ts`
- Modify: `apps/hub/src/index.ts` (mount under `authMiddleware`), `apps/hub/src/services/audit.ts` (`SAFE_PARAM_KEYS` add `provider`, `mode`, `preset`, `generation`, `username`, `grantId`; record the actor), `apps/hub/src/services/redact-content.ts` (40-hex unprefixed token shape rule)

**Interfaces:**
- Produces: `GET /api/stations/:id/forge-api`, `POST /api/stations/:id/forge-api`, `POST …/forge-api/:grantId/{verify,rotate,secret}`, `PATCH …/forge-api/:grantId/policy`, `DELETE …/forge-api/:grantId`. Every mutating route requires `requireIssueCredentials` and `isUserAdmin`; responses never contain `tokenHandle.name` secrets, `sealedBlob`, or any token; `GET` returns state, mode, account, expectedLogin, repositories, preset, isolation, timestamps, reason. `recordAudit` before each mutation with the actor.
- Consumes: Tasks 5–6.

- [ ] **Step 1: Write failing tests** (Review Focus 4): owner non-admin 403; admin without reach 403 when `ENFORCE_CONTROL_PAIR=true`; node credential 403; body field `account` ignored; `GET` response contains no `sealedBlob`/token fields (recursive key scan); 503 when forge not configured; 409 no occupant; audit row has actor and no secret; redaction rule masks a 40-hex token in transcript read.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(hub): forge API access routes with operator authority`.

### Task 8: Reassignment, deletion and reconcile

**Files:**
- Modify: `apps/hub/src/routes/agents-admin.ts` (assign/move/evict/unassign near lines 142–314 on `main`; builder confirms), the station delete / un-adopt services (`services/station-registry.ts` and the node-removal path), `apps/hub/src/index.ts` (`connectionManager.onNodeOnline` reconcile registration)
- Create: `apps/hub/src/services/forge-api-reconcile.ts`, `apps/hub/tests/integration/forge-api-reassign.test.ts`

**Interfaces:**
- Produces: `markGrantsRevoking(tx, stationId): Promise<string[]>` called inside the occupancy transaction; `runForgeApiReconcile(deps): Promise<ReconcileReport>` (retry `provisioned`/`failed`/`revoking`, expire sealed blobs older than 24 h by revoking and re-minting generation+1, find orphans by listing tokens named `agentpod-*` for the account and comparing with rows); scheduled every 5 minutes and on `onNodeOnline`; orphans and repeated failures go to the audit log and the operator digest, not a page.
- Consumes: Tasks 5–7.

- [ ] **Step 1: Write failing tests** (Review Focus 3): `unassign marks grants revoking in the same transaction and never calls the forge inline`, `forge down during reassignment does not block it`, `reconcile revokes at the provider and then wipes on node reconnect`, `deleting a station with a live grant is refused until revoked, or tombstones the grant`, `un-adopting a node revokes every grant on it`, `expired sealed blob → revoke + re-mint generation+1`, `orphan token found by name prefix is reported`, `new occupant gets no grant`.
- [ ] **Step 2:** run — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** run — expect PASS.
- [ ] **Step 5: Commit** `feat(hub): revoke forge API access on reassignment, deletion and reconnect`.

### Task 9: `fleet` CLI, reference, skill and docs

**Files:**
- Modify: `apps/node-agent/cmd/agentpod-fleet/stations.go` (`forge-api` verbs beside `git-identity|grant-push|revoke-push`), `reference.go`, `skill/SKILL.md`, `docs-site/src/content/docs/use/stations.md`, `use/cli.md`, `reference/fleet.md` (regenerated), `docs/OPERATING.md`; tests in `stations_test.go`

**Interfaces:**
- Produces: `fleet stations forge-api list <station>`, `grant <station> --provider forgejo --repo owner/name … --preset issues [--rule 'allow: POST /…']… [--mode minted|app|supplied] [--token-stdin]`, `verify|rotate|revoke <station> <grantId>`, `policy <station> <grantId> --preset … --rule …`. For `--mode supplied`/`app`, the CLI fetches the station's stk public key from `GET …/forge-api` metadata, seals with `handoverseal.Seal`, and POSTs only the envelope (token read from stdin, never a flag). Output never contains a token.
- Consumes: Task 3 Go sealer, Task 7 routes.

- [ ] **Step 1: Write failing tests**: `--token-stdin reads from stdin and the request body contains only an envelope`, `a --token flag does not exist`, `list prints state, mode, account, isolation and no secret`, `grant without --repo is refused client-side`, `help text and reference.go agree` (the repo's docs-claims pattern).
- [ ] **Step 2:** `go test ./cmd/agentpod-fleet` — expect FAIL.
- [ ] **Step 3: Implement** and update the docs listed, including the limits section from the spec.
- [ ] **Step 4:** `cd apps/node-agent && go test -race ./...`; `bun test` for docs-claims — expect PASS.
- [ ] **Step 5: Commit** `feat(fleet): forge API access verbs and docs`.

---

**Not in this plan:** the node handler and setup (companion plan), the console section (needs mockups first), Gitea and Bitbucket adapters, and the four SSH-grant defects (file as separate issues). Live acceptance with Super Chotu is the last task of the node plan.
