# A conversable fleet — the Matrix Application Service

**Date:** 2026-08-16
**Status:** Design. Unbuilt.
**Phase:** charter → `strategy/2026-08-12-layer-reference.md` **P2 (Communication)**.
**Depends on:** #329 (Synapse on Postgres), which ships first and separately.
**Follows:** `charter/decisions/2026-08-14-supermessage-positioning.md`,
`2026-08-13-ecosystem-identity.md` (Decision 4), `2026-08-15-granting-reach-is-changing-an-agent.md`.

## The problem, stated as an operator sees it

There are **32 adopted stations** in the fleet. **14** can be talked to from a
phone; **18** cannot. The line between them is not capability — every one of
them speaks ACP and holds a conversation in the console's Chat tab — it is
*which harness happens to implement Matrix natively*. hermes does. openclaw,
codex, claude-code, opencode and pi do not, and never will, because that is not
their job.

So the fleet's reachability is an accident of harness choice:

| harness | stations | reachable from Matrix today |
|---|---|---|
| hermes | 14 | yes — each has its own account, e.g. `@analyst-echo:id.agentpod.dev` |
| openclaw | 10 | no |
| codex | 3 | no |
| claude-code | 2 | no |
| opencode | 2 | no |
| pi | 1 | no |

The console is not a substitute. It is a facilities console — the place you go
to see a fleet, provision a runtime, read a log. Conversation belongs where
conversation already happens, next to the people also in the room.

## What already exists, and it is more than expected

**The Application Service is registered.** `/etc/matrix-synapse/agents.yaml`
declares an AS `ai-agents` with:

- users `@agent_.*` — **exclusive**
- aliases `#agentpod_.*` — **exclusive**
- `de.sorunome.msc2409.push_ephemeral: true`
- **`url: null`**

`url: null` is the whole gap. The homeserver holds the namespaces and the
tokens and pushes nothing, because there is nothing to push to. This design
fills that hole; it does not invent the registration.

**The authorization is built.** `resolveMatrixId(mxid)` already answers
*principal*, *station*, *ambiguous* or *null* — and fails closed on ambiguity,
because attributing a human's approval to an agent is the one mistake that
cannot be walked back. The control pair then answers whether that principal may
dispatch that station. An inbound Matrix message is therefore an *authorization
question this suite can already answer*, which is why this is now a bridge and
not a security project.

**The conversation plumbing is built.** `acp-sessions.ts` owns sessions, a
per-session subscriber fan-out, and an append-only `acp_events` transcript. The
console's WebSocket route is one subscriber. The bridge is another.

## The decision

**Every station gets a Matrix identity owned by the bridge, and a room.** Not
only the 18 — all 32, hermes included. One mechanism, uniform behaviour,
one place to fix anything.

A message in a station's room is a prompt to that station's ACP session. The
agent's output comes back as messages from that station's user. Who may do this
is the control pair, unchanged.

### Names are derived, never stored twice

```
station  molt-bot / hermes:analyst-echo
user     @agent_molt-bot_hermes_analyst-echo:id.agentpod.dev
alias    #agentpod_molt-bot_hermes_analyst-echo:id.agentpod.dev
```

`:` and any character outside the mxid localpart grammar becomes `_`, lowercased.
Derivation is a pure function of `(nodeName, stationKey)` — the same pair that
already identifies a station in a grant
(`2026-08-15-a-grant-names-an-agent-per-plane`). No mapping table, and a name
an operator can read and predict.

**Both names include the node**, for the reason grants do: `opencode:c52ddf65`
exists on two nodes right now. A Matrix identity that named only the station key
would merge two different agents on two different machines into one, which is
the collision this suite has already undone once.

### The 14 hermes agents keep their mxids and change owner

They are `@analyst-echo:id.agentpod.dev` — **outside** `@agent_.*`, real
accounts with their own logins, because hermes is a Matrix client.

Renaming them to `@agent_molt-bot_hermes_analyst-echo` would be uniform and
wrong: those addresses are in people's rooms, in their history, and in their
muscle memory. **The registration gains a second, non-exclusive namespace
listing those 14 localparts explicitly**, which is what lets the AS act as them.
The mxid an operator knows does not change; what changes is who answers.

The cost is real and is the riskiest part of this design: **hermes's own Matrix
loop and the bridge would both answer the same address**. So the cutover is per
agent, and it is a stop-then-start, never a dual-run in a room anyone uses:
disable that agent's native Matrix loop on the host, then mark the station
bridge-owned. Rollback is the same two steps reversed, and it is one row.

### Ownership is recorded, because two things write that column

`stations.matrix_id` is written by the node agent from a harness profile. The
bridge must not fight it. A new column `stations.matrix_id_source`
(`harness` | `bridge`, default `harness`) says who owns the address, and the
node agent's refresh leaves `bridge` rows alone. `resolveMatrixId` is unchanged
— it answers about an mxid, not about its provenance.

## How a message becomes work

```
Matrix room  #agentpod_molt-bot_hermes_analyst-echo
   │ m.room.message from @rakesh:id.agentpod.dev
   ▼
AS transaction  POST /_matrix/app/v1/transactions/:txnId   (hs_token)
   │ resolveMatrixId(sender) → principal
   │ control pair: may this principal dispatch this station?
   ▼
acpSessions.createSession / promptSession
   │ subscriber fan-out (the same one the console's WS uses)
   ▼
messages sent as @agent_… ; typing while the turn is in flight
```

**Refusals are messages, not silence.** A sender with no principal mapping, an
ambiguous mxid, or a grant that does not cover the station gets a reply in the
room saying so. A bridge that ignored them would look broken, and an operator
would conclude the agent was down.

## What this design refuses to do

- **No second state machine.** Matrix carries a *projection* of a conversation
  that `acp_events` remains authoritative for, exactly as kaambaan#34 sets the
  boundary for cards: *Matrix carries projections, never truth*.
- **No card, run or gate events.** Those schemas are kaambaan's and are being
  designed in the open (kaambaan#34). This bridge gives them a room to land in
  and stops there.
- **No E2EE.** Rooms are unencrypted. supermessage renders a placeholder for
  encrypted rooms today, so encryption would make the fleet *less* reachable,
  and MSC3202 device masquerading is a second project.
- **No federation.** The homeserver is private and stays so.
- **No new harness work.** The node agent is untouched: everything happens
  between the homeserver and the hub.

## The loop that eats a homeserver, and how it is avoided

An AS receives the events its own users send. Reply to those and you have an
infinite loop that bills nobody but fills a database. **Every event whose sender
is inside the AS's user namespaces is dropped before anything else looks at it**
— asserted by a test, because this is the failure that takes a homeserver down
at 3am.

Transactions are **idempotent by `txnId`**: Synapse retries a failed
transaction, and a bridge that prompted an agent twice for one message would
double every conversation. The last applied id is stored; a repeat is a 200 and
no work.

## Where it runs

**In the hub**, as `services/matrix-as/` plus routes under `/_matrix/app/v1/*`,
authenticated by `hs_token` rather than a session.

The precedent is the kaambaan bridge, which lives there for the same reasons:
it needs `acp-sessions`, `grants` and `resolveMatrixId` in-process, and every
alternative is those three over HTTP with a second set of credentials. The
console's own WebSocket already proves a second subscriber to the session
fan-out is ordinary.

A separate `apps/matrix-bridge` would be tidier on a diagram and would need the
hub's database, its ACP service and its grant store anyway. Revisit if the hub
process becomes the bottleneck; the seam is the routes, and it moves.

## What "done" looks like

An operator opens supermessage on their phone, types in
`#agentpod_superchotu_openclaw_krishna`, and an agent that has never spoken
Matrix in its life answers — with the message refused, in the room, if their
grant does not cover it.
