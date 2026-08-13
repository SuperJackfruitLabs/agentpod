# Ecosystem identity — decisions

**Status:** accepted 2026-08-13.
**Scope:** AgentPod, kaambaan, supermessage, and the unbuilt Organization/Matrix layers.
**Supersedes in part:** the Identity/Authz assumptions in `synthetic_organization_platform_strategy` (12 Aug 2026), and the shape of MT-1 (#145) in this repo.

This records four decisions taken in conversation, the evidence behind them, and what
they change. Two of them contradict what is currently written down, which is the reason
this file exists: five strategy claims were found to have been written from documentation
rather than code on 2026-08-13 alone, and a decision nobody wrote down is the next one.

---

## Where the three products actually stood, 2026-08-13

Established by reading the code, not the docs. Where docs and code disagreed, the code won.

| | AgentPod | kaambaan | supermessage |
|---|---|---|---|
| Runtime | Bun + Hono + Drizzle/Postgres | Cloudflare Worker + D1 + Durable Objects | Tauri + Rust, a desktop client |
| Auth library | Better Auth | **none** — ~250 lines of hand-rolled Web Crypto | matrix-rust-sdk |
| Human auth | Better Auth session | custom HMAC cookie (not a JWT), GitHub OAuth as client | `m.login.password` to Synapse |
| Service auth | one static `API_TOKEN` → one `DEFAULT_USER_ID` | impersonate an *agent*: opaque `kbn_` bearer, non-expiring | none — it is a client, not a service |
| Tenancy | **none** — no `organizationId` anywhere | **structural** — `tenant_id` predicates + `${tenantId}:${boardId}` DO naming | per-homeserver |
| Authorization | none | scopes stored and **discarded**; roles written once, read never | none |

Three consequences worth keeping in view:

- **No auth library can be shared.** Bun/Postgres, Workers/D1 and Rust/Tauri have no
  common runtime. The only shareable thing is a **protocol**, which argues for signed
  tokens with published keys over kaambaan's current opaque-hash-lookup — that model
  validates by a database round-trip on a hash it stored itself, and structurally cannot
  verify a token minted anywhere else.
- **kaambaan's MCP surface is not a precedent.** It answers 401 with
  `WWW-Authenticate` and serves RFC 9728 protected-resource metadata, but there is no
  authorization server behind it: no `/authorize`, no `/token`, no PKCE, no audience
  validation. A compliant client follows the challenge and dead-ends. Its docs claim
  otherwise. The reusable part is the *shape*, not the implementation.
- **kaambaan's tenant isolation is the strongest thing in either codebase** and is the
  pattern AgentPod lacks entirely.

---

## Decision 1 — supermessage acts only through Matrix

supermessage keeps its own Matrix identity. Actions taken there — approving a gate,
starting a run — travel as **Matrix events**, which the Application Service translates
into kaambaan or AgentPod calls. supermessage never calls suite APIs directly and holds
no suite credential.

**Why.** It keeps exactly one credential on an end-user device, and it keeps
"independent Matrix client" true rather than "works, but half the buttons don't". It also
removes an entire product from the identity problem: whatever the suite decides about
principals, supermessage needs no change.

**It is already built for this.** `src/lib/components/customEvents.ts` is a renderer
registry with zero renderers registered, whose own comment says it *"does not — and must
not — invent those schemas"*. And `id.agentpod.dev` already advertises
`m.login.application_service`, the flow an Application Service uses to act as its virtual
users. Both halves of the seam exist and are empty.

**Consequence.** The Application Service becomes the only place suite authority lives on
the chat path. Deep integration is richer rendering plus actions-as-events — not API
access.

---

## Decision 2 — when a human acts, the human is the actor

The Application Service calls kaambaan and AgentPod **on behalf of** the human, carrying
both the actor (the AS) and the subject (the human). It never substitutes its own
identity for theirs.

**Why, concretely.** `board-do.ts` enforces separation of duties: a gate decision where
`decidedBy` equals the agent that produced the work returns 403. If the AS called with a
single service credential, every gate decision in the suite would be "decided by the
bridge" — the check would quietly stop meaning anything and every approval would attribute
to one account. This is the same failure already present in run verbs, which are
authorized by lease rather than identity, so any agent token in a tenant can drive another
agent's run and have the cost metered against the original agent.

**Consequence.** The `mxid → Principal` mapping must exist and be trustworthy before the
bridge can be honest — minted by an explicit link, never inferred from a localpart or a
matching email. This makes the identity layer a **prerequisite**, not a P1 nicety.
An unlinked Matrix user in a room is a case the AS must handle explicitly.

---

## Decision 3 — agents have their own reach, not delegated reach

An agent's authority is its own, granted to it as a principal. It is **not** a projection
of whoever dispatched it.

**This contradicts the platform strategy**, which asks for *"short-lived tokens tied to
principal, task/run and scope"* and delegation-shaped authority. The contradiction is
deliberate.

**Why.** An agent can then hold reach no human has — a deploy agent with production
credentials nobody carries, a scanner that reads every repository while no individual
does. Autonomy stops being a shadow of a person, which is the honest model if agents are
org members rather than tools. It also survives the human: a delegated run dies when a
session expires or someone leaves; an agent with its own reach keeps working, which is
what anything scheduled requires.

**What it costs, and these are not hypothetical.**

1. **Escalation becomes a path rather than an impossibility.** If I may dispatch an agent
   whose reach exceeds mine, I have that reach by proxy. Delegation makes this
   structurally impossible; standing authority makes it a policy question.
2. **Revocation loses its natural handle.** There is no "revoke the human and everything
   downstream withers". Agent grants must be revoked directly — and kaambaan is weakest
   exactly here: `agent_tokens.revoked_at` exists and **nothing writes to it**; the only
   real revocation is deleting the agent, which breaks its metering history.
3. **Attribution must carry both** the agent's authority and who dispatched it, or "the
   deploy agent did it" hides "because a human asked at 3am". Cheap in the token and the
   run row from the start; expensive to retrofit.

---

## Decision 4 — the control pair, and where it lives

Because of Decision 3, two checks carry the weight that delegation would otherwise have
carried:

1. **Who may dispatch which agent.**
2. **Who may grant an agent its reach.**

Both are required. Dispatch control alone is decorative: anyone who can register an agent
and grant it production credentials does not need permission to dispatch anything — they
build the agent they want.

**Both are owned by the Organization plane**, whose ownership already includes
*"Principal, Team, Role, objective, identity mappings, authority"*. Not the work plane:
a check living in kaambaan would only cover board-driven work, and the most common path
today — provisioning straight at AgentPod over its API or console — would be unguarded.
A control with a hole that shape is not a control.

**Enforcement is local; the token is the carrier.** The Organization plane is
authoritative for the grant; the claim rides in the token the caller already presents;
AgentPod checks it before dispatching and kaambaan checks it before routing a claim.
Neither plane keeps its own copy of the rule, and both **fail closed** when the claim is
absent. This is deliberately not a policy-service call in the hot path — *"do not spawn
seventeen services"*.

**Interim, so this does not block on an unbuilt plane.** The grant may live as static
configuration in each plane, provided it is the **same shape** as the eventual claim, so
adopting a real issuer is a data move rather than a redesign. This mirrors the pattern
already blessed for credentials: *"make static secret injection explicit and auditable
until dynamic issuance exists."*

**Be clear about what this is.** Neither product enforces any authorization today. This
is not harmonising two systems — it is introducing the first real authorization check in
the suite. Keep it to one claim checked at two boundaries, rather than arriving with a
policy engine.

---

## What follows from these, and what does not

**Reach is expressed as capability, not credential.** Namespaced ids
(`github.pull_request.review`), each carrying provider implementations, risk
classification, required credential and policy metadata. Reach is then a composition:
capability (what kind of action) × relationship (on which objects) × policy (under what
conditions). Credential requirement is *metadata on the capability*, which is what lets a
broker issue something scoped rather than hand out a stored secret.

**Two engines, not one, and neither is its own layer.** Relationship authorization
(OpenFGA/SpiceDB) answers "can this principal reach this object". Policy evaluation
(OPA/Cedar) answers "is this allowed under these conditions". The runtime keeps the final
veto because it is closest to the ground truth, and a denial must be reported back as
structured work activity, never silently dropped.

**Availability is never inferred from a declaration.** The catalog owns what a capability
*means*; AgentPod owns what a station can *do*; the join happens at query time. This is
not a principle but a scar: `acp` was advertised because two binaries resolved, and
produced a Chat tab that 502s on every provisioned Pi station; the posture scanner graded
machines "A" without opening the files it claimed to check.

**MT-1 (#145) changes shape.** As written it mints an org model inside AgentPod via the
Better Auth organization plugin. The Organization plane owns principals and identity
mappings; AgentPod should consume them and keep only scoping on its own rows. Building it
as specified means migrating it later.

### Not decided here

- **Who issues tokens** — the Organization plane, AgentPod's hub, or
  matrix-authentication-service. Note MAS is required for OIDC on Matrix anyway, and
  adopting it **breaks supermessage the day it lands**: supermessage requests no refresh
  token and has no re-auth-on-401 path, which works only because Synapse tokens are
  long-lived. That work is coupled to the IdP decision, not after it.
- **Tenancy.** kaambaan pins every principal to exactly one tenant at the storage layer;
  AgentPod has no tenant concept at all. Unifying means retrofitting tenancy into AgentPod
  or accepting a mapping table. This is the largest remaining modelling decision and
  should be made deliberately rather than discovered during bridge work.
- **How two repos share one contract.** Principal ids, the run join key and event schemas
  must mean the same thing in a Bun/Postgres hub and a Workers/D1 board, in separate repos
  with separate release cadences. A published package couples two deploy pipelines; this
  codebase has already kept five hand-written Go mirrors of zod schemas honest with
  golden-fixture round-trip tests and no drift, which is evidence that a shared fixture
  suite may be enough.

### Constraint worth remembering

supermessage bans GPL/AGPL/LGPL runtime dependencies. Any shared component that reaches
that repo must be MIT/Apache-2.0/BSD, or MPL-2.0 used unmodified.
