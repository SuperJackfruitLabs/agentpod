# Making the Organization layer issuer-driven

**Status:** Plan, 2026-08-15. Everything here is unbuilt unless marked.
**Spans:** AgentPod (hub, console), kaambaan (api, board DO), charter.
**Goal:** the control pair enforced in both planes from **grants the issuer
knows about**, not from static configuration in each deployment.

## Where we start

Built, live and proven:

- **The issuer.** `/api/auth/token` (EdDSA, 5m) and `/api/auth/jwks`, verified
  offline by kaambaan at the edge with the issuer killed (#331, #332, kaambaan#39).
- **Identity.** `principal_identities` + `resolveMatrixId` — a Matrix id resolves
  to a principal or a station in production (#335, #336).
- **Half of one half of the pair.** `mayDispatch` enforced at AgentPod's dispatch
  choke point from `CONTROL_PAIR_GRANTS` env JSON (#337), with denials permanent
  and reported as work activity (#338).
- **The record kaambaan needs.** `cards.queued_by`, preserved across automatic
  transitions, pinned onto runs (kaambaan#41).

Two decisions govern the rest: the control pair is owned by the Organization
plane and rides in the token
(`charter/decisions/2026-08-13-ecosystem-identity.md`, Decision 4), and a grant
names an agent per plane
(`charter/decisions/2026-08-15-a-grant-names-an-agent-per-plane.md`).

## The one idea this plan turns on

**Authority is captured at the moment of the act, not looked up later.**

An agent claims work minutes or hours after a human queued it, and the human is
not present. So kaambaan cannot ask "may this caller dispatch?" at claim time —
there is no caller to ask about. It must instead have recorded, at queue time,
**what the queuer was permitted to do**, and check the claiming agent against
that.

That is what makes the token the carrier rather than a lookup: the claim arrives
with the human's action, is written next to `queued_by`, and outlives the token
that brought it.

It also gives the right answer to the awkward case. A card queued **without** an
authorising token has no recorded grant, and under enforcement it is not
dispatchable — because nobody with authority ever asked for it to run.

---

## The work

### 1. Grants become data — `principal_grants` (hub)

- [x] Table: `principal_id`, `may_dispatch text[]`, `may_grant_reach boolean`,
      timestamps. One row per principal; absence means no grant.
- [x] Values are namespaced per the decision (`agentpod:…`, `kaambaan:…`).
- [x] Service: read, upsert, delete. Read is the hot path — cache is not needed
      at this size, and a stale grant is worse than a query.
- [x] **`CONTROL_PAIR_GRANTS` becomes a seed, not the source.** ~~Kept only to
      bootstrap the first grant into an empty table, and refused thereafter~~ —
      **changed in the doing: it is not read at all.** A seeding path would be a
      second source of authority that exists only on the day nobody is watching
      (an empty table is the state a fresh deployment and a failed migration
      share). The var now draws a boot warning saying it is ignored, which is the
      whole of its remaining job.

### 2. The issuer emits the pair (hub)

- [x] `buildTokenPayload` reads `principal_grants` and emits `mayDispatch` /
      `mayGrantReach` — the names already reserved in the fixture.
- [x] The fixture moves them from `reserved` to `issued`, with the namespace
      grammar and the "unknown namespace is ignored" rule pinned, plus reject
      cases.
- [x] A principal with **no grant row** gets the claims present and empty
      (`[]`, `false`) rather than absent: a consumer must be able to tell "no
      permissions" from "an issuer that does not speak this yet".

### 3. AgentPod enforces from the store (hub)

- [x] `mayDispatch` reads `principal_grants`, not the environment.
- [x] Values matched with the `agentpod:` prefix; other namespaces ignored.
- [ ] **STILL OPEN — the only item of this plan that is.** `mayGrantReach` is
      issued in every token, stored, and editable in the console, and it is
      **enforced nowhere**. That makes the dispatch half decorative in the way
      this plan itself warned about: anyone who can hand an agent production
      credentials does not need permission to dispatch it. It needs
      an answer to a question this plan cannot assume: *what is "granting an agent
      its reach" in AgentPod?* Candidates, to be decided in the PR that does it:
      minting an enrollment token, provisioning a runtime with credentials, and
      editing node config (#237/#238). Whichever it is, the check goes at the
      choke point those share.

### 4. kaambaan accepts an authorising token on the routes that queue (api)

- [x] Card **create** and **move** accept a hub JWT, in addition to the session
      cookie they take today (extends kaambaan#39, which reached one read route).
- [x] The verified claim's `mayDispatch` is recorded on the card next to
      `queued_by` — `cards.queued_grant`.
- [x] Recorded **as granted at that moment**. A later change to the grant does
      not retroactively authorise or deauthorise work already queued, which is
      what "authority at the time of the act" means.

### 5. kaambaan enforces at claim (board DO)

- [x] At claim, the claiming agent must match the card's recorded
      `queued_grant`, on the `kaambaan:` namespace.
- [x] A card with **no recorded grant** is not claimable under enforcement.
- [x] The refusal is **structured work activity**, never a silent skip — the same
      requirement AgentPod's side already meets (#338). A card nobody may run
      must say so, or it looks like an idle board.
- [x] Enforcement is opt-in per deployment while grants are being populated, and
      the flag's absence is visible at boot.

### 6. Grants are manageable (hub + console)

- [x] Admin API: read and write a principal's grant.
- [x] Console: see who may dispatch what, and change it. Without this the layer
      is operable only by someone with database access, which is not a control
      an organisation can actually use.

### 7. Retire the interim

- [x] ~~`CONTROL_PAIR_GRANTS` refuses to boot when `principal_grants` is
      populated, naming the conflict.~~ **Warns instead, deliberately.** Refusing
      to boot makes a stale line in an env file an outage of the whole hub, on a
      variable nothing reads any more — the cure would be worse than the disease
      it treats. The warning names the variable and says it is ignored.
- [x] `docs/DEPLOYMENT.md` and kaambaan's docs describe the store, not the env
      var.

---

## Testing, against production

Production is the test environment for this work, by the operator's decision.
That raises rather than lowers the bar for what counts as verified:

- [x] A token minted by the live hub carries a real grant.
- [x] A dispatch the grant permits succeeds; one it does not is **refused, and
      the refusal is visible on the board** rather than inferred from silence.
- [x] A card queued with a token runs; a card queued without one does not, and
      says why.
- [x] Changing a grant changes the next decision and **not** one already queued.
- [x] The 14 Hermes stations keep working throughout — enforcement is switched on
      after grants exist, never before.

## What this plan will not do

- **Move the issuer out of the hub.** It stays where it is; the contract already
  survives the move.
- **Build a policy engine.** One claim, two boundaries, both failing closed.
- **Invent a canonical agent id.** The per-plane namespaces are the decided
  interim, and their end is a data move.
