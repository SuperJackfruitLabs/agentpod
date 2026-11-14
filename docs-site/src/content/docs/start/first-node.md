---
title: Your first node
description: Install the node agent on a machine and watch it appear in the console.
---

A **node** is a machine in your fleet. Let's enroll one together, confirm that it can reach the
hub, and choose the stations you actually want AgentPod to manage.

You need a running hub and access to its console before we start.
Since v0.1.92, the hub requires `ORG_PLANE_*` configuration and a credential from
an external account service that is not public source. The deployment runbook
alone is not a complete self-hosting path for current releases.

## 1. Get an enrollment token

In the console, open **Nodes** and create an enrollment token. Think of it as the machine's place
on the guest list: the plaintext is shown once, and it proves to the hub that *this* machine was
invited.

A fresh token is **single-use and expires after an hour**. It is consumed atomically, so
two machines racing to enroll with the same token cannot both get through the door — exactly one
does, and the other is refused.

Once a token is bound to a node, re-presenting it is allowed and resumes that node. That
is what makes `apn enroll` idempotent: running it again on a machine that is already
enrolled is a no-op rather than an error.

You now have a one-hour, single-use invitation for exactly one machine. Keep it ready for the next
step; once it is spent, the hub will not admit a second machine with it.

## 2. Install the agent

On the machine you want to enroll:

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install.sh \
  | sudo bash -s -- https://hub.example.com <TOKEN>
```

The script downloads the right binary for the platform, installs it, registers a service,
and enrolls. Binaries are published for linux and darwin on both amd64 and arm64.

Without root, install for your user instead:

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install.sh \
  | bash -s -- --user https://hub.example.com <TOKEN>
```

The user install puts the service under your login session — a systemd `--user` unit on
Linux, a LaunchAgent on macOS — so it starts when you log in rather than when the machine
boots.

The node agent is now installed as a service and has presented your enrollment token to the hub.
We have a resident node rather than a command that worked once and disappeared.

## 3. Check it

```sh
apn status
```

This prints two blocks: whether the service is installed, enabled and running, and whether
the hub is reachable with a valid credential. It exits `0` only if **both** are true, so it
works directly in a health check or a cron job.

The node should now appear in the console as online. We have proved both halves of the path: the
local service is running, and the hub accepts its credential.

## 4. See what's on it

```sh
apn detect
```

This prints the harness stations found on the host as JSON. It needs no hub connection and
no account, so you can compare the local inventory with what you expected before we involve the
console.

The v0.1.98 release described on the landing page ships detection for **Hermes,
OpenClaw, Claude Code, Codex, OpenCode, Pi, Muse Code and Kilo**. Detection does
not imply the same capabilities for every harness; Muse Code and Kilo capabilities
beyond detection have not been checked.

You now have the node's local station inventory in front of you. Detection has observed what is
there and changed nothing.

## 5. Adopt a station

Detection finds runtimes; it does not take them over. In the console, open the node and
**adopt** the stations you want to manage. Adoption is what puts a station in the registry
and makes the panels available.

Your chosen stations are now manageable, and everything you left unadopted stays untouched. The
machine made the guest list; you still chose who came inside.

## Next

- [Concepts](/start/concepts/) — what nodes, stations and harnesses actually are
- [Nodes](/use/nodes/) — running the service day to day
- [Checking for exposure](/use/scan/) — `apn scan`, which needs no hub at all
