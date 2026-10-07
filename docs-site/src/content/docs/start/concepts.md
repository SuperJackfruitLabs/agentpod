---
title: Concepts
description: Nodes, stations, harnesses, principals, grants and the hub — the words the rest of the documentation assumes.
---

Eight words carry most of AgentPod. They are worth ten minutes.

## Node

A **machine** in your fleet: a VPS, a laptop, a container, a box under a desk. A node runs
the `agentpod-node` agent, which dials *out* to the hub and holds that connection open.

Nothing ever dials *in* to a node. That is not a detail — it is why a laptop on hotel
Wi-Fi, or a host behind CGNAT with no routable address, is reachable at all.

A node's credential says "I am this host". It is not an authority to operate the fleet,
and AgentPod deliberately never lets it become one.

## Harness

The **software that actually runs an agent**: Claude Code, Codex, OpenCode, Hermes,
OpenClaw, Pi.

AgentPod does not replace a harness and does not run agents itself. For each one it ships
a *descriptor* that knows how to ask that harness what it is running, where its config
lives, where its logs go, and how to start and stop it. The descriptor wraps the harness's
own native interface rather than reinventing it.

## Station

One **runtime instance** on a node — a single place where an agent works. A station belongs
to exactly one node and one harness, and carries a station key that is unique within that
harness.

Stations **nest**. A harness that manages sub-runtimes appears as a parent station with
children beneath it, which is why the console shows a tree under each node rather than a
flat list.

Detection finds stations; **adoption** is what puts one under management. Until you adopt
it, AgentPod knows a station exists and does nothing else with it.

Each station declares **capabilities** — which of the panels it supports. A request for a
capability the station has not declared is refused at the hub, before anything reaches the
machine.

## Purpose

What a station is *for*: `personal`, `work`, or any name you choose. It is not where the
station runs.

This exists because a node name carries purpose only by accident of how a particular fleet
was built. A station's own purpose is the one anything reads; a node's purpose is only the
default handed to a station at adoption that has none of its own.

## Principal

**Who is acting.** Every principal has a `prn_`-prefixed id, a handle, and one of three
kinds. Principals live in your account service, which issues their ids and their tokens:

| Kind | Is |
|---|---|
| `human` | A person |
| `agent` | An agent that acts on its own behalf |
| `service` | A system component |

The kind is not decoration — it is load-bearing at the door. The hub's MCP endpoint serves
different tools to an agent than to a person, and the endpoint that lists the agents you
may dispatch refuses an agent token outright. An agent enumerating its siblings is an agent
doing reconnaissance, so that answer is read from the signed token and from nothing the
caller can influence.

## Grant

**Who may spend an agent's time.** Messaging an agent, approving a tool call for it, and putting a
card in front of it are all the same act under different names, and all three are checked against a
`mayDispatch` claim the account service signed into the caller's token.

A grant is read from the signed token and from nothing the caller sent. A missing claim means
*permitted nothing* — never *permitted everything*. See [Dispatch and grants](/use/grants/).

Operating a station is a **different** authority from dispatching the agent in it. Reading logs is
not dispatching; sending a message is.

## Room

If the bridge is on, every adopted station has a **chat identity and a room**. It is how an agent
whose harness never spoke a messaging protocol can be reached from a phone — and how permission
questions, failed turns and a board's approval gates get in front of a person who is not at a
console. See [Talking to an agent in a room](/use/rooms/).

## Hub

The **one place that knows everything about the fleet**: the registry of nodes and stations,
the broker that routes a request to the right node, enrollment, audit, and the provisioning
drivers.

It is a Bun service over Postgres, and you host it. It does not issue identity. People,
agents, services and workspaces belong to the account service, and the hub checks every
token it is shown against that service's published keys, without calling it — see
[Authentication](/build/auth/).

## How they fit

```
hub
 └── node            a machine, dialing out
      └── station    a runtime on it, adopted
           ├── station   (nested, where the harness has sub-runtimes)
           └── station
```

A **principal** acts on those stations, bounded by a **grant**. A **harness** is what the station
is an instance of. With the bridge on, each station also has a **room**.

## Next

- [Nodes](/use/nodes/) and [Stations](/use/stations/) — operating both
- [What you can do to a station](/use/panels/) — the panels, and what each one needs
- [Dispatch and grants](/use/grants/) — who may act on whom
