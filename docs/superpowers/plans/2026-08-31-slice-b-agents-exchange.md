# Slice B — agents exchange, they do not hold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent obtains a short-lived suite token that names it as a principal, and either plane can revoke that ability.

**Architecture:** A node exchanges its existing `<nodeId>:<nodeSecret>` for a short-lived token scoped to one station it hosts, minted for that station's occupying principal. Nothing new is stored long-lived. kaambaan learns to resolve an agent-kind hub token to its own agent, and a suspended principal stops exchanging everywhere.

**Tech Stack:** Bun · Hono · Drizzle/Postgres (hub) · Cloudflare Workers/D1 (kaambaan) · SvelteKit (console) · `bun test` and `vitest`

**Spec:** `docs/superpowers/specs/2026-08-30-organization-plane-design.md` §3, under `charter → decisions/2026-08-30-an-agent-is-a-principal.md` Decision 4.

## Global Constraints

- **Nothing is in production.** Destinations, not migration paths. A breaking change costs a rebuild.
- **`kbn_` stays permanently.** It is kaambaan's native agent credential and a standalone kaambaan must boot with no hub. The hub token is the *federated* path, dual **by design** — not migration debt.
- **No refresh tokens, ever.** An expired agent token is re-exchanged against the credential the node already holds. `TOKEN_TTL` is 5 minutes and *"the expiry IS the revocation SLA"*.
- **Capabilities never travel in the claim.** They are kaambaan's vocabulary; the token names a principal and kaambaan looks up its own agent row. `2026-08-15-a-grant-names-an-agent-per-plane` calls the alternative "a trap".
- **An assertion must never carry authority the person's own token would not** — claims come from the same `buildTokenPayload` for every path.
- **Postgres is available.** `open -a Docker && docker start agentpod-test-postgres`, then run with `DATABASE_URL=postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod` plus `NODE_ENV=test API_TOKEN=test-token SESSION_SECRET=test-session-secret-32-chars-long ENCRYPTION_KEY='test-encryption-key-32-bytes!!!!'`. Baseline **1579 pass / 0 fail**. **Run the suite twice without resetting** — a fixture that only passes once is the defect this project just spent a day finding.
- **TDD.** Failing test first, watched fail.

## File Structure

**Create**
- `apps/hub/src/routes/station-token.ts` — the exchange endpoint.
- `apps/hub/src/routes/station-token.test.ts`

**Modify**
- `apps/hub/src/db/schema/organization.ts` — `principals.suspendedAt`
- `apps/hub/src/services/principals.ts` — suspension read/write
- `apps/hub/src/auth/jwt-claims.ts` — refuse a suspended principal
- `apps/hub/src/index.ts` — mount the route
- kaambaan `apps/api/src/auth/resolve.ts` — an agent-kind hub token resolves an agent
- kaambaan `apps/api/src/db/catalog.ts` + a route — the `revoked_at` write
- `apps/console/src/routes/admin/grants/+page.svelte` — suspend/restore

---

### Task 1: A principal can be suspended

**Files:**
- Modify: `apps/hub/src/db/schema/organization.ts`, `apps/hub/src/services/principals.ts`, `apps/hub/src/auth/jwt-claims.ts`
- Test: `apps/hub/src/services/principals.test.ts`

**Interfaces:**
- Consumes: `principals`, `principalById(id)`, `buildTokenPayload`
- Produces: `principals.suspendedAt`; `suspendPrincipal(id)`, `restorePrincipal(id)`; `principalById` returns `{ id, kind, suspendedAt }`

**Why suspension rather than deletion.** Deleting a principal cascades its identities and grants away, so it destroys the audit trail exactly when someone wants to read it. `2026-08-13` Decision 3 named revocation as one of the three costs of agents holding their own reach; this is the lever that pays it.

- [ ] **Step 1: Write the failing test**

```typescript
test("a suspended principal cannot be minted for", async () => {
  const id = await createPrincipal({ kind: "agent", handle: `t-${crypto.randomUUID().slice(0, 8)}` });
  await suspendPrincipal(id);
  // Fail closed, and for a reason a reader can act on — not the same message
  // as "no principal", which means something different.
  expect(buildTokenPayload({ principalId: id })).rejects.toThrow(/suspended/);
});

test("restoring lets it mint again", async () => {
  const id = await createPrincipal({ kind: "agent", handle: `t-${crypto.randomUUID().slice(0, 8)}` });
  await suspendPrincipal(id);
  await restorePrincipal(id);
  const payload = await buildTokenPayload({ principalId: id });
  expect(payload.sub).toBe(id);
});
```

Note the unique handles: fixtures in this repo must survive a second run against the same database.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/services/principals.test.ts`
Expected: FAIL — `suspendPrincipal` is not exported.

- [ ] **Step 3: Add the column**

```typescript
/**
 * When this principal stopped being allowed to act, if it has.
 *
 * A timestamp rather than a boolean: "since when" is the first question asked
 * of a suspension, and a boolean cannot answer it. NULL is the normal state.
 */
suspendedAt: timestamp("suspended_at"),
```

Run `bun run db:generate`. **Read the emitted SQL before committing it** — this repo's snapshot has drifted before, and a generated migration once dropped foreign keys by names that did not exist.

- [ ] **Step 4: Implement**

```typescript
export async function suspendPrincipal(id: string): Promise<void> {
  await db.update(principals).set({ suspendedAt: new Date() }).where(eq(principals.id, id));
}

export async function restorePrincipal(id: string): Promise<void> {
  await db.update(principals).set({ suspendedAt: null }).where(eq(principals.id, id));
}
```

`principalById` returns `suspendedAt` alongside `id` and `kind`, and `buildTokenPayload` throws when it is set — on **both** subject paths, the session one and the principal one.

- [ ] **Step 5: Run the tests, then run them again without resetting the database**
- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/db/schema/organization.ts apps/hub/src/services/principals.ts apps/hub/src/auth/jwt-claims.ts apps/hub/src/services/principals.test.ts apps/hub/src/db/drizzle-migrations/
git commit -m "feat(hub): a principal can be suspended, and a suspended one mints nothing

Deleting a principal cascades its identities and grants away, destroying the
audit trail exactly when someone wants to read it. A timestamp rather than a
boolean, because 'since when' is the first question anyone asks."
```

---

### Task 2: A node exchanges for one of its stations

**Files:**
- Create: `apps/hub/src/routes/station-token.ts`, `apps/hub/src/routes/station-token.test.ts`
- Modify: `apps/hub/src/index.ts`

**Interfaces:**
- Consumes: `verifyNodeCredential(nodeId, nodeSecret)`, `stations.principalId`, `buildTokenPayload({ principalId })`, `principals.suspendedAt`
- Produces: `POST /api/nodes/:nodeId/stations/:stationId/token` → `{ token, expiresIn }`

**The credential, decided by the operator.** A station holds no secret of its own. The node already holds `<nodeId>:<nodeSecret>` and already proves which stations it hosts, so it exchanges on a station's behalf. Follow the scheme at `apps/hub/src/routes/nodes.ts:249-258` exactly rather than inventing a second one.

**Every refusal here fails closed:** a bad node credential, a station that belongs to a different node, a station with no occupying principal, and a suspended principal. The third is not an error condition — it is the ordinary state of an unassigned station, and it must say so distinctly.

- [ ] **Step 1: Write the failing test**

```typescript
test("mints for the station's occupant, naming the principal and its kind", async () => {
  const res = await app.request(`/api/nodes/${nodeId}/stations/${stationId}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  });
  expect(res.status).toBe(200);
  const claims = decodeJwt((await res.json()).token);
  expect(claims.sub).toBe(agentPrincipalId);
  expect(claims.principalKind).toBe("agent");
});

test("refuses a station hosted by a different node", async () => {
  // The node proves who it is, not what it may reach. Without this check any
  // node could mint for any agent in the fleet.
  const res = await app.request(`/api/nodes/${nodeId}/stations/${otherNodesStation}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  });
  expect(res.status).toBe(403);
});

test("refuses a station with no occupying principal, distinctly", async () => {
  const res = await app.request(`/api/nodes/${nodeId}/stations/${unoccupied}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  });
  expect(res.status).toBe(409);
});

test("refuses a suspended principal", async () => {
  await suspendPrincipal(agentPrincipalId);
  const res = await app.request(`/api/nodes/${nodeId}/stations/${stationId}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
  });
  expect(res.status).toBe(403);
});

test("refuses a wrong node secret", async () => {
  const res = await app.request(`/api/nodes/${nodeId}/stations/${stationId}/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nodeId}:wrong` },
  });
  expect(res.status).toBe(401);
});
```

**Test harness:** these are Hono route tests — build a `new Hono()` and drive it with
`app.request(path, init)`, following `apps/hub/src/routes/kaambaan-push.test.ts:55,62`.
`decodeJwt` from `jose` reads the minted claims, as `src/auth/service-signing.test.ts` does.

- [ ] **Step 2: Run it and watch it fail** — route not mounted, 404.
- [ ] **Step 3: Implement the route**, mounted under `/api` (Bearer passes the CSRF middleware, so unlike the HMAC-signed `kaambaan-push` receiver this does not need `/public`). Sign with the same `buildTokenPayload` a human's token uses, so an agent can never carry authority its grant does not give.
- [ ] **Step 4: Run the tests, then run them again without resetting**
- [ ] **Step 5: Commit**

---

### Task 3: kaambaan resolves an agent-kind hub token

**Files:**
- Modify: kaambaan `apps/api/src/auth/resolve.ts`
- Test: kaambaan `apps/api/test/hub-token-agent.test.ts`

**Interfaces:**
- Consumes: `verifyHubToken` (already reads `principalKind`, `hub-jwt.ts:179`), `findAgentByExternal(db, 'org-plane', sub)` (built in slice A)
- Produces: `resolveHubAgent(request, env): Promise<AgentPrincipal | null>`

**This is the hot path.** Every claim goes through it. A `kbn_` token must keep working unchanged — it is kaambaan's native credential and a standalone board depends on it.

- [ ] **Step 1: Write the failing test** — an agent-kind hub token whose `sub` maps to a local agent resolves to that agent with its own capabilities; one whose `sub` maps to nothing is refused; a human-kind token does **not** resolve as an agent; a `kbn_` token is unaffected.
- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement.** Capabilities come from the local `agents` row, never from the claim.
- [ ] **Step 4: Run `pnpm vitest run && pnpm typecheck`** — baseline 398 pass / 0 fail, and this repo needs no database, so anything red is real.
- [ ] **Step 5: Commit**

---

### Task 4: Revoking a kaambaan agent token

**Files:**
- Modify: kaambaan `apps/api/src/db/catalog.ts`, and the agents route
- Test: kaambaan `apps/api/test/agent-token-revocation.test.ts`

**The read side is already live** — `findAgentByTokenHash` filters `WHERE at.revoked_at IS NULL` on every agent request (`catalog.ts:152`). Only the write is missing, so this is an endpoint, not a system. `2026-08-13` Decision 3 says kaambaan is "weakest exactly here".

- [ ] **Step 1: Write the failing test** — revoking a token makes the next request with it fail; another token for the same agent still works; revoking twice is not an error.
- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement `revokeAgentToken` and its route**, authorised as a human act.
- [ ] **Step 4: Run the suite and typecheck**
- [ ] **Step 5: Commit**

---

### Task 5: Suspend and restore from the console

**Files:**
- Modify: `apps/console/src/routes/admin/grants/+page.svelte`, `apps/console/src/lib/api/grants.ts`, `apps/hub/src/routes/admin-grants.ts`
- Test: `apps/hub/src/routes/admin-grants-route.test.ts`

The principals directory added in slice A already lists `{id, kind, handle, displayName}`. Add `suspendedAt` to it, show the state, and offer suspend/restore — guarded by `adminMiddleware` like the rest of `/api/admin/*`.

- [ ] **Step 1: Write the failing route test** — a non-admin cannot suspend; an admin can; the directory reports the state.
- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement the endpoint and the console control.** Keep it small — a state and two buttons, not a new page.
- [ ] **Step 4: Run the hub suite twice, plus `svelte-check`**
- [ ] **Step 5: Commit**

---

## Verification before slice B is called done

- [ ] Hub: **1579+ pass / 0 fail**, run **twice without resetting the database**
- [ ] kaambaan: `pnpm vitest run && pnpm typecheck` green
- [ ] Console: `svelte-check` 0 errors
- [ ] **The exit test:** a node exchanges for one of its stations, kaambaan accepts the resulting token as that agent and applies the agent's own capabilities, and suspending the principal makes the next exchange fail — proving revocation reaches across the plane boundary, which is what `2026-08-13` Decision 3 said agents holding their own reach would cost.
