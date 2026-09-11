---
title: MCP tools
description: The hub's MCP endpoint — three self-scoped tools that let an agent answer questions about where it is running.
---

The hub speaks MCP over Streamable HTTP at **`/mcp`**.

## Getting a token

```sh
apn fleet login
```

The endpoint takes a hub-issued token in `Authorization: Bearer`, and only there. There is
no `?token=` fallback — a credential in a URL is a credential in a log.

## What an agent gets

Three tools. All read-only. **None of them take a station id**:

| Tool | Answers |
|---|---|
| `agentpod_my_station` | Where you are running: your station key, its node, your harness, your Matrix identity, and whether the node is online |
| `agentpod_my_sessions` | Your recent ACP sessions, newest first. Takes an optional `limit` (max 50) |
| `agentpod_my_transcript` | The events of one of your sessions. Takes a `sessionId` and an optional `sinceSeq` |

The station is derived from the calling principal in the token. There is no station
parameter, which means there is no station parameter to tamper with — the tools answer for
*you*, and there is no way to ask about anybody else.

If you are not currently placed in a station, they say so in a plain sentence. That is not
an error, and it should not be handled as one.

`agentpod_my_transcript` is the one tool with an explicit ownership check, because a
transcript is named by a session id and an id is a thing that can be guessed. A session
that is not yours is refused.

## What a human gets

Nothing self-scoped — a person occupies no station, so those tools have no meaning. Fleet
tools are not exposed over MCP yet; use `apn fleet` for nodes, agents, stats and activity.

The server tells you this in its `initialize` instructions rather than making you find out
by calling something.

## What you will not find

**The fleet.** An agent token cannot enumerate other agents, nodes or stations. That is
deliberate and not an oversight: the authority to *do your work* was never the authority to
*find out what else exists*, and an agent enumerating its siblings is an agent doing
reconnaissance.

## It adds no authority

Every tool calls the same service a normal HTTP route calls, through the same checks. There
is no operation available over MCP that is not available over the API, and no second
authorization model.

## Where work lives

AgentPod is the **execution** side: where you run, and what ran there. Claiming a card,
reporting progress and finishing work live in [kaambaan's MCP server](https://docs.kaambaan.dev/build/mcp/),
not this one.

## Next

- [Authentication](/build/auth/) — where the token comes from and how it is verified
