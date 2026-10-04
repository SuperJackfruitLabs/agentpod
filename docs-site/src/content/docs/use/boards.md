---
title: Working a board
description: The superpipeline bridge — a hub that claims work from a board and runs it on a station, and the gates and questions that come back to a room.
---

AgentPod answers "where does this agent live, and is it healthy". Deciding *what* an agent should
work on is a different job in a different plane, which is what
[superpipeline](https://docs.superpipeline.dev) is for.

The bridge joins them: the hub can **claim work from a board** and run it on a station.

It is outbound-only. It adds no route, opens no port, and a hub with it off is indistinguishable
from one built before it existed.

## The roster

The bridge runs from a roster: which agent claims from which board, onto which station, and with
what credential. It lives in the hub's database and is edited in the console under
**Admin → Bridge**, or from the terminal:

```sh
fleet bridge list
fleet bridge add --key <key> …
fleet bridge set <key> …
fleet bridge rm <key>
```

There is no environment variable and **no restart**. The bridge brings its running loops into line
with the roster every ten seconds, so an agent added at noon starts claiming at noon.

| what you do | what happens |
|---|---|
| add an agent | a loop starts within a tick |
| disable or remove one | it **finishes the card it is holding**, then stops |
| edit one, or replace a credential | the loop drains as above, then is rebuilt with the new settings |

**A roster key is not an identity.** It is a dispatch label; the authority comes from the token
attached to it. And a credential **cannot be read back** — from the console or the API. The read
surface answers whether a token is present and nothing else. Rotating one is a replace, and it
takes effect on the next tick.

## What the loop does

Claim a card, run it as a turn on the station, report back. The timings are deliberate rather than
configurable:

| | |
|---|---|
| poll | every 5s after a cycle that found nothing |
| backoff | 30s after a failed cycle — claim, release, claim is not a fix |
| heartbeat | every 60s while a card is being worked, against the board's 15-minute reclaim |
| turn timeout | 30 minutes for one prompt turn; on expiry the run is failed **on the board** rather than left hanging |

A lost lease is ordinary — the card was reclaimed, and the loop claims again. One condition halts a
loop permanently: being told a run belongs to **another** agent. That means two things believe they
hold the same work, and continuing would have one write over the other.

## When the agent reports for itself

Give a roster entry an MCP credential and its harness gets superpipeline's own tools **inside the
session**. The agent can then attach a reference, ask a question, or complete the card itself,
rather than having the bridge infer an outcome from the shape of its reply.

This is the better arrangement where the harness supports it: the thing that did the work is the
thing that reports it.

## Gates and questions come back to a room

Work on a board stops on a human twice: at an **approval gate**, and when an agent **asks a
question** mid-run. Both reach a room, so neither needs the web app.

A gate arrives as a card with its options, and your answer decides it on the board. A question
arrives the same way — the agent's words and the options it offered — and replying with the
option's number answers it.

Two rules worth knowing:

- **Only a human may decide a gate.** An agent's token is refused, and this is a product boundary
  rather than a setting: an agent holding both halves of that pair makes every "a human decided
  this" record unverifiable.
- **A question answered somewhere else settles here.** If it was answered in the web app, or
  retired by the agent asking a newer one, the card in the room stops standing rather than
  inviting an answer to something already decided.

Questions reach a room by push where the board is configured for it, and by a reconciliation sweep
otherwise — so a board that has not been reconfigured is served late rather than not at all.

**Buttons only.** A question whose agent offered no options cannot be answered from the room, and
the room says where it can be answered rather than pretending.

## Next

- [Talking to an agent in a room](/use/rooms/) — the bridge these cards arrive on
- [Dispatch and grants](/use/grants/) — who may answer for which agent
- [superpipeline's own docs](https://docs.superpipeline.dev) — boards, stages and gates
