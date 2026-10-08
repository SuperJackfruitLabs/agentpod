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

The station's room is created with it, and **created encrypted** — there is nothing extra to turn
on, and no window in which it existed in the clear. Rooms hang under a space named for the machine
they run on, so the roster groups itself in any client that reads the hierarchy.

An agent can be given an **avatar**: preview a workspace image and set it as the station's picture.
A roster of thirty identical default avatars is a roster you read by name only.

What else arrives in that room — voice notes, permission questions, a card when a turn fails, a
board's approval gates — is [Talking to an agent in a room](/use/rooms/).

## Git identity

A station can be given a key to push to a forge with:

```sh
fleet stations git-identity --station <stationId>
fleet stations grant-push   --station <stationId>
fleet stations revoke-push  --station <stationId>
```

**Granted per station, never by adopting one.** Most stations never touch git, and a forge key for
every station is an account nobody uses and a key nobody revokes.

The keypair is generated **on the node** and the private half never leaves it: `grant-push` asks
for the public half and registers that. The hub holds no secret, so a hub compromise does not hand
over commit access.

**Commits carry the agent, not the host.** With the key, the hub sends the station's commit author:
the agent's display name in readable form (a handle like `fixture-agent` — or a station key like `harness:fixture-agent` — becomes `Fixture Agent`;
without a display name, the forge account's full name minus its ` (agent)` suffix), and the forge
account's email exactly as forge stores it. That email is synthetic — an agent has no mailbox — and
it is what the forge links a commit to the account by, so the name carries no "(agent)" suffix: the
email's domain already says it. The node records the author beside the key and starts the station's
harness and terminal with `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
`GIT_COMMITTER_EMAIL` — environment, never git config, so nothing is written to any repository or
to the host. A station with no identity gets none of these and keeps the host's git config.
`git-identity` shows the author as `authorName`/`authorEmail`. An identity provisioned before
authors existed gets one the next time its node connects (a node update reconnects it), with no key
regenerated. A harness or terminal already running keeps the environment it started with.

## Staffing

Putting an agent in a station, or taking it out:

```sh
fleet staff options
fleet staff assign   --station <stationId> --file <path>|-
fleet staff unassign --station <stationId>
```

## Cleaning up

Removing a station from the registry is not the same as deleting anything on the machine.
For reclaiming actual disk, see the cleanup panel in
[What you can do to a station](/use/panels/) — which plans first, shows you the plan, and
only then applies it.

## Next

- [What you can do to a station](/use/panels/)
- [Talking to an agent in a room](/use/rooms/)
- [Managed skills](/use/skills/)
- [Attaching an editor](/use/acp/)
