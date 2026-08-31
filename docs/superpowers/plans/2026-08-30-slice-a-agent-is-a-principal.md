# Slice A — an agent is a principal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the suite a principal that can be an agent, so one agent has one id across all three planes.

**Architecture:** A `principals` table becomes the parent of identities and grants, replacing `user.id` as the thing they key on. An agent's Matrix id is minted from its immutable `handle` instead of from the node and station it happens to run on. A grant names one principal id and matches by equality, so the two per-plane values and their wildcards are deleted rather than deprecated.

**Tech Stack:** Bun · Hono · Drizzle/Postgres (hub) · Cloudflare Workers/D1 (kaambaan) · zod (shared contract) · `bun test` and `vitest`

**Spec:** `docs/superpowers/specs/2026-08-30-organization-plane-design.md` §2. The agreements it implements are `charter → decisions/2026-08-30-an-agent-is-a-principal.md` and `2026-08-30-matrix-identity-without-mas.md`.

## Global Constraints

- **Nothing is in production.** Build destinations, not migration paths: cut over, re-seed, delete the old form rather than deprecating it. A breaking change costs a rebuild.
- **Product independence is not migration scaffolding.** A standalone kaambaan must boot with no hub. `NULL` external mappings stay legal everywhere.
- **Id grammar is a cross-repo contract.** New prefixes use `prefixedId` → `^<prefix>_[0-9a-f]{20}$`. kaambaan's own id schema is `^<prefix>_[A-Za-z0-9]{6,}$`, which has **no hyphen** — so never mint a hyphenated UUID for anything that crosses the seam. `agentpod.station` already does and is a known scar; do not add a second.
- **TDD.** Every task writes the failing test first and watches it fail.
- **The hub's DB-backed tests cannot run on the dev machine** (no Docker, nothing on 5434). ~64 fail locally for that reason alone. Verify a baseline with `git stash -u` before believing a new failure. Migration and schema tests are proven in CI against its pg16 container.

## File Structure

**Create**
- `apps/hub/src/utils/ids.ts` — `prefixedId`, shared. Today it is a private const in `enrollment.ts:12`.
- `apps/hub/src/db/schema/organization.ts` — `organizations`, `principals`.
- `apps/hub/src/services/principals.ts` — mint, read, and the station-occupancy join.
- `apps/hub/scripts/seed-agent-principals.ts` — one-time, idempotent.
- `apps/hub/scripts/migrate-agent-mxids.ts` — one-time, idempotent, and the only irreversible step.

**Modify**
- `packages/contract/src/ids.ts` · `fixtures/ecosystem-identity/id_grammar.json` · `token_claims.json`
- `apps/hub/src/db/schema/identities.ts` · `grants.ts` · `stations.ts`
- `apps/hub/src/auth/jwt-claims.ts` · `apps/hub/src/services/grants.ts` · `grant-reach.ts` · `matrix-as/names.ts`
- kaambaan `apps/api/migrations/` · `apps/api/src/db/catalog.ts` · `apps/api/src/auth/hub-jwt.ts`

---

### Task 1: The id grammar for a principal and an organisation

**Files:**
- Modify: `packages/contract/src/ids.ts`
- Modify: `fixtures/ecosystem-identity/id_grammar.json`
- Test: `packages/contract/src/ecosystem-identity.test.ts`

**Interfaces:**
- Consumes: `truncatedUuidId(prefix)`, already in `ids.ts`
- Produces: `PrincipalId`, `OrganizationId` — zod schemas accepting `^prn_[0-9a-f]{20}$` and `^org_[0-9a-f]{20}$`

- [ ] **Step 1: Add the corpus entries.** In `fixtures/ecosystem-identity/id_grammar.json`, append to `entities`:

```json
{
  "entity": "agentpod.principal",
  "owner": "agentpod",
  "prefix": "prn",
  "grammar": "^prn_[0-9a-f]{20}$",
  "grammarSource": "agentpod packages/contract/src/ids.ts — PrincipalId",
  "mintedAs": "^prn_[0-9a-f]{20}$",
  "mintSource": "agentpod apps/hub/src/utils/ids.ts prefixedId()",
  "note": "Twenty lowercase hex, deliberately NOT a hyphenated UUID like agentpod.station: kaambaan's id schema is ^<prefix>_[A-Za-z0-9]{6,}$, whose alphabet has no hyphen, and a principal id crosses that seam on every grant.",
  "accept": [
    { "value": "prn_0123456789abcdef0123", "mint": true },
    { "value": "prn_ffffffffffffffffffff", "mint": true }
  ],
  "reject": [
    "prn_0123456789abcdef012",
    "prn_0123456789ABCDEF0123",
    "prn_01234567-89ab-cdef-0123-456789abcdef",
    "principal_0123456789abcdef0123",
    "prn_"
  ]
},
{
  "entity": "agentpod.organization",
  "owner": "agentpod",
  "prefix": "org",
  "grammar": "^org_[0-9a-f]{20}$",
  "grammarSource": "agentpod packages/contract/src/ids.ts — OrganizationId",
  "mintedAs": "^org_[0-9a-f]{20}$",
  "mintSource": "agentpod apps/hub/src/utils/ids.ts prefixedId()",
  "note": "Minted by the hub, which IS the Organization plane until the plane is extracted. tenants.external_id carries this value with external_source = 'org-plane'.",
  "accept": [{ "value": "org_0123456789abcdef0123", "mint": true }],
  "reject": ["org_0123456789abcdef012", "org_0123456789ABCDEF0123", "org_"]
},
{
  "entity": "kaambaan.gate",
  "owner": "kaambaan",
  "prefix": "gate",
  "grammar": "^gate_[A-Za-z0-9]{6,}$",
  "grammarSource": "kaambaan apps/api/src/board/board-do.ts createGate() — newId('gate')",
  "mintedAs": "^gate_[A-Za-z0-9]{16}$",
  "mintSource": "kaambaan newId('gate')",
  "note": "Absent from this corpus until 2026-08-30 although it crosses a repo boundary on every projected approval. kaambaan#34's sketch proposed `gat_`, which is why this entry exists.",
  "accept": [{ "value": "gate_4e8b1c2d3f4a5b6c", "mint": true }],
  "reject": ["gat_4e8b1c2d3f4a5b6c", "gate_", "gate_short"]
}
```

- [ ] **Step 2: Write the failing test.** The corpus test is table-driven; add the schemas to its map. In `packages/contract/src/ecosystem-identity.test.ts`, add to the imports and to the entity→schema table used by the existing round-trip:

```typescript
import { PrincipalId, OrganizationId } from "./ids";
// in the entity → schema map used by the corpus round-trip:
"agentpod.principal": PrincipalId,
"agentpod.organization": OrganizationId,
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/contract && bun test src/ecosystem-identity.test.ts`
Expected: FAIL — `PrincipalId` is not exported from `./ids`.

- [ ] **Step 4: Add the validators.** In `packages/contract/src/ids.ts`, beside `TenantId`:

```typescript
/** A suite principal — a human, an agent, or a service. */
export const PrincipalId = truncatedUuidId("prn");

/** An organisation. Minted by the hub until the Organization plane is extracted. */
export const OrganizationId = truncatedUuidId("org");
```

- [ ] **Step 5: Run it and watch it pass**

Run: `cd packages/contract && bun test src/ecosystem-identity.test.ts`
Expected: PASS. `kaambaan.gate` has no agentpod-side validator and is checked by kaambaan in Task 10; the corpus tolerates an entity a repo does not map.

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/ids.ts packages/contract/src/ecosystem-identity.test.ts fixtures/ecosystem-identity/id_grammar.json
git commit -m "feat(contract): a principal and an organisation have an id grammar

Twenty hex, not a hyphenated UUID: a principal id crosses the kaambaan seam on
every grant, and kaambaan's id schema has no hyphen in its alphabet.
agentpod.station already violates that and is a known scar; this does not add a
second. Also adds kaambaan.gate, absent since it started crossing a repo
boundary — kaambaan#34's sketch said 'gat_', which is what the corpus is for."
```

---

### Task 2: `organizations` and `principals`

**Files:**
- Create: `apps/hub/src/utils/ids.ts`
- Create: `apps/hub/src/db/schema/organization.ts`
- Modify: `apps/hub/src/db/schema/index.ts`, `apps/hub/src/services/enrollment.ts:12`
- Test: `apps/hub/src/db/schema/organization.test.ts`

**Interfaces:**
- Produces: `organizations`, `principals` Drizzle tables; `BOOTSTRAP_ORG_ID`; `prefixedId(prefix: string): string`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { prefixedId } from "../../utils/ids";
import { BOOTSTRAP_ORG_ID, PRINCIPAL_KINDS } from "./organization";

describe("principal ids and kinds", () => {
  test("a minted principal id matches the shared grammar", () => {
    // The corpus is the contract; a minter that drifts from it fails at the
    // seam rather than here, which is far more expensive to diagnose.
    expect(prefixedId("prn")).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("the bootstrap organisation is a fixed id, not a random one", () => {
    // Same reason tenants.BOOTSTRAP_TENANT_ID is a literal: a fresh deploy and
    // the live hub must agree on it, which a random value cannot guarantee.
    expect(BOOTSTRAP_ORG_ID).toBe("org_00000000000000000000");
  });

  test("kind is closed, and includes the one that did not exist", () => {
    expect(PRINCIPAL_KINDS).toEqual(["human", "agent", "service"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/db/schema/organization.test.ts`
Expected: FAIL — cannot resolve `../../utils/ids`.

- [ ] **Step 3: Extract the id minter**

Create `apps/hub/src/utils/ids.ts`:

```typescript
/**
 * Prefixed ids, one minter.
 *
 * Was a private const in `services/enrollment.ts`, which is why `station-registry`
 * grew a second, incompatible shape (a hyphenated UUID that kaambaan's own id
 * schema rejects — see `fixtures/ecosystem-identity/id_grammar.json`,
 * `agentpod.station`). One exported minter is how that stops happening again.
 */
export const prefixedId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
```

In `apps/hub/src/services/enrollment.ts`, delete the local const and import it:

```typescript
import { prefixedId } from "../utils/ids";
```

- [ ] **Step 4: Add the schema**

Create `apps/hub/src/db/schema/organization.ts`:

```typescript
/**
 * The Organization plane's tables, living in the hub until the plane is extracted.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md`. The hub already
 * IS the issuer; it is the Organization plane on the same terms, and extraction
 * moves these rows without changing their meaning. That is what
 * `2026-08-15-one-issuer-and-offline-verification` meant by "only the issuer
 * URL changes".
 */
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";

/** Fixed, for the same reason `BOOTSTRAP_TENANT_ID` is: a fresh deploy and the
 *  live hub must agree, and a random id cannot guarantee that. */
export const BOOTSTRAP_ORG_ID = "org_00000000000000000000";

export const PRINCIPAL_KINDS = ["human", "agent", "service"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [check("organizations_id_is_org", sql`${t.id} LIKE 'org\\_%'`)]
);

export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    /**
     * Explicit, never inferred from which identities exist. An agent with no
     * identities linked yet is still an agent, and inference would default it
     * to human — which is the one wrong answer that fails open.
     */
    kind: text("kind").notNull(),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    /**
     * Immutable, and what an agent's mxid is built from. `display_name` moves;
     * this does not, exactly as Matrix separates an mxid from a displayname.
     */
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    check("principals_id_is_prn", sql`${t.id} LIKE 'prn\\_%'`),
    check("principals_kind_known", sql`${t.kind} IN ('human','agent','service')`),
    /** One handle, one principal: it is an address, and two claimants make the
     *  mxid it produces ambiguous. */
    uniqueIndex("principals_org_handle_idx").on(t.orgId, t.handle),
  ]
);
```

Export both from `apps/hub/src/db/schema/index.ts` — the tenant guard enumerates the schema barrel rather than a whitelist, so a table missing from it fails that test rather than failing silently.

- [ ] **Step 5: Generate the migration, and seed the bootstrap org in it**

Run: `cd apps/hub && bun run db:generate`

Then hand-edit the generated SQL to append:

```sql
INSERT INTO organizations (id, name) VALUES ('org_00000000000000000000', 'Super Jackfruit Labs')
  ON CONFLICT (id) DO NOTHING;

UPDATE tenants
   SET external_id = 'org_00000000000000000000', external_source = 'org-plane'
 WHERE id = 'fleet_00000000000000000000' AND external_id IS NULL;
```

The `UPDATE` is the point: `tenants.external_id` / `external_source` shipped on 2026-08-14 for exactly this and have never held a value.

- [ ] **Step 6: Run the test and the tenant guard**

Run: `cd apps/hub && bun test src/db/schema/organization.test.ts`
Expected: PASS.
Run: `cd apps/hub && bun test src/db/tenant-scope.test.ts`
Expected: PASS — needs Postgres, so **this one is proven in CI** if the dev machine has no database.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/utils/ids.ts apps/hub/src/db/schema/organization.ts apps/hub/src/db/schema/organization.test.ts apps/hub/src/db/schema/index.ts apps/hub/src/services/enrollment.ts apps/hub/src/db/drizzle-migrations/
git commit -m "feat(hub): organizations and principals, and the columns built for them get used

The hub is the Organization plane until the plane is extracted, on the same
terms it is already the issuer. tenants.external_id / external_source shipped
2026-08-14 for this and have held NULL ever since; this migration fills them.

prefixedId moves out of enrollment.ts, where being private is how
station-registry came to mint a second, incompatible id shape."
```

---

### Task 3: Identities and grants key on a principal

**Files:**
- Modify: `apps/hub/src/db/schema/identities.ts`, `apps/hub/src/db/schema/grants.ts`
- Create: `apps/hub/src/services/principals.ts`
- Test: `apps/hub/src/services/principals.test.ts`

**Interfaces:**
- Consumes: `principals`, `organizations`, `BOOTSTRAP_ORG_ID`, `prefixedId`
- Produces: `createPrincipal({kind, handle, displayName?}): Promise<string>`, `principalForUser(userId: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { createPrincipal, principalForUser } from "./principals";

describe("principals", () => {
  test("mints an agent principal with a grammar-valid id", async () => {
    const id = await createPrincipal({ kind: "agent", handle: "writer-quill" });
    expect(id).toMatch(/^prn_[0-9a-f]{20}$/);
  });

  test("refuses a second principal on the same handle", async () => {
    await createPrincipal({ kind: "agent", handle: "analyst-echo" });
    // A handle is an address: two claimants make the mxid it produces ambiguous.
    expect(createPrincipal({ kind: "agent", handle: "analyst-echo" })).rejects.toThrow();
  });

  test("finds the principal behind a Better Auth user", async () => {
    const id = await createPrincipal({ kind: "human", handle: "rakesh", userId: "usr-uuid-here" });
    expect(await principalForUser("usr-uuid-here")).toBe(id);
  });

  test("a user with no principal resolves to null, never to a default", async () => {
    // Falling back would hand one principal's authority to an unmapped caller.
    expect(await principalForUser("usr-nobody")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/services/principals.test.ts`
Expected: FAIL — cannot resolve `./principals`.

- [ ] **Step 3: Re-point the two foreign keys**

In `apps/hub/src/db/schema/identities.ts` and `grants.ts`, change the reference and the import:

```typescript
import { principals } from "./organization";
// ...
principalId: text("principal_id")
  .notNull()
  .references(() => principals.id, { onDelete: "cascade" }),
```

In `identities.ts`, add `better-auth` to the allowed systems:

```typescript
export const IDENTITY_SYSTEMS = ["better-auth", "matrix", "kaambaan", "agentpod", "org-plane"] as const;
```

- [ ] **Step 4: Write the service**

Create `apps/hub/src/services/principals.ts`:

```typescript
import { and, eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { principalIdentities } from "../db/schema/identities";
import { BOOTSTRAP_ORG_ID, principals, type PrincipalKind } from "../db/schema/organization";
import { prefixedId } from "../utils/ids";

export async function createPrincipal(input: {
  kind: PrincipalKind;
  handle: string;
  displayName?: string;
  /** When present, links the Better Auth user as this principal's login identity. */
  userId?: string;
}): Promise<string> {
  const id = prefixedId("prn");
  await db.insert(principals).values({
    id,
    kind: input.kind,
    orgId: BOOTSTRAP_ORG_ID,
    handle: input.handle,
    displayName: input.displayName ?? null,
  });
  if (input.userId) {
    await db.insert(principalIdentities).values({
      id: crypto.randomUUID(),
      principalId: id,
      system: "better-auth",
      externalId: input.userId,
    });
  }
  return id;
}

/**
 * The principal behind a Better Auth user, or null.
 *
 * Null rather than a fallback: an unmapped caller must fail closed, for the same
 * reason `buildTokenPayload` refuses to mint a token when no tenant resolves.
 */
export async function principalForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ principalId: principalIdentities.principalId })
    .from(principalIdentities)
    .where(
      and(eq(principalIdentities.system, "better-auth"), eq(principalIdentities.externalId, userId))
    )
    .limit(1);
  return row?.principalId ?? null;
}
```

- [ ] **Step 5: Generate the migration, and backfill the human in it**

Run: `cd apps/hub && bun run db:generate`, then append to the generated SQL:

```sql
-- One row today. Mint a principal for each existing user and carry the
-- identities and grants that pointed at it.
INSERT INTO principals (id, kind, org_id, handle, display_name)
SELECT 'prn_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
       'human', 'org_00000000000000000000',
       lower(regexp_replace(split_part(u.email, '@', 1), '[^a-z0-9._=/-]', '-', 'g')),
       u.name
  FROM "user" u;

INSERT INTO principal_identities (id, principal_id, system, external_id)
SELECT gen_random_uuid()::text, p.id, 'better-auth', u.id
  FROM "user" u
  JOIN principals p ON p.handle = lower(regexp_replace(split_part(u.email, '@', 1), '[^a-z0-9._=/-]', '-', 'g'));

UPDATE principal_identities pi SET principal_id = p.id
  FROM principal_identities bi JOIN principals p ON p.id = bi.principal_id
 WHERE bi.system = 'better-auth' AND pi.principal_id = bi.external_id;

UPDATE principal_grants g SET principal_id = p.id
  FROM principal_identities bi JOIN principals p ON p.id = bi.principal_id
 WHERE bi.system = 'better-auth' AND g.principal_id = bi.external_id;
```

Run the two `UPDATE`s **before** the migration adds the new foreign keys, or they will be rejected.

- [ ] **Step 6: Run the tests**

Run: `cd apps/hub && bun test src/services/principals.test.ts`
Expected: PASS. Needs Postgres; in CI if the dev machine has none.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/db/schema/identities.ts apps/hub/src/db/schema/grants.ts apps/hub/src/services/principals.ts apps/hub/src/services/principals.test.ts apps/hub/src/db/drizzle-migrations/
git commit -m "feat(hub): identities and grants key on a principal, not on a user

charter decisions/2026-08-13-ecosystem-identity.md Decision 3 rests on an agent
holding authority 'as a principal'. Both tables keyed on user.id, so a principal
was structurally a human and the entity that decision describes could not exist.

Better Auth's user becomes one identity of one kind of principal, reached
through principal_identities like any other system. Not a user row per agent:
user requires email and emailVerified, and filling those with placeholders to
satisfy an auth library is MT-1's mistake wearing a different hat."
```

---

### Task 4: `principalKind` stops being a literal

**Files:**
- Modify: `apps/hub/src/auth/jwt-claims.ts:58-81`
- Test: `apps/hub/src/auth/jwt-claims.test.ts`

**Interfaces:**
- Consumes: `principalForUser`, `principals`
- Produces: `buildTokenPayload` emitting `sub` = principal id and a real `principalKind`

- [ ] **Step 1: Write the failing test**

```typescript
test("an agent's token says it is an agent, and names the principal", async () => {
  const payload = await buildTokenPayload({
    user: { id: "usr-uuid" },
    resolvePrincipal: async () => ({ id: "prn_0123456789abcdef0123", kind: "agent" }),
    resolveTenant: async () => "fleet_00000000000000000000",
    loadGrant: async () => ({ mayDispatch: [], mayGrantReach: false }),
  });
  expect(payload.principalKind).toBe("agent");
  expect(payload.sub).toBe("prn_0123456789abcdef0123");
});

test("refuses to mint for a caller with no principal", async () => {
  // Same shape as the no-tenant refusal below it: a token that verifies but
  // names nobody is not a weaker caller, it is an unattributable one.
  expect(
    buildTokenPayload({ user: { id: "usr-unmapped" }, resolvePrincipal: async () => null })
  ).rejects.toThrow(/no principal/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/auth/jwt-claims.test.ts`
Expected: FAIL — `principalKind` is `"human"` and `sub` is the user id.

- [ ] **Step 3: Implement**

In `apps/hub/src/auth/jwt-claims.ts`, replace the hardcoded literal:

```typescript
export interface BuildPayloadInput {
  user: { id: string };
  resolveTenant?: (userId: string) => Promise<string | null>;
  loadGrant?: (principalId: string) => Promise<{ mayDispatch: string[]; mayGrantReach: boolean } | null>;
  resolvePrincipal?: (userId: string) => Promise<{ id: string; kind: PrincipalKind } | null>;
}

export async function buildTokenPayload(input: BuildPayloadInput): Promise<TokenPayload> {
  const principal = await (input.resolvePrincipal ?? defaultResolvePrincipal)(input.user.id);
  if (!principal) {
    throw new Error(`refusing to mint a token for ${input.user.id}: no principal resolved`);
  }

  const tenant = await (input.resolveTenant ?? resolveTenantForUser)(input.user.id);
  if (!tenant) {
    throw new Error(`refusing to mint a token for ${input.user.id}: no tenant resolved`);
  }

  const grant = await (input.loadGrant ?? getGrant)(principal.id);

  return {
    sub: principal.id,
    principalKind: principal.kind,
    tenant,
    mayDispatch: grant?.mayDispatch ?? [],
    mayGrantReach: grant?.mayGrantReach ?? false,
  };
}
```

`resolveTenantForUser` keeps its signature — it ignores its argument today and returns `BOOTSTRAP_TENANT_ID`, so it needs no change in this slice.

**A cross-repo consequence to know about rather than discover.** `sub` stops
being a Better Auth user UUID and becomes `prn_…`. kaambaan does not validate its
shape — `hub-jwt.ts:179` checks only that it is a non-empty string — so
verification is unaffected. But `sub` is what a hub-token gate resolution writes
to `gates.decided_by`, so that column's values change form. Nothing migrates the
four rows already there, and nothing needs to: they are pre-production, and
`charter → decisions/2026-08-30-a-gate-closes-over-chat.md` already records
"kaambaan's audit trail gains foreign ids" as an accepted cost. Do not add a
backfill for them.

- [ ] **Step 4: Run and watch it pass**

Run: `cd apps/hub && bun test src/auth/jwt-claims.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/auth/jwt-claims.ts apps/hub/src/auth/jwt-claims.test.ts
git commit -m "feat(hub): a token names its principal, and says what kind it is

principalKind was the literal \"human\" beside a comment describing an exchange
path that did not exist. sub becomes the principal id, so a claim means the same
thing whoever holds it — which is the whole basis for an agent ever carrying one."
```

---

### Task 5: A station knows which agent occupies it

**Files:**
- Modify: `apps/hub/src/db/schema/stations.ts`
- Create: `apps/hub/scripts/seed-agent-principals.ts`
- Test: `apps/hub/src/services/principals.test.ts`

**Interfaces:**
- Produces: `stations.principalId` (nullable text → `principals.id`)

**Note — a deliberate refinement of the decision's sketch.** The decision lists the `agentpod` link among `principal_identities`. Occupancy is put on `stations` instead: `principal_identities` is *a record of sameness* — an mxid, a kaambaan agent id — and where an agent happens to run is not sameness. A column also keeps the grant check synchronous, since every caller already holds the station row.

- [ ] **Step 1: Write the failing test**

```typescript
test("a station with no agent has no principal, and that is legal", async () => {
  const s = await stationRow("stn-unoccupied");
  expect(s.principalId).toBeNull();
});

test("seeding gives every adopted station an agent principal, and is idempotent", async () => {
  const first = await seedAgentPrincipals();
  const second = await seedAgentPrincipals();
  expect(first.created).toBeGreaterThan(0);
  expect(second.created).toBe(0); // re-running must not mint a second identity
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/services/principals.test.ts`
Expected: FAIL — `principalId` is not a column; `seedAgentPrincipals` is not defined.

- [ ] **Step 3: Add the column**

In `apps/hub/src/db/schema/stations.ts`:

```typescript
/**
 * The agent that occupies this station, if any.
 *
 * Nullable and it stays nullable: a station nobody has assigned is a machine,
 * not an agent, and it is dispatchable by nobody — which is the behaviour change
 * charter decisions/2026-08-30-an-agent-is-a-principal.md §3 names.
 *
 * Here rather than in `principal_identities` because occupancy is not sameness.
 * A principal's identities say who it also is; this says where it currently runs.
 */
principalId: text("principal_id").references(() => principals.id, { onDelete: "set null" }),
```

Run `bun run db:generate`.

- [ ] **Step 4: Write the seed script**

Create `apps/hub/scripts/seed-agent-principals.ts`:

```typescript
/**
 * One agent principal per adopted station — the one-time backfill for a fleet
 * that predates principals. Idempotent: a station that already has one is left
 * alone, so this is safe to re-run after adopting more stations.
 *
 * After this, creating an agent is a deliberate act and station adoption LINKS
 * to an existing principal rather than implying one.
 */
import { eq, isNull } from "drizzle-orm";

import { db } from "../src/db/drizzle";
import { nodes } from "../src/db/schema/nodes";
import { stations } from "../src/db/schema/stations";
import { createPrincipal } from "../src/services/principals";

/** `guild` + `hermes:writer-quill` → `writer-quill`; falls back to the whole key. */
const handleFor = (stationKey: string): string => {
  const tail = stationKey.includes(":") ? stationKey.slice(stationKey.indexOf(":") + 1) : stationKey;
  return tail.toLowerCase().replace(/[^a-z0-9._=/-]/g, "-");
};

export async function seedAgentPrincipals(): Promise<{ created: number }> {
  const rows = await db
    .select({ id: stations.id, key: stations.stationKey, node: nodes.name })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(isNull(stations.principalId));

  let created = 0;
  for (const s of rows) {
    // Two nodes can carry the same station key — `opencode:c52ddf65` did — so
    // the handle is qualified when the bare one is taken.
    let handle = handleFor(s.key);
    try {
      const principalId = await createPrincipal({ kind: "agent", handle, displayName: s.key });
      await db.update(stations).set({ principalId }).where(eq(stations.id, s.id));
    } catch {
      handle = `${s.node}-${handle}`;
      const principalId = await createPrincipal({ kind: "agent", handle, displayName: s.key });
      await db.update(stations).set({ principalId }).where(eq(stations.id, s.id));
    }
    created++;
  }
  return { created };
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd apps/hub && bun test src/services/principals.test.ts`
Expected: PASS. Postgres-backed; CI if unavailable locally.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/db/schema/stations.ts apps/hub/scripts/seed-agent-principals.ts apps/hub/src/services/principals.test.ts apps/hub/src/db/drizzle-migrations/
git commit -m "feat(hub): a station records which agent occupies it

Occupancy is a station attribute, not a record of sameness — principal_identities
says who a principal ALSO is, and where an agent runs is not that. It also keeps
the grant check synchronous, since every caller already holds the station row.

Nullable, permanently: an unassigned station is a machine, and dispatchable by
nobody. The seed is idempotent and qualifies a handle by node when a bare key
collides, which opencode:c52ddf65 did on two nodes in production."
```

---

### Task 6: Growing the fleet becomes an admin act

**Files:**
- Modify: `apps/hub/src/services/grant-reach.ts:157-172`
- Test: `apps/hub/src/services/grant-reach.test.ts`

**Interfaces:**
- Consumes: the admin middleware already guarding `/api/admin/grants`
- **Ordered before the matcher collapse on purpose.** `requireFleetGrantReach` is the last
  consumer of `AGENTPOD_NS`, which Task 7 deletes. Doing Task 7 first leaves the tree
  uncompilable between the two tasks.
- Produces: `requireFleetGrantReach(userId)` refusing anyone who is not an admin

- [ ] **Step 1: Write the failing test**

```typescript
test("a non-admin cannot mint an enrollment token, however wide their grant", async () => {
  // The wildcard that encoded "your authority spans the fleet" no longer
  // exists. A second scoped list was rejected by
  // 2026-08-15-granting-reach-is-changing-an-agent, so this is admin.
  await expect(requireFleetGrantReach("prn_0123456789abcdef0123")).rejects.toThrow(GrantReachDenied);
});

test("an admin may", async () => {
  await expect(requireFleetGrantReach(ADMIN_PRINCIPAL)).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/services/grant-reach.test.ts`
Expected: FAIL — the current implementation looks for a `*/` prefix that can no longer be written.

- [ ] **Step 3: Implement**

```typescript
/**
 * Growing a fleet is an admin act.
 *
 * This used to require `mayGrantReach` plus a dispatch value whose node half was
 * `*` — "you may grow a fleet only if your authority already spans it". With no
 * wildcards there is no way to say "spans", and
 * 2026-08-15-granting-reach-is-changing-an-agent explicitly rejected a second
 * scoped list as the asymmetric-grant hazard restated. Admin is the honest
 * remaining answer, and /api/admin/grants is already guarded that way.
 */
export async function requireFleetGrantReach(principalId: string): Promise<void> {
  if (!isControlPairEnforced()) return;
  if (await isAdminPrincipal(principalId)) return;
  log.warn("fleet-level reach refused: not an admin", { principalId });
  throw new GrantReachDenied(principalId, "fleet", null);
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd apps/hub && bun test src/services/grant-reach.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/services/grant-reach.ts apps/hub/src/services/grant-reach.test.ts
git commit -m "feat(hub): growing the fleet is an admin act

The wildcard encoded 'your authority spans the fleet' and wildcards are gone. A
second scoped list was already rejected as the asymmetric-grant hazard, so admin
is what is left — and it is where the grant escape hatch already lives."
```

---

### Task 7: A grant names one principal, and matches by equality

**Files:**
- Modify: `apps/hub/src/services/grants.ts:110-190`
- Modify: `apps/hub/src/routes/missions.ts:117`, `station-say.ts:71`, `services/grant-reach.ts:92,137`, `services/acp-sessions.ts:668`, `services/matrix-as/inbound.ts:177`
- Modify: `fixtures/ecosystem-identity/token_claims.json`
- Test: `apps/hub/src/services/grants.test.ts`

**Interfaces:**
- Consumes: `stations.principalId`
- Produces: `grantAllowsPrincipal(grant: Grant | null, principalId: string | null): boolean`. `segmentMatches`, `patternMatchesStation` and `AGENTPOD_NS` are **deleted**.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { grantAllowsPrincipal } from "./grants";

const grant = (ids: string[]) => ({ mayDispatch: ids, mayGrantReach: false });

describe("a grant names one principal", () => {
  test("allows exactly the principal it names", () => {
    expect(grantAllowsPrincipal(grant(["prn_0123456789abcdef0123"]), "prn_0123456789abcdef0123")).toBe(true);
  });

  test("no grant is not an unrestricted grant", () => {
    expect(grantAllowsPrincipal(null, "prn_0123456789abcdef0123")).toBe(false);
  });

  test("an unassigned station is dispatchable by nobody", () => {
    expect(grantAllowsPrincipal(grant(["prn_0123456789abcdef0123"]), null)).toBe(false);
  });

  test("ignores a value from another plane rather than denying on it", () => {
    // A claim is read by more planes over time, not fewer. Refusing an
    // unrecognised value breaks every time one is added.
    expect(grantAllowsPrincipal(grant(["tm_editors", "prn_0123456789abcdef0123"]), "prn_0123456789abcdef0123")).toBe(true);
  });

  test("there is no wildcard", () => {
    // agentpod:*/hermes matched a root station that should never have existed,
    // and hermes:* silently spanned nodes. A pattern matches things nobody
    // intended; an enumeration cannot.
    expect(grantAllowsPrincipal(grant(["*"]), "prn_0123456789abcdef0123")).toBe(false);
    expect(grantAllowsPrincipal(grant(["prn_*"]), "prn_0123456789abcdef0123")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/services/grants.test.ts`
Expected: FAIL — `grantAllowsPrincipal` is not exported.

- [ ] **Step 3: Replace the matcher**

In `apps/hub/src/services/grants.ts`, delete `segmentMatches`, `patternMatchesStation`, `grantAllowsStation`, `StationRef` and `AGENTPOD_NS`, and add:

```typescript
/**
 * Does this grant permit dispatching to this principal?
 *
 * Equality, and deliberately nothing more. `charter →
 * decisions/2026-08-30-an-agent-is-a-principal.md` §3 removed patterns because
 * they matched things nobody intended: `hermes:*` silently spanned nodes, and
 * `agentpod:*/hermes` reached a root station that should never have existed.
 *
 * `null` — a station with no agent — is refused, not allowed. An unassigned
 * station is a machine, not an agent.
 *
 * An unrecognised value is ignored rather than denied: a claim is read by more
 * planes over time, and a plane that refused what it did not understand would
 * break each time one was added.
 */
export function grantAllowsPrincipal(grant: Grant | null, principalId: string | null): boolean {
  if (!grant || !principalId) return false;
  return grant.mayDispatch.includes(principalId);
}
```

- [ ] **Step 4: Update the six call sites.** Each already holds the station row; pass its `principalId`. For example, `apps/hub/src/routes/station-say.ts:71`:

```typescript
const allowed = grantAllowsPrincipal(grant, station.principalId);
```

Do the same at `missions.ts:117` (the station list gains `principalId`), `grant-reach.ts:92` and `:137`, `acp-sessions.ts:668`, and `matrix-as/inbound.ts:177`.

- [ ] **Step 5: Update the shared claim fixture.** In `fixtures/ecosystem-identity/token_claims.json`, `mayDispatch` values become bare principal ids; add a reject case for a wildcard so the removal is pinned across repos, not merely done here.

- [ ] **Step 6: Run the suites**

Run: `cd apps/hub && bun test src/services/grants.test.ts src/services/grant-reach.test.ts`
Expected: PASS.
Run: `cd packages/contract && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/services/grants.ts apps/hub/src/services/grants.test.ts apps/hub/src/routes/ apps/hub/src/services/ fixtures/ecosystem-identity/token_claims.json
git commit -m "feat(hub): a grant names one principal, and there are no wildcards

Both per-plane values are deleted rather than deprecated — nothing is in
production, so the destination is built directly instead of a third value and a
retirement phase.

Wildcards go because they matched things nobody intended: hermes:* silently
spanned nodes, and agentpod:*/hermes reached a root station that should never
have existed and was removed on 2026-08-30. Grants become enumerations, which is
'said out loud' taken to its conclusion — and when a list becomes unwieldy, that
is earned evidence that Teams are real."
```

---

### Task 8: An agent's mxid comes from its handle

**Files:**
- Modify: `apps/hub/src/services/matrix-as/names.ts:32-55`
- Test: `apps/hub/src/services/matrix-as/names.test.ts`

**Interfaces:**
- Produces: `bridgeLocalpart(handle: string): string`, `bridgeUserId(handle: string, domain: string): string`. Every caller passes a handle instead of `(nodeName, stationKey)`.

- [ ] **Step 1: Write the failing test**

```typescript
test("an agent's address survives moving between nodes", () => {
  // The principle the strategy states twice: an agent is an identity, a station
  // is a location. Derived from node+station, moving an agent made it a
  // different person in chat.
  expect(bridgeUserId("writer-quill", "id.agentpod.dev")).toBe("@agent_writer-quill:id.agentpod.dev");
});

test("still lands inside the exclusive @agent_.* namespace", () => {
  // Outside it the appservice may not act — a 403 that arrives later and elsewhere.
  expect(bridgeLocalpart("Writer Quill")).toMatch(/^agent_[a-z0-9._=/-]+$/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test src/services/matrix-as/names.test.ts`
Expected: FAIL — `bridgeUserId` takes three arguments.

- [ ] **Step 3: Implement**

```typescript
export function bridgeLocalpart(handle: string): string {
  return `agent_${clean(handle)}`;
}

export function bridgeUserId(handle: string, domain: string): string {
  return `@${bridgeLocalpart(handle)}:${domain}`;
}
```

Keep `localpartFor(nodeName, stationKey)` — `bridgeAlias` still uses it, and an alias is a room's address rather than an agent's.

- [ ] **Step 4: Update callers.** `matrix-as/gates.ts` (in `projectGate` and `roomAgentUser`), `provision.ts`, `activity.ts`, `outbound.ts`. Each resolves the station's `principalId` → `principals.handle`.

- [ ] **Step 5: Run the suite**

Run: `cd apps/hub && bun test src/services/matrix-as`
Expected: PASS — 287 tests in this area were green before the change.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/matrix-as/
git commit -m "feat(hub): an agent's Matrix address comes from its handle, not its station

bridgeUserId(nodeName, stationKey, domain) made an agent's chat identity a
function of where it ran: move it and it became a different person, with new DM
rooms and its history left behind. The strategy states the opposite principle
twice. Rooms are migrated separately and none are recreated."
```

---

### Task 9: Migrate the 32 rooms

**Files:**
- Create: `apps/hub/scripts/migrate-agent-mxids.ts`
- Modify: `apps/hub/src/db/schema/matrix.ts` (`matrixRooms.principalId`)
- Test: `apps/hub/scripts/migrate-agent-mxids.test.ts`

**Interfaces:**
- Consumes: `stations.principalId`, `principals.handle`, `bridgeUserId(handle, domain)`
- Produces: `migrateAgentMxids(deps): Promise<{ migrated: number; skipped: number }>`

**This is the only irreversible step in slice A.** No room is deleted and no history is lost — Matrix keeps messages from departed members.

- [ ] **Step 1: Write the failing test**

```typescript
test("the new user joins the existing room and the old one leaves", async () => {
  const acts: string[] = [];
  await migrateAgentMxids({
    rooms: async () => [{ roomId: "!r:h", handle: "writer-quill", oldUserId: "@agent_guild_hermes-writer-quill:h" }],
    join: async (u, r) => { acts.push(`join ${u} ${r}`); },
    leave: async (u, r) => { acts.push(`leave ${u} ${r}`); },
    setDirect: async (u, r) => { acts.push(`direct ${u} ${r}`); },
  });
  // Join BEFORE leave: the reverse leaves the room briefly with no agent in it.
  expect(acts).toEqual([
    "join @agent_writer-quill:h !r:h",
    "direct @agent_writer-quill:h !r:h",
    "leave @agent_guild_hermes-writer-quill:h !r:h",
  ]);
});

test("is idempotent — a room already migrated is skipped", async () => {
  const r = await migrateAgentMxids({ rooms: async () => [], join: fail, leave: fail, setDirect: fail });
  expect(r.migrated).toBe(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && bun test scripts/migrate-agent-mxids.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
/**
 * Re-address 32 DM rooms from station-derived users to principal-derived ones.
 *
 * No room is deleted and no history is lost: Matrix keeps messages from members
 * who have left. The AS owns the whole `@agent_.*` namespace, so the new user
 * joins without an invite.
 *
 * The step that is easy to miss is `m.direct`. `provision.ts` creates these with
 * `isDirect`, and that flag rides on the OWNER'S invite — so the account data
 * names the OLD mxid. Skip this and 32 rooms quietly stop being DMs in the
 * client: still there, still readable, no longer under People.
 */
export interface MxidMigrationDeps {
  rooms(): Promise<Array<{ roomId: string; handle: string; oldUserId: string }>>;
  join(userId: string, roomId: string): Promise<void>;
  leave(userId: string, roomId: string): Promise<void>;
  setDirect(userId: string, roomId: string): Promise<void>;
}

export async function migrateAgentMxids(
  deps: MxidMigrationDeps,
  domain = process.env.MATRIX_DOMAIN ?? "id.agentpod.dev"
): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  for (const room of await deps.rooms()) {
    const next = bridgeUserId(room.handle, domain);
    if (next === room.oldUserId) { skipped++; continue; }
    // Join first. Leaving first would leave the room with no agent in it, and a
    // crash between the two would leave it that way permanently.
    await deps.join(next, room.roomId);
    await deps.setDirect(next, room.roomId);
    await deps.leave(room.oldUserId, room.roomId);
    migrated++;
  }
  return { migrated, skipped };
}
```

Add `principalId` to `matrixRooms` and re-key from `stationId` in the same migration.

- [ ] **Step 4: Run and watch it pass**

Run: `cd apps/hub && bun test scripts/migrate-agent-mxids.test.ts`
Expected: PASS.

- [ ] **Step 5: Rehearse before the fleet.** Run against **one** scratch station's room on the live homeserver, confirm in a client that the room still appears under People with its history, then run the rest.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/scripts/migrate-agent-mxids.ts apps/hub/scripts/migrate-agent-mxids.test.ts apps/hub/src/db/schema/matrix.ts apps/hub/src/db/drizzle-migrations/
git commit -m "feat(hub): re-address the fleet's DM rooms to principal-derived users

Membership, not recreation: the new user joins, the old one leaves, its messages
stay. Join before leave, because the reverse leaves a room with no agent in it
and a crash between the two makes that permanent.

The m.direct fix-up is the easy miss — the DM flag rides on the owner's invite,
so the account data names the old mxid and the rooms quietly stop being DMs."
```

---

### Task 10: kaambaan maps its agents onto principals

**Files:**
- Create: `apps/api/migrations/000X_agents_external_id.sql`
- Modify: `apps/api/src/db/catalog.ts:144-156`, `apps/api/src/auth/hub-jwt.ts`
- Test: `apps/api/test/agent-external-mapping.test.ts`

**Interfaces:**
- Produces: `agents.external_id`, `agents.external_source`; `findAgentByExternal(db, source, externalId)`

- [ ] **Step 1: Write the failing test**

```typescript
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { setupCatalog } from './helpers/catalog';
import { createAgent, findAgentByExternal } from '../src/db/catalog';

beforeAll(setupCatalog);

describe('an agent maps to a suite principal', () => {
  it('finds a local agent by the principal it maps to', async () => {
    const a = await createAgent(env.DB, 'tnt_a', { name: 'Forge', capabilities: ['research'] });
    await env.DB.prepare(`UPDATE agents SET external_id = ?, external_source = 'org-plane' WHERE id = ?`)
      .bind('prn_0123456789abcdef0123', a.id).run();
    const found = await findAgentByExternal(env.DB, 'org-plane', 'prn_0123456789abcdef0123');
    expect(found?.agentId).toBe(a.id);
  });

  it('an unmapped agent is the normal state, not a fault', async () => {
    // A standalone board must boot with no hub in existence. NULL stays legal.
    const a = await createAgent(env.DB, 'tnt_b', { name: 'Solo', capabilities: [] });
    expect(await findAgentByExternal(env.DB, 'org-plane', 'prn_nope')).toBeNull();
    expect(a.id).toMatch(/^agt_/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && pnpm vitest run test/agent-external-mapping.test.ts`
Expected: FAIL — no such column `external_id`; `findAgentByExternal` is not exported.

- [ ] **Step 3: Migration**

```sql
-- The same manoeuvre tenants already carries: a local id plus an optional
-- mapping to the same real thing elsewhere. NULL is the normal state — a
-- standalone board must work with no hub in existence.
ALTER TABLE agents ADD COLUMN external_id TEXT;
ALTER TABLE agents ADD COLUMN external_source TEXT;
CREATE UNIQUE INDEX agents_external_idx ON agents (external_source, external_id);
```

- [ ] **Step 4: Implement the lookup**

```typescript
export async function findAgentByExternal(
  db: D1Database,
  source: string,
  externalId: string,
): Promise<{ tenantId: string; agentId: string; capabilities: string[] } | null> {
  const row = await db
    .prepare(
      `SELECT tenant_id AS tenantId, id AS agentId, capabilities_json AS caps
         FROM agents WHERE external_source = ? AND external_id = ?`,
    )
    .bind(source, externalId)
    .first<{ tenantId: string; agentId: string; caps: string }>();
  if (!row) return null;
  return { tenantId: row.tenantId, agentId: row.agentId, capabilities: JSON.parse(row.caps) };
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd apps/api && pnpm vitest run test/agent-external-mapping.test.ts`
Expected: PASS.
Run: `cd apps/api && pnpm vitest run && pnpm typecheck`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/ apps/api/src/db/catalog.ts apps/api/test/agent-external-mapping.test.ts
git commit -m "feat(api): an agent can map to a suite principal

The same manoeuvre tenants already carries, and NULL stays the normal state:
a standalone board must boot with no hub in existence. This is product
independence, not migration scaffolding — the distinction the rest of this
slice depends on."
```

---

## Verification before slice A is called done

- [ ] `cd packages/contract && bun test` — the corpus round-trip, both repos' view
- [ ] `cd apps/hub && bun test src/services src/auth src/routes` — compare failures against a `git stash -u` baseline; DB-backed ones are CI's job
- [ ] `cd apps/api && pnpm vitest run && pnpm typecheck` — kaambaan green
- [ ] **The exit test, on the fleet:** a gate reaches the phone, is approved, and the board records the human — with the agent's mxid derived from its principal and the grant naming one id. If the 2026-08-30 exit test passes unchanged over the new spine, the slice is honest.
