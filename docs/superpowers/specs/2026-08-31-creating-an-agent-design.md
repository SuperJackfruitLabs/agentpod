# Creating an agent — implementation design

**Date:** 2026-08-31
**Status:** Designed, unbuilt.
**Replaces slice C** of `docs/superpowers/specs/2026-08-30-organization-plane-design.md` §4.
**Agreements it serves:** `charter → decisions/2026-08-30-an-agent-is-a-principal.md`,
whose §"Where agent principals come from" says creating an agent is *"a deliberate act,
not a side effect of a machine appearing"* — and which nothing has implemented.

---

## 1. Why slice C was reshaped

§4 said: clear two gates, then extract the Organization plane into its own Better Auth
deployable. **Both gates cleared themselves, and clearing them dissolved the slice.**

- **agentpod#333 (Better Auth version skew) is stale, not open.** `pnpm-lock.yaml`
  resolves a single `better-auth@1.6.28` and both `package.json` files declare `^1.6.28`.
  The 1.6.26 / 1.4.6 skew the issue describes no longer exists.
- **`oidc-provider` has no consumer anywhere in the suite.** It was in the plan for MAS
  to delegate to, and `decisions/2026-08-30-matrix-identity-without-mas.md` removed MAS.

So extraction now means standing up *exactly the configuration the hub already runs* —
`bearer`, `admin`, `jwt`, `customSession` — in a second process. A relocation, not a
construction, buying no function on the day it lands.

**And it does not decompose cleanly yet.** `buildTokenPayload` reads `principals` and
`principal_grants`; the station exchange reads `stations.principal_id`. Extraction puts
those on opposite sides of a process boundary, so either the hub calls the plane inside
every mint — every agent, every five minutes, plus every gate approval, which
`decisions/2026-08-13-ecosystem-identity.md` forbids as *"a policy-service call in the
hot path"* — or the plane takes ownership of station data, which the ownership map
forbids from the other direction.

**Meanwhile slices A and B do not work without manual SQL.** An agent principal exists
only if someone runs a seed script; `agents.external_id` only if someone writes a row by
hand. This document builds what both slices deferred, twice. Extraction stays a URL
change, which is what every decision was shaped to keep it.

## 2. The shape

```
adoption            →  station with principal_id NULL      (already true)
console shows it    →  "unassigned", not merely healthy    NEW  §4
one click           →  create agent + assign               NEW  §3
reassign            →  the agent moves; room follows       NEW  §6
kaambaan links it   →  agents.external_id                  NEW  §5
kaambaan revokes    →  the button slice B never built      NEW  §5
```

## 3. Creating and assigning — agentpod

An agent is a `principals` row, `kind = 'agent'`, with an **immutable** `handle` (its
Matrix address derives from it) and a mutable `display_name`. Three acts:

- **create** — writes `principals`. Handle pre-filled from the station key when created
  in a station's context, and validated: it becomes an mxid localpart and cannot change.
- **assign** — writes `stations.principal_id`. The station becomes dispatchable.
- **reassign** — §6.

Endpoints under `/api/admin`, guarded by `authMiddleware` then `adminMiddleware` like
everything else there. The console surfaces them from the existing `/agents` page and
from the station view.

**Adoption is not changed.** It continues to leave `principal_id` null. That was the
operator's choice between three options, and it keeps creating an agent deliberate while
making the common case one click.

## 4. Making "unassigned" visible

The operational reason this slice exists. A station with no occupying principal is
**dispatchable by nobody** — correct behaviour — and today it is invisible:
`gate-sweep.ts` counts only `status === "sent"`, so a fleet-wide refusal produces no
error line and the console shows healthy stations.

That invisibility is why `estate/runbooks/deploy-the-organization-plane.md` needs §5 and
§6 as remembered manual steps. Make the state visible and the runbook step becomes a
state you can see.

## 5. kaambaan — the mapping, and the button slice B never built

Both go on the agent list already in `apps/web/src/lib/components/BoardScreen.svelte`,
which creates agents and mints their `kbn_` tokens today.

- **Link to a suite principal** — sets `external_id` / `external_source = 'org-plane'`.
  This is what lets `resolveHubAgent` resolve slice B's agent-kind hub token to a local
  agent. `setAgentExternalMapping` exists in `db/catalog.ts` and has no caller.
- **Revoke a token.** Slice B built `revokeAgentToken` and its route; the spec asked for
  *"an endpoint and a console button"* and **the button was never built**. The lever
  `2026-08-13` Decision 3 named as kaambaan's specific weakness is reachable only by
  curl. Give it the confirmation such a control deserves.

## 6. Reassignment, and the column with no writer

Moving an agent between stations is what the handle-derived mxid was for: the address
and the conversation survive the move.

A room is currently the **station's** — `matrix_rooms.station_id`, which `gates.ts`
(`roomForCard`, `roomAgentUser`) joins on. Under that model a moved agent inherits the
new station's room and abandons its history, which is the opposite of the point.

So the room becomes the **agent's**. `matrix_rooms.principal_id` was added by slice A for
exactly this and left with **no writer** — recorded as finding I2 in that slice's final
review, alongside two comments that falsely claim something backfills it. This closes it.

- Reassignment writes `matrix_rooms.principal_id`.
- The gate path resolves card → dispatch → station → principal → room.
- **`station_id` stays.** Ruling 4 of slice A: the reconciliation sweep deployed on infra
  joins on it, and dropping it inside this slice would break the approvals chain that is
  its own exit test.
- The two false comments are corrected.

## 7. The rotation spike — first

Nothing has ever rotated a `jwt` signing key end to end. Verification is offline, so
*"the expiry IS the revocation SLA"* and a key that cannot rotate cleanly is the only
revocation lever the suite has, failing silently.

Rotate one. Confirm the old key keeps verifying its outstanding tokens, the new key is
published in JWKS and accepted by kaambaan, and nothing signs with the retired key
afterwards. Findings land here, the way
`2026-08-16-tuwunel-appservice-spike-findings.md` preceded the appservice design.

It goes first because it is cheap and because a broken rotation changes what extraction
costs — before anything else depends on the issuer.

## 8. Tests

Postgres is available; **every suite runs twice without resetting the database.** A
fixture that only passes once is the defect this project has already lost a day to.

- Creating an agent with a taken handle is refused; a handle is immutable once set.
- Assigning makes a station dispatchable; unassigning makes it dispatchable by nobody.
- Reassigning moves the room: the same room id, the same history, a new occupant.
- kaambaan: linking a principal makes `resolveHubAgent` resolve that agent; revoking a
  token makes the **next request** with it fail, not merely a column change.
- **The exit test:** adopt a station, create an agent for it in one action, and watch a
  gate reach that agent's room — with no SQL run by hand at any point. That is the thing
  slices A and B cannot do today.

## 9. Explicitly not in this slice

- **Extracting the plane.** Deferred deliberately; still a URL change.
- **Teams, Roles, Objectives.** Product hypotheses one operator cannot validate. The
  trigger remains grant-list length.
- **Retiring `kbn_`.** kaambaan's permanent native credential.
- **A second organisation.** `2026-08-15-tenancy-is-local-and-mapped` names four
  triggers; none has fired.
