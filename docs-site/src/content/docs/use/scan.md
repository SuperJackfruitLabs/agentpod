---
title: Checking for exposure
description: apn scan — a local security check for agent runtimes that needs no hub, no account and no network.
---

```sh
apn scan
```

`apn scan` checks the agent runtimes on this host for the two ways they get taken over:

- **a listener bound to every network interface** — an agent's API reachable from outside
  the machine
- **credential files other users can read** — the keys the agent works with, sitting where
  anyone on the box can take them

It needs **no hub, no account and no network**. It works on a machine that has never heard
of AgentPod, which is the point.

## Exit codes

| Code | Means |
|---|---|
| `0` | Clean |
| `1` | Warnings |
| `2` | Critical |

That makes it usable directly in cron or CI.

```sh
apn scan --json        # machine-readable
apn scan --no-color    # plain output for logs
```

## It does not guess

A check that cannot determine an answer reports **unknown**, and says why. It is never
reported as a pass.

This is a deliberate design rule, and it costs something: you will sometimes see "unknown"
where a more confident tool would show a green tick. That is the trade being made. A
scanner that cries wolf gets ignored, and a scanner that quietly calls an unknown a pass is
worse than one that says nothing.

There is also **no CVE feed**. A version-to-CVE database rots the moment it ships, and it
would turn a static binary into something that has to phone home to stay honest. Every
check here is a property of the machine as it is right now.

## In the console

The same checks surface as a posture banner on nodes and stations, so an exposure found on
a host you have not logged into lately is still in front of you.

## Next

- [The apn command](/use/cli/) — the rest of the surface
