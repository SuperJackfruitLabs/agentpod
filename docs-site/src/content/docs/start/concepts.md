---
title: Concepts
description: Nodes, stations, harnesses, principals and the hub — the six words the rest of the documentation assumes.
---

Six words carry most of AgentPod. They are worth ten minutes.

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
kinds:

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

## Hub

The **one place that knows everything**: the registry of nodes and stations, the broker
that routes a request to the right node, enrollment, authentication, audit, and the
provisioning drivers.

It is a Bun service over Postgres, and you host it. It is also the only issuer of identity
in the suite — see [Authentication](/build/auth/).

## How they fit

```
hub
 └── node            a machine, dialing out
      └── station    a runtime on it, adopted
           ├── station   (nested, where the harness has sub-runtimes)
           └── station
```

A **principal** acts on those stations. A **harness** is what the station is an instance
of.

## Next

- [Nodes](/use/nodes/) and [Stations](/use/stations/) — operating both
- [What you can do to a station](/use/panels/) — the panels, and what each one needs
