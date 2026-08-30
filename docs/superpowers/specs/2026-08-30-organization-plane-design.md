# The Organization plane — implementation design

**Date:** 2026-08-30
**Status:** Designed, unbuilt.
**The agreements this implements** are
`charter → decisions/2026-08-30-an-agent-is-a-principal.md` and
`charter → decisions/2026-08-30-matrix-identity-without-mas.md`. Read them
first. They settle what a principal is, where an agent's Matrix identity comes
from, what a grant names, how an agent gets a token, and what all of it costs.
This document holds only what they deliberately do not: what changes in which
repository, in what order, and how it is tested.

**The frame.** Nothing in this suite is in production and nothing goes into real
use until the stack is autonomous end to end. That is not a caveat, it is a
design input: **build destinations, not migration paths.** Cut over rather than
dual-run, re-seed rather than backfill, one canonical id rather than a third
value and a retirement phase. A breaking change costs a rebuild, not an
incident.

The one thing it does not license: **product independence is not migration
scaffolding.** A standalone kaambaan must still boot with no hub in existence.
`NULL` mappings stay.

---

## 1. The shape

```
                  Organization plane  (C — Better Auth in its own right)
                  principals · identities · grants · user/session/jwks
                          │  issues, offline-verifiable
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   AgentPod hub       kaambaan          supermessage
   fleet · stations   boards · agents   the client
   tenants(ext→org)   tenants(ext→org)  @agent_<handle>
                      agents(ext→prn)
```

Three slices, in order. **A** gives the suite the entity it has been describing
and could not represent. **B** makes it load-bearing. **C** moves it to where
the ownership map says it belongs.

**Each slice is its own implementation plan and its own series of PRs.** This is
one design because the three share a spine and a decision; it is not one plan.
A alone touches four repositories, and the first PR in it — the fixture plus the
`principals` table and its backfill — changes no behaviour and nothing reads it
yet.

## 2. A — an agent is a principal

### 2.1 agentpod hub

1. **`principals`** — `id (prn_)`, `kind`, `org_id`, `handle`, `display_name`.
   `handle` is immutable and unique; it is what an mxid is built from.

   **What `org_id` holds before the plane exists**, because "the organisation"
   is otherwise undefined for the whole of A and B: **the hub mints `org_` ids
   from the first migration**, and `tenants.external_id` /
   `external_source = 'org-plane'` maps fleet → org immediately. The hub *is*
   the Organization plane until C moves it, exactly as it is already the issuer.
   C then moves rows whose meaning does not change — which is the whole reason
   `2026-08-15-one-issuer` could say *"only the issuer URL changes"*.

   The alternative — a nullable `org_id` backfilled at C — would make A and B
   depend on a column that means nothing yet, and would put a data change inside
   the riskiest slice.
2. **Re-point two foreign keys.** `principal_identities.principal_id` and
   `principal_grants.principal_id` move from `user.id` to `principals.id`.
   Backfill is one row today. Take the FK — a dangling grant in an
   authorization table is an orphan nothing would catch.
3. **`user` becomes an identity.** A `better-auth` row in
   `principal_identities`, reached like any other system.
4. **`principalKind` stops being a literal.** Read `principals.kind`.
5. **`resolveTenantForUser` resolves through the principal.** 21 references
   across 16 files; most keep their signature and the hop moves inside.
6. **Seed agent principals from the fleet** — a one-time script over the 32
   stations. After it, creating an agent is a deliberate act and station
   adoption *links* to an existing principal rather than implying one.

### 2.2 The mxid migration — the only irreversible step in A

`bridgeUserId(nodeName, stationKey, domain)` becomes
`bridgeUserId(handle, domain)`. For each of the 32 rooms:

1. register `@agent_<handle>:<domain>` and **join the existing room** — the AS
   owns the whole `@agent_.*` namespace, so no invite is needed;
2. the station-derived user leaves; **its messages stay** — Matrix keeps
   history from departed members;
3. re-point the alias;
4. re-key `matrix_rooms` from `station_id` to `principal_id`;
5. **fix up `m.direct`.** The room was created with `isDirect` and the flag
   rides on the owner's invite (`provision.ts`), so the account data names the
   **old** mxid. Skip this and 32 rooms quietly stop being DMs in the client.

**No room is deleted and no history is lost.** Write it as one idempotent
script, and run it against a scratch station before the fleet.

### 2.3 kaambaan

`agents` gains `external_id` / `external_source`, the pair `tenants` already
carries. `NULL` for a standalone board.

### 2.4 The contract

- `fixtures/ecosystem-identity/id_grammar.json` — add `prn_`. **Also add
  `gate`**, absent entirely, flagged in the approvals worklog and never done;
  it crosses a repo boundary now, and `gat_`/`gate_` confusion in kaambaan#34's
  sketch is what the grammar exists to prevent.
- `token_claims.json` — `mayDispatch` becomes a list of bare principal ids.
- **Both existing matchers are deleted, not deprecated.** No third value, no
  retirement phase.

Fleet enrollment becomes an admin act, because the wildcard that encoded
"your authority spans the fleet" no longer exists.

## 3. B — exchange

1. **An exchange endpoint** taking a `kbn_` token or a station credential,
   returning a short-lived token with `sub = prn_…`, `principalKind: "agent"`,
   claims from the same `buildTokenPayload` a human's uses. `Bearer` passes the
   CSRF middleware, so `/api` is fine — unlike the HMAC-signed push receiver,
   which is why that one lives under `/public`.
2. **No refresh.** The agent re-exchanges against the credential it already
   holds. Nothing new is stored.
3. **The revocation write.** The read side is live —
   `findAgentByTokenHash` filters `WHERE revoked_at IS NULL` on every agent
   request — so this is an endpoint and a console button, not a system.
   Suspending a principal must fail every exchange, whichever plane issued the
   credential.
4. **kaambaan's auth gains a branch**, and it is the riskiest change in the
   program: `resolveHubUser` returns a `UserPrincipal`, and an agent-kind token
   must resolve to an `AgentPrincipal` instead — on the path every claim takes.
   **Capabilities are not in the claim** (`2026-08-15-a-grant-names-an-agent-per-plane`
   calls that a trap: two vocabularies, one word). The token names the
   principal; kaambaan looks up its own agent row for capabilities.

## 4. C — the plane

**Gates, in order:**

1. **agentpod#333** — Better Auth 1.6.26 hub / 1.4.6 console. Blocks C outright;
   now just an upgrade.
2. **The spike** (§5). It runs *first of everything*, not merely before C — its
   findings belong in the plan rather than in a surprise during the cutover —
   but C is the slice that cannot start until it has answered.

**Then:** stand up Better Auth with `jwt` + `admin`. **Not `organization`** — it
ships a second org model beside `principals`, which is MT-1's mistake relocated.
It is enabled when grant-list length argues for Teams.

Move `user`, `session`, `account`, `verification`, `jwks` and the three
principal tables. **Re-seed by script, then delete the tables from the hub.** One
user, ~14 agent principals, a handful of grants. No dual-run.

`tenants` stays in each product. `tenants.external_source = 'org-plane'` finally
carries the org id it was built for on 2026-08-14.

**The constraint C must satisfy, and it should be a test:** everything needed to
authorize a request is in the claim. No synchronous call to the plane on any
authorization path — `2026-08-13` is absolute that enforcement is local and the
token is the carrier, *"explicitly not a policy-service call in the hot path."*

**The exception, named in the decision:** resolving an inbound Matrix sender to
a principal is not a token path and is not blunted by offline verification.
Approvals will depend on the plane being up.

## 5. The spike — first, before anything is written into the plan

Two probes, both cheap, both gating:

1. **Rotate a `jwt` signing key end to end.** Untested, and it is the only
   revocation lever a JWT has: verification is offline, so *"the expiry IS the
   revocation SLA"* and a key that cannot rotate cleanly fails silently.
2. **Can tuwunel's `m.login.token` be driven by an external issuer?** The live
   server advertises `{"type":"m.login.token","get_login_token":true}`. If yes,
   the Organization plane authenticates a human and mints a Matrix login token —
   no OIDC, no MAS, no second password store, and the last identity silo closes.
   If no, Matrix keeps its own credential for humans and
   `principal_identities` stays the join, which already works.

Findings land here before the plan is written, the way
`2026-08-16-tuwunel-appservice-spike-findings.md` preceded the appservice design.

## 6. Tests

**Contract.** Fixture round-trip in each repo — the mechanism already keeping
five hand-written Go mirrors of zod schemas honest, aimed across a repo boundary.

**A.** A grant naming a principal authorizes that agent on both planes; an
unrecognised id is ignored, never denied; a station with no principal is
dispatchable by nobody; an agent's mxid survives a station change; the room
migration is idempotent and leaves `m.direct` correct.

**B.** An expired agent token re-exchanges; a suspended principal cannot
exchange; a revoked credential cannot exchange; an agent token resolves to an
`AgentPrincipal` on kaambaan and to nothing on a human-only route.

**C.** No authorization path calls the plane — asserted, not assumed. A plane
outage degrades sign-in and approvals and nothing else.

**The exit test.** A gate reaches a phone, is approved, and the board records the
human — with the Organization plane holding the identity, the agent's mxid
derived from its principal, and the grant naming one id. That is the 2026-08-30
exit test again, over the new spine. If it passes unchanged, the extraction was
honest.

## 7. Explicitly not in this program

- **Teams, Roles, Objectives.** The differentiated part of this plane and
  hypotheses one operator cannot validate. The trigger is grant-list length.
- **MAS.** Not deferred — out. See the decision.
- **Many:1 org→fleet.** Four triggers named in
  `2026-08-15-tenancy-is-local-and-mapped`; none has fired.
- **Retiring `kbn_`.** It is kaambaan's native credential, permanently.
