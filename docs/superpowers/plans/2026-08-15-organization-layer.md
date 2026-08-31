# Building the Organization layer

> **Superseded 2026-08-30. Nothing below is edited.**
>
> This plan is built on the supermessage/MAS coupling — *"that coupling is real
> and unchanged"* — and it is not. matrix-authentication-service is not part of
> this suite: the premise was a fact about Synapse, replaced by tuwunel on
> 2026-08-16, the day after the decision that recorded it. See
> `charter → decisions/2026-08-30-matrix-identity-without-mas.md`.
>
> The Organization plane's design now lives in
> `docs/superpowers/specs/2026-08-30-organization-plane-design.md`, under two
> charter decisions — an agent is a principal, and Matrix identity without MAS —
> and under a frame this plan predates: nothing is in production, so the work
> builds destinations rather than migration paths.

**Status:** Written 2026-08-15 as a plan; **most of it was then built the same
day**, which is why this header exists. The phase bodies below are left as
written — they are the reasoning, and rewriting them to match the outcome would
destroy the only record of what was expected versus what happened.
**Spans:** AgentPod, kaambaan, supermessage, charter.
**Governed by:** `charter/decisions/2026-08-13-ecosystem-identity.md`, which this
plan implements rather than revisits.

## Where it actually got to, 2026-08-15

| Phase | State | Landed in |
|---|---|---|
| **0** — record what shipped, re-scope what didn't | **done** | `charter` tenancy decision; #145/#146 annotated as superseded |
| **1** — principal model as a contract | **done** | `fixtures/ecosystem-identity/token_claims.json` (#332) |
| **2** — the mappings that unblock other work | **done, live** | #335, #336 — and linked in production |
| **3** — the control pair, from static config | **half done** | #337 (AgentPod). kaambaan's half is open |
| **4** — the issuer, and a real plane | **issuer done** | #331 spike → #332 issuer → kaambaan#39 consumer |

**Phase 4 arrived before Phases 2 and 3, and that was not the plan.** It was the
right accident: the issuer is what everything else attaches to, so the control
pair now has a real token to ride in rather than a hypothetical one. The plan
said "deliberately last, and gated on a decision nobody has made" — the decision
got made (`charter/decisions/2026-08-15-one-issuer-and-offline-verification.md`),
gated on a spike that ran, so the reasoning held even though the order did not.

**What the plan got wrong, worth keeping:** it assumed Phase 4 would be blocked
on the supermessage/MAS coupling. That coupling is real and unchanged, but it
only binds **matrix-authentication-service**, not issuance in general — the hub
could become the issuer without touching supermessage at all. The plan treated
one dependency as if it gated the whole phase.

**Still open from Phase 3:** kaambaan checks the claim before routing a claim,
and a denial is reported as structured work activity rather than an exception.
Neither belongs in the change that introduced the check.

**Phase 4's remaining half** — whether the issuer moves out of the hub, and who
it becomes — is untouched and still gated as written.

## Start from what already exists

Three things are already true, and a plan that ignores them would rebuild them.

**Both planes already have a local isolation boundary.** AgentPod shipped
`tenants` (`fleet_<20 hex>`, migration 0036) and kaambaan shipped the symmetric
half (migration 0002) on 2026-08-14. Each carries an **optional external
mapping** — `external_id` + `external_source`, both-or-neither, enforced by a
CHECK in both databases — for "the same real organisation is also known
somewhere else". `NULL` is the normal, complete state: both products must run
standalone.

**That is the socket this layer plugs into.** When the Organization plane mints
canonical ids, both products map onto them by writing `external_source =
'org-plane'` and an id. It is a data move, not a schema change. The hard part
was done on 14 August.

**A precedent exists for sharing a contract across repos.**
`fixtures/ecosystem-identity/` already pins the id grammar, the run join key and
the card prompt across two repos with separate release cadences, and five
hand-written Go mirrors of zod schemas have stayed honest against golden
fixtures with no drift.

**And two AgentPod issues are now wrong.** #145 (MT-1) proposes minting an org
model inside AgentPod via the Better Auth organization plugin, and #146 (MT-2)
proposes `organizationId` on every table. The 2026-08-13 decision already said
MT-1 "changes shape"; the 2026-08-14 tenancy work then shipped a better one.
Building #145 as written means migrating it away later.

## What the Organization plane actually owns

From the decision, and nothing beyond it:

- **Principal, Team, Role, objective, authority.** Who exists, how they are
  grouped, what they are responsible for.
- **Identity mappings.** The one table that says a principal is *also*
  `@olivia:id.agentpod.dev`, *also* a Better Auth user in the hub, *also* a
  kaambaan principal, *also* the agent on a given station.
- **The control pair**, which carries the weight that per-run delegation would
  otherwise have carried, because agents hold their own reach:
  1. who may **dispatch** which agent, and
  2. who may **grant** an agent its reach.

It does **not** own enforcement. The claim rides in the token the caller already
presents; AgentPod checks it before dispatching, kaambaan checks it before
routing a claim, and both **fail closed** when the claim is absent. One claim,
checked at two boundaries — not a policy service in the hot path.

## The strategy: contract first, service last

The decision explicitly blesses an interim where the grant lives as **static
configuration in each plane, provided it is the same shape as the eventual
claim**. That is the whole plan's leverage: *the first real authorization check
in this suite does not require a fifth product to exist.*

So the order is: agree the shapes → map the identities → enforce the pair from
static config → and only then decide who issues tokens. Each phase is useful
alone, and none of them strands work if the next is delayed.

---

## Phase 0 — Record what shipped, and re-scope what didn't

Small, and it stops the next person building the wrong thing.

- [ ] **Write the tenancy decision into charter.** Both products shipped it, and
      it exists only as a line in two strategy-document headers. The decision
      that "neither plane owns the organisation; each keeps a local boundary and
      an optional mapping" is the load-bearing one for everything below, and it
      is currently unrecorded.
- [ ] **Re-scope #145 and #146** against the shipped shape, or close them and
      open the work this plan describes. Leaving them as written is an active
      trap: they read as approved and they contradict a later decision.
- [ ] **State the id space** for principals in `fixtures/ecosystem-identity/id_grammar.json`
      before anything mints one. `fleet_` and `tnt_` collided conceptually once
      already (#308's `run_`); a third id space with no grammar is the same
      mistake queued.

**Done when:** charter holds the tenancy decision, the two issues match reality,
and `id_grammar.json` names the principal id space.

## Phase 1 — The principal model as a contract

No service. Schemas, ids, and fixtures that two repos can both satisfy.

- [ ] `Principal` — id, kind (`human` | `agent` | `service`), display name,
      tenant/org reference. Kind matters: the whole suite exists because both
      are first-class.
- [ ] `Team`, `Role`, and membership, as far as the control pair needs and no
      further. Objectives and reporting lines are the layer's eventual job, not
      this phase's.
- [ ] **Identity mappings** — `(principal_id, system, external_id)`, where
      system ∈ {`agentpod`, `kaambaan`, `matrix`, `better-auth`}. Same
      both-or-neither discipline as the tenant mapping.
- [ ] **Golden fixtures** for all of the above, in
      `fixtures/ecosystem-identity/`, consumed by tests in both repos — the
      pattern that has already held five Go mirrors honest.

**Done when:** both repos have a test that fails if their understanding of a
principal drifts from the fixture. Nothing is deployed.

## Phase 2 — The mappings that unblock other work

This is the phase other people are waiting on.

- [ ] **`principal ↔ mxid`.** The Matrix bridge cannot attribute anything
      without it, and today's decision requires a human's approval to carry its
      sender. AgentPod already knows the station side: `stations.matrix_id` is
      populated as of 2026-08-15 (14 Hermes stations; the rest genuinely have no
      Matrix identity).
- [ ] **`principal ↔ agentpod user` and `principal ↔ kaambaan principal`**,
      recorded as external mappings on the existing tables rather than as new
      authority.
- [ ] **A resolution path** — given an mxid, which principal; given a principal,
      which station. Read-only, cached, and allowed to answer "unknown", because
      an unmapped identity must degrade rather than fail.

**Done when:** a human's Matrix id resolves to a principal in both products, and
an agent station resolves to one. **This is the item that unblocks the
Application Service bridge, approvals-from-chat, and supermessage's decision
row.**

## Phase 3 — The control pair, enforced from static config

The first real authorization check in the suite.

- [ ] **Define the claim** — one shape, carried in the token the caller already
      presents, covering both halves of the pair.
- [ ] **AgentPod checks it before dispatch**, in the path that provisions and
      starts work — including the console and API paths, not only board-driven
      work. A control that only covers kaambaan-dispatched work has a hole the
      shape of every direct provision.
- [ ] **kaambaan checks it before routing a claim.**
- [ ] **Both fail closed** when the claim is absent, and both report a denial as
      structured work activity — never a silent drop.
- [ ] The grant lives as static configuration **in the eventual claim's shape**,
      so adopting a real issuer is a data move.

**Done when:** an agent that has not been granted reach cannot be dispatched
from either product, and the denial is visible in the work record.

## Phase 4 — The issuer, and a real plane

Deliberately last, and gated on a decision nobody has made.

- [ ] **Decide who issues tokens** — the Organization plane, AgentPod's hub, or
      matrix-authentication-service. **This is coupled to supermessage**: MAS is
      required for OIDC on Matrix, and adopting it breaks supermessage the day
      it lands, because the client requests no refresh token and has no
      re-auth-on-401 path. That client work is *coupled to* the IdP decision,
      not after it.
- [ ] Only then: whether the plane becomes a service, a library, or stays a
      configuration format.

## What this plan will not do

- **Spawn a fifth product before it is needed.** Phases 0–3 deliver a working
  authorization control with no new deployable.
- **Retrofit tenancy.** It shipped, symmetric, in both products.
- **Build a policy engine.** Relationship authorization and policy evaluation
  are two engines, neither is its own layer, and the runtime keeps the final
  veto.
- **Move the fixture corpus to charter.** It should live there eventually, but
  AgentPod's test suite consumes it and a second copy drifts immediately. That
  needs a sync mechanism decided first.

## Risks

**The mapping table becomes an authority.** Identity mappings are a record of
sameness, not a grant. The moment something reads authority out of them, the
Organization plane has been built by accident in the wrong repo.

**Static config outlives its welcome.** The interim is blessed *because* it has
the eventual claim's shape. If Phase 3 ships a convenient shape instead, Phase 4
becomes a redesign.

**Availability inferred from declaration.** The scar is on the record: `acp` was
advertised because two binaries resolved. A principal that *should* map to a
station is not a station that answers.

**License constraint.** supermessage bans GPL/AGPL/LGPL at runtime. Anything
shared that reaches that repo must be MIT/Apache-2.0/BSD, or MPL-2.0 unmodified.
