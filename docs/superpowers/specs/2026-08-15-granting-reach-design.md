# Granting an agent its reach — enforcing the second half of the control pair

**Date:** 2026-08-15
**Issue:** #345
**Status:** Design, approved in conversation. Unbuilt.
**Follows:** `charter` → `decisions/2026-08-13-ecosystem-identity.md` Decision 4,
and `decisions/2026-08-15-a-grant-names-an-agent-per-plane.md`.
**Closes the last open item of:** `docs/superpowers/plans/2026-08-15-issuer-driven-organization-layer.md` §3.

## The problem

`mayGrantReach` is minted into every token, stored in `principal_grants`, and
editable in **Admin → Grants**. Nothing reads it.

That is not a missing feature, it is a hole in the one that shipped. Decision 4
states the reason plainly: *"Dispatch control alone is decorative: anyone who can
register an agent and grant it production credentials does not need permission to
dispatch anything — they build the agent they want."* A principal denied
`agentpod:*/hermes:prod-deploy` today can open a terminal on an agent they *are*
permitted to dispatch, write credentials into its workspace, and reach exactly as
far. The dispatch check refuses the front door of a building with no walls.

There is a second cost, and it is the one that made this urgent: the console now
*shows* the switch. A control on screen reads as a control in force.

## The line

**`mayDispatch` — may I ask this agent to work.
`mayGrantReach` — may I change what this agent is.**

Reading, observing and chatting stay on the dispatch side. Anything that puts
bytes into an agent's environment, runs commands as it, or brings a new machine
into the fleet moves behind the second half.

## How the two compose

`mayGrantReach` is a boolean; `mayDispatch` is a scoped list. The boolean answers
*may this person change agents at all*, the list answers *which agents are
theirs*. To act on station X a principal needs **`mayGrantReach === true` and a
`mayDispatch` value matching X**.

One scope, held in one place. Narrowing someone's dispatch narrows what they can
rewrite, which is the behaviour that needs no explaining: it would be strange to
lose the ability to talk to an agent while keeping the ability to hand it
credentials.

**Rejected: a second scoped list** (`mayGrantReachTo: string[]`). More
expressive — it would let someone rewrite a staging agent while dispatching only
production ones — and it is exactly the asymmetric-grant drift
`a-grant-names-an-agent-per-plane` warns about: two lists that must agree, where
disagreement is silent and permission starts depending on which door the work
arrived through.

### Acts that name no station

Minting an enrollment token brings a machine into the fleet. It has no station to
match a pattern against, so the composition rule above has nothing to bite on.

**A fleet-level act requires `mayGrantReach` and a dispatch value whose node half
is `*`.** You may grow a fleet only if your authority already spans it. The
alternative — the boolean alone — would let a principal scoped to one node add
machines indefinitely, which is the "register an agent" half of Decision 4's
threat restated.

## What is reach-granting

`packages/contract/src/station.ts:2` defines a closed enum of ten capabilities.
Each is classified, and because `cleanup` covers both a read and a destructive
write under one word, the check takes the capability **and** the route's effect,
firing only when both say so:

| capability | reach-bearing | routes | outcome |
|---|---|---|---|
| `fs.write` | yes | write, mkdir, move, delete | all four checked |
| `terminal` | yes | WS attach | checked |
| `cleanup` | yes | `plan` (read), `apply` (deletes) | `apply` checked, `plan` open |
| `changeset` | no | `status`, `diff` | both read |
| `lifecycle` | no | start/stop | operating an agent, not widening it |
| `acp` | no | sessions | dispatch — `mayDispatch` already guards it |
| `inventory` `health` `logs` `fs.read` | no | reads | open |

Plus one non-station site: `POST /api/enrollment-tokens`, under the fleet-wide
rule above.

**`lifecycle` on the dispatch side is a judgement call, recorded as one.**
Starting and stopping grants an agent no capability it did not have. The argument
against: restarting an agent to pick up a config someone else wrote is a
laundering path. It is weak while `fs.write` is itself guarded — whoever wrote
the config needed reach to write it.

## Where the check lives

`services/control-pair.ts`, beside `isControlPairEnforced` and
`ControlPairDenied`, so the pair stays in one file and the denial shape, the 403
and the log line come out identical to a dispatch refusal.

```ts
type Effect = "read" | "mutate";

/** Exhaustive by type: a new Capability member breaks the build until classified. */
const REACH_BEARING: Record<Capability, boolean> = { "fs.write": true, terminal: true,
  cleanup: true, changeset: false, lifecycle: false, acp: false, inventory: false,
  health: false, logs: false, "fs.read": false };

/** Station-scoped acts. Throws ControlPairDenied. */
export function requireGrantReach(
  userId: string, station: StationRef, cap: Capability, effect: Effect
): Promise<void>

/** Acts that name no station — enrollment today, the credential broker later. */
export function requireFleetGrantReach(userId: string): Promise<void>
```

The scope half is not new code: `patternMatchesStation(pattern, { nodeName,
stationKey })` in `services/grants.ts` already answers "does this grant cover this
station", and is what `acp.createSession` calls. `requireGrantReach` reuses it
verbatim, so dispatch and reach can never disagree about what a pattern means.
`requireFleetGrantReach` asks the narrower question — does any `agentpod:` value
have `*` as its node half (`agentpod:*/…`) — which is a string test on the same
values, not a second grammar.

The `Record<Capability, boolean>` **is** the fails-when-unclassified guarantee:
add an eleventh capability to the contract enum and the hub stops compiling until
someone classifies it. A test asserts the table's keys equal `Capability.options`,
so widening the type later cannot silently reopen the hole. This is the pattern
`db/tenant-scope.ts` already uses for tables.

**Called beside `gateCapability`, never folded into it.** Two of that function's
five callers are reads (`changeset`, `cleanup/plan`); a check inside it would
refuse someone permission to read a diff, which is nobody's idea of granting
reach.

## Behaviour

- **HTTP routes: 403**, carrying `ControlPairDenied` — the shape settled in #342.
- **Terminal WS: close 1008** with a reason frame, matching the capability gate
  beside it.
- **A refusal is audited, not only logged.** The terminal route already calls
  `recordAudit` on success; an attempt refused and recorded nowhere is
  indistinguishable from an attempt nobody made.
- **The console greys the control and says why.** It reads `mayGrantReach` from
  its own token via `/api/auth/token` — the mechanism kaambaan's web app already
  uses (kaambaan#43 option A). No new endpoint. `GrantDialog` stops saying "not
  yet enforced anywhere" and names what the switch gates.

## Rollout

**The same `ENFORCE_CONTROL_PAIR` switch as dispatch.** Two switches means a hub
where half the pair is live and half is not — the state that makes dispatch
control decorative in the first place — and a boot warning that would have to
describe four combinations instead of two.

Shipping is going live: production has enforcement on, one principal, whose grant
already carries `mayGrantReach: true` and fleet-wide dispatch values. The change
is a no-op there on day one, and binding for every principal added after.

**Lockout is recoverable, and the docs must say so.** `/api/admin/grants` is
guarded by *admin*, not by the pair, so an admin can always restore their own
grant from the console. "The control locked me out of the control" is the failure
that gets a control disabled permanently.

## Testing

Integration per call site, because the claim under test is that each site is
wired — a single helper test would pass with four routes unguarded:

- `fs.write` (all four verbs) refused without `mayGrantReach`; permitted with it.
- Terminal WS closed 1008 without it.
- `cleanup/apply` refused, `cleanup/plan` unaffected.
- `changeset` and `lifecycle` unaffected — the negative cases are the ones that
  catch an over-broad classification.
- Enrollment token refused with a node-scoped grant, permitted with a fleet-wide
  one.
- Scope composition: `mayGrantReach: true` plus a grant that does not match this
  station is still a refusal.
- Regression: the kaambaan bridge is untouched. It calls
  `acpSessions.createSession` as a service and never crosses these routes.
- Unit: the classification table is exhaustive over `Capability.options`.

## Verification against production

Same shape as the dispatch pass on 2026-08-15, and in this order:

1. Confirm nothing changed: open a terminal, write a file.
2. Set your own `mayGrantReach` to false. Confirm the terminal closes 1008 and a
   write answers 403, with both visible in the audit trail.
3. Restore it. Confirm recovery.

## Where this ends

**The credential broker** (`charter` → `strategy/2026-08-12-layer-reference.md`,
P3) makes granting reach a first-class act instead of an inference from file
writes, and the Capability Registry invariant means the ten capabilities here are
an early sample, not the set. What this design must earn is that the migration is
a *move*: the classification table gains the broker's verb, the check stays where
it is, and no call site is rewritten.

## What this design will not do

- **Introduce a policy engine.** One boolean, one scope list, both failing closed.
- **Guard reads.** Observation is not reach; a console that refused to show logs
  would be routed around within a day.
- **Cover cross-plane reach.** kaambaan granting an agent a tool or a credential
  is its own boundary, on its own plane.
