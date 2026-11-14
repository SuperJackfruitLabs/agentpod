---
title: Attaching an editor
description: Make a station on another machine look like a local agent to any ACP client.
---

ACP is the protocol editors speak to coding agents. With `apn acp`, we can make a station on
**another machine** look local to any client that speaks ACP — Zed, JetBrains, or anything else.
Your editor keeps its familiar workflow; the agent can stay where it already lives.

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

Once the attach command starts, your editor is speaking to that remote station as if it had spawned
the agent beside you. The hub and node carry the distance; the editor does not have to know it exists.

## It needs no node

`apn acp` does not assume this machine is enrolled — a laptop can install `apn` purely as a
client, attach to stations elsewhere, and never be part of the fleet itself. (`apn scan` is
the other command that works on an unenrolled machine; see [Checking for
exposure](/use/scan/).)

## Tokens

Prefer `$AGENTPOD_TOKEN`, which is what `--token` defaults to. A token passed as an
argument lands in your shell history and in the process list. Keeping it in the environment gives
you the same attachment without leaving the credential in either place.

## Sessions

Sessions are recorded, and an agent can read back its own transcripts through
[the MCP tools](/build/mcp/) — `agentpod_my_sessions` to find a session, then
`agentpod_my_transcript` to read it.
