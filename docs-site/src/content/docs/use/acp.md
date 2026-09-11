---
title: Attaching an editor
description: Make a station on another machine look like a local agent to any ACP client.
---

ACP is the protocol editors speak to coding agents. `apn acp` makes a station on **another
machine** look like a local agent to any client that speaks it — Zed, JetBrains, anything
else.

## How it works

Your editor spawns `apn acp` and talks ACP over its stdin and stdout. Those frames are
piped to the hub, which does the protocol work and routes them to the station. The node
dialled out, so this reaches stations behind NAT or CGNAT that your editor could never
connect to directly.

```sh
apn acp --list                 # stations you can attach to
apn acp --station <id>         # attach
apn acp --station <id> --session <id>   # resume a session
```

`--hub` points at a hub other than the default.

## This is the one command that needs no node

Every other node verb assumes this machine is enrolled. `apn acp` does not — a laptop can
install `apn` purely as a client, attach to stations elsewhere, and never be part of the
fleet itself.

## Tokens

Prefer `$AGENTPOD_TOKEN`, which is what `--token` defaults to. A token passed as an
argument lands in your shell history and in the process list.

## Sessions

Sessions are recorded, and an agent can read back its own transcripts through
[the MCP tools](/build/mcp/) — `agentpod_my_sessions` to find a session, then
`agentpod_my_transcript` to read it.
