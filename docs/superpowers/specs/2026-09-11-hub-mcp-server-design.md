# An MCP server for the hub, where an agent can see itself

**Date:** 2026-09-11
**Product:** AgentPod (`apps/hub`)
**Status:** Spec.
**Follows:** agentpod#414 (the hub verifies its own token),
`docs/superpowers/specs/2026-09-11-route-audit-for-agent-principals.md` (which shaped this),
and kaambaan's MCP server, which is the working model.

## The gap

An agent works in kaambaan and executes in AgentPod, and its tools only reach the first.
kaambaan's MCP server gives it a complete work loop — claim, heartbeat, post activity, complete.
Nothing gives it its own **execution**: when a run fails, the agent cannot read its own station's
health, its own logs, or its own ACP transcript. A human opens two consoles and correlates by
hand. That is the gap this closes.

## What the audit changed about the obvious design

The obvious design is "expose the fleet routes over MCP". The route audit says no, twice over:

- the write routes change **what an agent is** — creating principals, assigning stations,
  provisioning compute — and are operator acts
- the read routes are **reconnaissance** for an agent: `fleet-dispatchable` already refuses
  agent-kind tokens because *"an agent that enumerates its siblings is an agent doing
  reconnaissance"*, and that argument applies unchanged to nodes, stations, activity and sessions

So the agent-facing surface is **not the existing routes**. It is a small set of **self-scoped**
reads that derive the station from the caller's principal, with **no station id parameter at
all** — because an ownership check is a thing a future handler can forget, and a tool with no id
cannot be pointed at somebody else by construction.

`stations.principal_id` carries a partial unique index, so one principal occupies at most one
station. The mapping the self-scoping needs already exists and is already unique.

## Shape

One endpoint, `POST /mcp`, **mounted before `authMiddleware`** and resolving its own auth with
`verifyHubToken` — the same position and reason as `dispatchableRoutes`. `authMiddleware` refuses
non-human principals, which is correct for the operator API and wrong for a surface whose whole
point is agents.

Stateless Streamable HTTP, a fresh `McpServer` per request, tools bound to the authenticated
principal — kaambaan's pattern, unchanged. There is no MCP-session state worth keeping: every
tool is a thin call into a service the HTTP routes already use.

**The principal's kind decides the tool set**, and it is decided once, at registration:

| `principalKind` | tools registered |
|---|---|
| `agent` | the self-scoped set only |
| `human` | the self-scoped set is meaningless (a human occupies no station) plus the fleet set |

Not "register everything and check inside each handler". A tool an agent must not call is a tool
an agent is never offered, so the refusal cannot be forgotten in one handler out of nine.

## The agent tool set (slice 1)

Every one derives its station from `sub`. None takes a station id.

```
agentpod_my_station        what I am: station key, node, harness, identity mode, health
agentpod_my_logs           my station's recent logs
agentpod_my_sessions       my ACP sessions, newest first
agentpod_my_transcript     one session's transcript, by session id I own
```

An agent occupying no station gets a clear answer rather than an error: *"you are not currently
placed in a station"* is a true and useful thing to say, and it is the ordinary state for an
agent between assignments.

**`agentpod_my_transcript` takes an id and therefore needs a check** — the one place in this
slice where ownership is verified rather than structurally impossible. The session must belong
to a station this principal occupies. That check is the exception, it is named here, and it has
its own test.

## The human tool set (slice 2)

Exactly the reads the CLI already makes, over a second transport: nodes, agents, stats,
activity, and station reads by id. No new authority — a human hub token already opens these
through `authMiddleware`, and MCP is a different wire onto the same contract.

## Writes (slice 3)

Through the **same guards the HTTP routes use** — `requireGrantReach`,
`requireIssueCredentials`, `gateCapability` — never around them. `REACH_BEARING` is exhaustive by
type, so a capability added to the contract enum stops the build until somebody classifies it,
and that property must survive a second caller.

Deliberately **not** in slice 1. The read surface is what closes the real gap; writes are what
the audit says to be careful with, and shipping them together would mean reviewing both at once.

## What this must not become

- **No new authority.** The MCP server is a transport. Every tool calls a service the HTTP
  routes call, through the same guards. A tool that can do something no route can is a second
  authorization model.
- **No station id from an agent.** Slice 1 has exactly one id parameter and it is checked. If a
  later tool needs one, that is a decision, not a convenience.
- **No enumeration for agents.** Not nodes, not other stations, not other principals. The
  reconnaissance argument is already settled in `fleet-dispatchable`.

## Open questions

- **Whether a human should get the agent tools too**, scoped to a station they name. Probably
  yes eventually, and it is a different tool with a different name rather than the same tool
  growing a parameter.
- **Rate limiting.** kaambaan's MCP has none either. Out of scope, worth recording.
- **Whether `station-say` is reachable from here.** It is not in any slice above, and the route
  audit found it has no capability describing it. It stays out until that decision is made.
