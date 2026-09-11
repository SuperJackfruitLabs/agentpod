---
title: Your first node
description: Install the node agent on a machine and watch it appear in the console.
---

A **node** is a machine in your fleet. Enrolling one takes a hub, an enrollment token, and
one command on the target host.

This page assumes a hub is already running. If you are standing one up, the deployment
runbook in the repository covers that end.

## 1. Get an enrollment token

In the console, open **Nodes** and create an enrollment token. The plaintext is shown
once. It proves to the hub that *this* machine was invited.

A fresh token is **single-use and expires after an hour**. It is consumed atomically, so
two machines racing to enroll with the same token cannot both win — exactly one does, and
the other is refused.

Once a token is bound to a node, re-presenting it is allowed and resumes that node. That
is what makes `apn enroll` idempotent: running it again on a machine that is already
enrolled is a friendly no-op rather than an error.

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

## 3. Check it

```sh
apn status
```

This prints two blocks: whether the service is installed, enabled and running, and whether
the hub is reachable with a valid credential. It exits `0` only if **both** are true, so it
works directly in a health check or a cron job.

The node should now appear in the console as online.

## 4. See what's on it

```sh
apn detect
```

This prints the harness stations found on the host as JSON. It needs no hub connection and
no account — it is the fastest way to confirm the agent sees what you expected before you
go looking in the console.

AgentPod ships detection for **Hermes, OpenClaw, Claude Code, Codex, OpenCode and Pi**.

## 5. Adopt a station

Detection finds runtimes; it does not take them over. In the console, open the node and
**adopt** the stations you want to manage. Adoption is what puts a station in the registry
and makes the panels available.

## Next

- [Concepts](/start/concepts/) — what nodes, stations and harnesses actually are
- [Nodes](/use/nodes/) — running the service day to day
- [Checking for exposure](/use/scan/) — `apn scan`, which needs no hub at all
