# Slice C — creating an agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can create an agent and put it on a station without running SQL, and can move it later without it losing its name or its conversation.

**Architecture:** Adoption keeps leaving `stations.principal_id` null; the console makes that visible and offers one click to fix it. Reassignment moves the agent's *room* with it, which finally gives `matrix_rooms.principal_id` the writer slice A left it without. kaambaan gains the mapping field and the revoke button its own endpoint has been waiting for.

**Tech Stack:** Bun · Hono · Drizzle/Postgres (hub) · SvelteKit (console, kaambaan web) · Cloudflare Workers/D1 (kaambaan) · `bun test` and `vitest`

**Spec:** `docs/superpowers/specs/2026-08-31-creating-an-agent-design.md`

## Global Constraints

- **Postgres is available and every suite runs TWICE without resetting.** `open -a Docker && docker start agentpod-test-postgres`, then `NODE_ENV=test DATABASE_URL='postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod' API_TOKEN=test-token SESSION_SECRET=test-session-secret-32-chars-long ENCRYPTION_KEY='test-encryption-key-32-bytes!!!!' bun test`. A fixture that passes once and fails on a re-run is the defect this project lost a day to. Report both counts, always.
- **Read the SQL `bun run db:generate` emits before committing it.** A generated migration on this branch already dropped foreign keys by names that did not exist; the hub could not have started.
- **A handle is immutable.** An agent's Matrix address derives from it. Changing one silently renames a person.
- **`stations.principal_id` stays nullable and `matrix_rooms.station_id` stays.** The production reconciliation sweep joins on the latter (slice A, Ruling 4).
- **Every new endpoint sits behind `authMiddleware` then `adminMiddleware`.** No exemptions carved.
- Nothing is in production: destinations, not migration paths.
- TDD: failing test first, watched fail.

## File Structure

**Create** — `apps/hub/src/routes/agents-admin.ts` (+ test); `apps/console/src/routes/agents/AgentCreate.svelte`
**Modify** — `apps/hub/src/services/principals.ts`, `db/schema/matrix.ts`, `services/matrix-as/gates.ts`, `routes/admin.ts`; `apps/console/src/routes/agents/+page.svelte`, `lib/api/*`; kaambaan `apps/api/src/db/catalog.ts`, `src/index.ts`, `apps/web/src/lib/api.ts`, `lib/components/BoardScreen.svelte`

---

### Task 1: Rotate a signing key (spike)

**Files:** Create `docs/superpowers/specs/2026-08-31-key-rotation-spike-findings.md`

**This is a spike: the output is an answer, not code you keep.** Anything built is throwaway and must be labelled so.

Verification is offline, so *"the expiry IS the revocation SLA"* and a key that cannot rotate cleanly is the only revocation lever the suite has, failing silently. `servicePublicJwks()` already publishes retired keys deliberately (`service-signing.ts`) — check the `jwt` plugin's `jwks` table behaves the same way.

- [ ] **Step 1:** Against the local Postgres, mint a token and record its `kid`.
- [ ] **Step 2:** Rotate the signing key.
- [ ] **Step 3:** Confirm the **old token still verifies** until it expires — retiring a key must not invalidate tokens already issued. `agentpod#331` established that offline verification means no consumer asks the issuer anything.
- [ ] **Step 4:** Confirm the new key appears in JWKS, that a newly minted token carries the new `kid`, and that kaambaan's verifier accepts it (`apps/api/src/auth/hub-jwt.ts` caches JWKS for 10 minutes — say what that means for rotation timing).
- [ ] **Step 5:** Confirm nothing signs with the retired key afterwards.
- [ ] **Step 6:** Write findings — what worked, what did not, and what it means for extraction. Commit the findings only.

---

### Task 2: Create and assign an agent — the hub

**Files:** Create `apps/hub/src/routes/agents-admin.ts`, `agents-admin.test.ts`; modify `apps/hub/src/services/principals.ts`, `routes/admin.ts`

**Interfaces:**
- Consumes: `createPrincipal`, `principalById`, `suspendPrincipal`, `stations`, `principals`
- Produces: `POST /api/admin/agents` `{handle, displayName?}` → the created principal; `PUT /api/admin/stations/:stationId/agent` `{principalId}` → assigns; `DELETE` the same → unassigns

- [ ] **Step 1: Write the failing tests**

```typescript
test("creates an agent principal with the handle given", async () => {
  const res = await app.request("/api/admin/agents", {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ handle: `writer-${unique}`, displayName: "Writer Quill" }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).id).toMatch(/^prn_[0-9a-f]{20}$/);
});

test("refuses a handle already taken", async () => {
  // A handle becomes an mxid localpart. Two claimants make the address ambiguous,
  // which is why principals_org_handle_idx exists — surface it as a 409, not a 500.
  await createPrincipal({ kind: "agent", handle: taken });
  const res = await app.request("/api/admin/agents", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ handle: taken }),
  });
  expect(res.status).toBe(409);
});

test("refuses a handle that cannot be an mxid localpart", async () => {
  const res = await app.request("/api/admin/agents", {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ handle: "Writer Quill!" }),
  });
  expect(res.status).toBe(400);
});

test("assigning makes the station dispatchable, unassigning makes it nobody's", async () => {
  await app.request(`/api/admin/stations/${stationId}/agent`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ principalId }),
  });
  expect((await stationRow(stationId)).principalId).toBe(principalId);
  await app.request(`/api/admin/stations/${stationId}/agent`, { method: "DELETE", headers: adminHeaders });
  expect((await stationRow(stationId)).principalId).toBeNull();
});

test("a non-admin can do none of it", async () => {
  for (const req of [createReq, assignReq, unassignReq]) {
    expect((await app.request(req.path, { ...req, headers: userHeaders })).status).toBe(403);
  }
});
```

- [ ] **Step 2: Run them and watch them fail** — routes not mounted, 404.
- [ ] **Step 3: Implement.** Validate the handle against the same character class `clean()` in `matrix-as/names.ts` uses, so a handle that would be silently mangled into an mxid is refused up front instead. Assigning a suspended principal is refused.
- [ ] **Step 4: Run the suite twice, no reset. Report both.**
- [ ] **Step 5: Commit**

---

### Task 3: The console — create, assign, and show what is unassigned

**Files:** Modify `apps/console/src/routes/agents/+page.svelte`, `apps/console/src/lib/api/*`; create `AgentCreate.svelte` + tests

**Interfaces:** Consumes Task 2's three endpoints.

**The point of this task is the visibility, not the form.** A station with no principal is dispatchable by nobody, and today that is invisible — `gate-sweep.ts` counts only `sent`, so a fleet-wide refusal produces no error line and the console shows healthy stations. That invisibility is why the deploy runbook needs remembered manual steps.

- [ ] **Step 1: Write the failing component tests** — an unassigned station renders as unassigned and not merely healthy; the create action pre-fills the handle from the station key; a taken handle surfaces the 409 as a readable message rather than a generic failure.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** Follow the empty-state lesson from slice A's final review: a bare "0 of 0" with no explanation is a finding. Say what an empty or unassigned state means.
- [ ] **Step 4:** `pnpm svelte-check` (0 errors) and the console vitest — the console has **132 pre-existing failures** unrelated to this work; confirm that number is unchanged rather than treating it as new.
- [ ] **Step 5: Commit**

---

### Task 4: kaambaan — link a principal, and revoke a token

**Files:** Modify kaambaan `apps/api/src/db/catalog.ts`, `src/index.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/components/BoardScreen.svelte`; tests alongside

**Interfaces:**
- Consumes: `setAgentExternalMapping` (exists, no caller), `revokeAgentToken` (exists, no button)
- Produces: a route to set the mapping; UI for both

**`revokeAgentToken` shipped in slice B and no human can reach it.** The spec asked for *"an endpoint and a console button"*; only the endpoint was built. `decisions/2026-08-13-ecosystem-identity.md` Decision 3 names this lever as kaambaan's specific weakness.

- [ ] **Step 1: Write the failing tests** — setting the mapping makes `resolveHubAgent` resolve that agent (prove through the resolver, not by reading the column); revoking through the UI's path makes the **next request** with that token fail; a non-human credential can do neither.
- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement**, on the agent list already in `BoardScreen.svelte`. Revoking is destructive and irreversible — give it a confirmation.
- [ ] **Step 4:** `pnpm vitest run && pnpm typecheck`. Baseline **413 pass / 0 fail**, clean. This repo needs no database, so anything red is real.
- [ ] **Step 5: Commit**

---

### Task 5: Reassignment — the room follows the agent

**Files:** Modify `apps/hub/src/routes/agents-admin.ts`, `apps/hub/src/services/matrix-as/gates.ts`, `apps/hub/src/db/schema/matrix.ts`, `apps/hub/scripts/migrate-agent-mxids.ts` (comments only)

**Interfaces:** Produces a writer for `matrix_rooms.principal_id`; `roomForCard` and `roomAgentUser` resolve through the principal.

**This closes slice A's finding I2.** `matrix_rooms.principal_id` was added for exactly this and left with no writer, alongside **two comments that falsely claim something backfills it** — `db/schema/matrix.ts:56-58` and `scripts/migrate-agent-mxids.ts:44-48`. Correct both.

- [ ] **Step 1: Write the failing test**

```typescript
test("a reassigned agent keeps its room, its id, and its history", async () => {
  // The whole reason the mxid comes from a handle rather than a station.
  const roomBefore = await roomForStation(stationA);
  await reassign(principalId, { from: stationA, to: stationB });
  expect(await roomForPrincipal(principalId)).toBe(roomBefore);   // same room id
});

test("station_id is not dropped — the sweep deployed on infra joins on it", async () => {
  expect((await roomRow(roomBefore)).stationId).not.toBeNull();
});
```

- [ ] **Step 2: Run and watch fail.**
- [ ] **Step 3: Implement.** Write `principal_id` on reassignment and backfill existing rows from their station's current occupant in the same migration. `roomForCard` becomes card → dispatch → station → principal → room. **Keep `station_id` and keep the old join working** until a later slice retires it deliberately.
- [ ] **Step 4: Run the suite twice, no reset.** The approvals path is covered by existing tests — a regression there is the thing this task must not cause.
- [ ] **Step 5: Commit**

---

## Verification before slice C is called done

- [ ] hub: **0 fail**, run twice without resetting; kaambaan **0 fail** + clean typecheck; console `svelte-check` 0 errors with its 132 pre-existing failures unchanged
- [ ] **The exit test, by hand:** adopt a station, create an agent for it in one action in the console, and watch a gate reach that agent's room — **with no SQL run at any point.** That is precisely what slices A and B cannot do today, and it is the whole reason this slice exists.
