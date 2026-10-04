---
title: Dispatch and grants
description: Who may send an agent work — read from the signed token, never from the request, and never read as "everyone".
---

Sending an agent a message spends its time. So does approving a tool call for it, and so does
putting a card in front of it. All three are **dispatch**, and all three ask the same question:
may this principal dispatch that one?

## The answer is in the token

```
GET /api/fleet/dispatchable
```

Returns the agents the token's holder may dispatch. The answer is read from a `mayDispatch` claim
the hub **signed into the token** — not from a query parameter, not from a header, and not derived
from anything else the caller sent. There is nothing in the request that can change it.

**A missing or non-array claim is read as *permitted nothing*.** Never as *permitted everything*.
An absent claim means the issuer does not speak that control, and reading that as "all" is the one
mistake that cannot be walked back.

An agent's token is refused at this endpoint regardless of what it may dispatch. An agent
enumerating its siblings is an agent doing reconnaissance.

## A grant is a document

```sh
fleet grants list
fleet grants show <principalId>
fleet grants set <principalId> --file grant.json   # or --file - for stdin
fleet grants rm <principalId>
```

`set` takes a **file**, not flags. A grant is a document rather than a field: the hub validates its
whole shape, and flattening it into flags would mean the CLI modelling a schema the hub owns and
then disagreeing with it the first time that schema moves. `-` reads stdin, so a grant can be piped
from whatever produced it.

## Where a grant is checked

| act | checked |
|---|---|
| messaging an agent in its room | ✓ |
| approving a permission question from a room | ✓ — approving is dispatching by another name |
| claiming a card for an agent through the board bridge | ✓, on the board's side, against what the queuer was permitted |
| reading a station's logs or files | no — that is operating a machine, not dispatching an agent |

The distinction is worth holding onto. Operating the ground an agent stands on is a different
authority from spending the agent's time, and AgentPod keeps them apart.

## Principals, and switching one off

```sh
fleet principals list
fleet principals suspend <id>
fleet principals restore <id>
```

Suspending a principal stops it acting without deleting what it did. The record of its past work
stays answerable, which is the point of having principals at all.

For people rather than principals:

```sh
fleet users list
fleet users show <id>
fleet users role <id> …
fleet users ban <id>
fleet users unban <id>
```

## A node's credential is not an authority

A node's secret says **"I am this host"**. It is not permission to operate the fleet, and AgentPod
deliberately never lets it become one — `fleet` commands never fall back to a node's credential.

This is why there are two binaries. See [apn and fleet](/use/cli/).

## Next

- [Authentication](/build/auth/) — where a token comes from, and where it may be spent
- [Talking to an agent in a room](/use/rooms/) — the most common way a grant is spent
