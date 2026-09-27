# Which hub routes an agent could be let onto, and which never

**Date:** 2026-09-11
**Status:** Audit. No code changes.
**Follows:** agentpod#414 (A′ — the hub accepts its own token, from a human only),
`docs/superpowers/specs/2026-09-04-apn-modes-design.md`

## Why this exists

A′ made `authMiddleware` accept a hub-issued token and **refuse any non-human principal there**,
with a 403, before a route sees it. That was the smaller first step: it unblocked the CLI without
letting an agent reach anything it could not reach before.

The debt it deferred is this audit. **Nothing below is currently exposed** — an agent-kind token
is refused at the middleware today. The question here is narrower and worth answering before the
MCP server wants agent access: *if a route were opened to an agent-kind principal, what would
that agent be able to do?*

## What is in scope

Only what sits behind `authMiddleware`. Three route groups are mounted **before** it and
authenticate differently — they are out of scope and were checked only far enough to confirm
that:

| mounted before | authenticates as |
|---|---|
| `authorizeRoutes` | the hub's own session cookie (it is the sign-in door) |
| `stationTokenRoutes` | a node, by `<nodeId>:<nodeSecret>` |
| `stationMatrixCredentialRoutes` | a node, same |
| `dispatchableRoutes` | a hub token it verifies itself, and it already refuses agent-kind |

That leaves **21 modules, ~122 handlers** behind `authMiddleware`.

## Method

For each module: what a caller can do, whether it calls a reach or capability guard, and what an
**agent-kind** principal reaching it would mean. The classification that matters is not "read vs
write" — it is **whether the act changes what an agent is, or lets one agent act as another**.

## Already gated, and correctly

These call `requireGrantReach` / `requireIssueCredentials` / `gateCapability`, and the
`REACH_BEARING` map in `services/grant-reach.ts` is exhaustive by type — adding a capability to
the contract enum stops the build until somebody classifies it.

| module | guard calls | covers |
|---|---|---|
| `station-writes` | 14 | `fs.write` — one request writes a credential file |
| `station-terminal` | 4 | `terminal` — arbitrary shell as the agent's user |
| `station-cleanup` | 4 | `cleanup` — `apply` deletes; `plan` is a read, split on effect |
| `station-changeset` | 3 | `changeset` |
| `station-lifecycle` | 2 | `lifecycle` |
| `station-matrix` | 3 | credential issuance |
| `enrollment-tokens` | 4 | minting a node's way in |
| `admin` | `use("*", adminMiddleware)` | all 18 routes |

**No action.** These are the routes that were most obviously dangerous and they were guarded
first, which is the right order to have done it in.

## Never, for an agent — these change what an agent IS

`charter → decisions/2026-08-15-granting-reach-is-changing-an-agent.md` states the principle,
and its own words are the test: *"anyone who can register an agent and grant it production
credentials does not need permission to dispatch anything — they build the agent they want."*

| route | what an agent could do |
|---|---|
| `POST /api/agents` | **create a principal.** The hole the decision names, exactly |
| `PUT /api/stations/:id/agent` | put a principal in a station — decide who runs where |
| `DELETE /api/stations/:id/agent` | evict the occupant of any station |
| `DELETE /api/stations/:stationId` | delete a station |
| `POST /api/runtimes`, `DELETE /api/runtimes/:id` | provision and destroy compute |
| `POST /api/runtimes/:id/{start,stop}` | control compute it does not own |
| `POST /api/nodes/update-all`, `POST /api/nodes/:id/update` | push a binary update to the fleet |
| `PUT /api/nodes/:nodeId/purpose`, `PUT /api/stations/:id/purpose` | redefine what a machine is for |
| `POST /api/missions` | create a mission |
| `POST /api/stations/:id/matrix/say` | **speak in Matrix as another station** |

That last one deserves its own line. `station-say` exists so a station can announce something in
its own room without an ACP session — correct, and the reason bridge mode reached parity with a
harness's own client. But an agent-kind caller reaching it speaks **as a station it does not
occupy**, into a room humans read and answer. That is impersonation inside the one channel the
approvals chain runs through, and no capability in `REACH_BEARING` describes it.

**None of these should ever be opened to an agent principal.** They are operator acts. If an
agent ever legitimately needs one, it needs a human to perform it — which is what
`requireIssueCredentials` already models for credentials.

## Reads that are still reconnaissance

`fleet-dispatchable.ts` already refuses agent-kind tokens and says why: *"`mayDispatch` is the
authority to ASK an agent to work; it was never the authority to find out what else exists, and
an agent that enumerates its siblings is an agent doing reconnaissance."*

The same argument applies unchanged to:

| route | what it enumerates |
|---|---|
| `GET /api/nodes` | every machine in the fleet |
| `GET /api/fleet/agents`, `/api/fleet/stats` | every agent, and fleet totals |
| `GET /api/activity` | fleet-wide activity |
| `GET /api/nodes/:nodeId/detected`, `/nodes/:nodeId/stations` | another node's stations |
| `GET /api/stations/:id/health`, `/logs` | another station's health and logs |
| `GET /api/stations/:id/acp/sessions`, `DELETE /api/acp/sessions/:id` | another agent's sessions — and killing one |

A read is not automatically safe. These are safe for a human operating a fleet they own, and are
lateral movement for an agent that has been given one station.

## The one plausible candidate, and what it would need

The MCP server's real motivation is an agent being able to **diagnose itself**: read its own
station's health, its own logs, its own ACP transcript. Every route above is phrased
station-by-id, and an agent holding a hub token has `sub` — its own principal.

So the shape a safe opening would take is not "let agents call `GET /stations/:id/logs`". It is
**a self-scoped route**: one that derives the station from the caller's principal rather than
taking an id, so there is no id to tamper with. `GET /api/me/station/logs`, not
`GET /api/stations/:id/logs` with an ownership check bolted on afterwards.

The difference matters because an ownership check is a thing a future route can forget, and a
route with no id parameter cannot be pointed at somebody else by construction. That is the same
reasoning that put `tenantScopedSelect` in kaambaan and `REACH_BEARING`'s exhaustive record in
the hub: make the wrong thing impossible to express, not merely refused.

**Not designed here.** This audit's job is to say that the existing routes are the wrong ones to
open, and why.

## Findings, in order of what they cost to act on

1. **Nothing is exposed today.** A′'s middleware refusal is doing the work, and the deferral was
   the right call.
2. **`station-say` has no capability describing it.** It is reach-bearing in effect — speaking as
   a station in a room humans answer — and `REACH_BEARING` does not mention it because it is not
   a station *capability* at all. Worth a decision: either it gains one, or the record should say
   why it does not need one.
3. **No route should be opened by relaxing `principalKind`.** The self-scoped shape above is the
   only opening this audit would endorse, and it is new routes rather than loosened ones.
4. **The middleware refusal should stay the default** even after such routes exist: a route opts
   in, rather than the middleware opting out.

## What this audit did not do

- It did not read every handler line by line. It classified by what each route's *act* is, which
  is what determines whether an agent may hold it; a handler bug inside an operator-only route is
  a different review.
- It did not check tenancy scoping. One tenant exists (`BOOTSTRAP_TENANT_ID`), so cross-tenant
  reach is not yet a live question — and `charter → 2026-08-15-tenancy-is-local-and-mapped` is
  where it will be answered when it is.
- It did not audit `acp-proxy` or the WebSocket upgrade paths beyond their mount point.
