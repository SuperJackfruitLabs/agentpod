---
title: Stations
description: Detecting, adopting and organising the runtimes on your nodes.
---

A **station** is one runtime instance on a node — a single place where an agent works.

## Detection versus adoption

These are two different things, and the distinction is the point.

**Detection** is the node agent looking at the host and reporting what it finds. It happens
without you asking, and it changes nothing.

```sh
apn detect
```

Prints what this host has, as JSON. No hub connection, no account required.

**Adoption** is you deciding a station should be managed. Only an adopted station is in the
registry, and only an adopted station has panels.

The gap between them is deliberate. A machine may run agents that are none of AgentPod's
business, and detecting one is not consent to manage it.

## The tree

Stations nest. A harness that manages sub-runtimes appears as a parent with children
beneath it, which is why the console shows a tree under each node rather than a flat list:

```
node: workhorse
 └── hermes
      ├── coder-kai
      └── hanuman
```

Deleting a parent removes its children with it — a child station cannot outlive the station
it runs inside.

## Capabilities

Each station declares which operations it supports. A request for a capability a station
has not declared is refused **at the hub**, with no call to the machine at all.

That ordering matters for a reason worth stating: a refusal that never leaves the hub
cannot be turned into a way to probe what is on the host.

## Purpose

A station's **purpose** is what it is for — `personal`, `work`, or any label you pick. It
is not where it runs.

Set it on the station. A node's purpose is only the default applied at adoption to a
station that has none of its own; the station's is the one anything actually reads. A
station nobody has labelled is filed under no Matrix space at all.

## Matrix identity

A station can have a Matrix identity, so that talking to an agent is just messaging. Two
modes, and never both at once:

| Mode | Means |
|---|---|
| `bridge` | The Application Service speaks for the station |
| `harness` | The station runs its own Matrix client |

In `bridge` mode the identity is minted by the Application Service and stored separately
from whatever the harness reports about itself. Nothing on the host can report that
identity, so nothing on the host can erase it.

## Cleaning up

Removing a station from the registry is not the same as deleting anything on the machine.
For reclaiming actual disk, see the cleanup panel in
[What you can do to a station](/use/panels/) — which plans first, shows you the plan, and
only then applies it.

## Next

- [What you can do to a station](/use/panels/)
- [Attaching an editor](/use/acp/)
