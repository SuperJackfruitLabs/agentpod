---
title: Working a board
description: The SuperPipeline bridge — a hub that claims work from a board and runs it on a station, and the gates and questions that come back to a room.
---

AgentPod answers "where does this agent live, and is it healthy". Deciding *what* an agent should
work on is a different job in a different plane, which is what
[SuperPipeline](https://docs.superpipeline.dev) is for.

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

Give a roster entry an MCP credential and its harness gets SuperPipeline's own tools **inside the
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

**Some questions approve an exact operation.** A strict decision (a Salaam agent asking to write a
file) and a harness permission routed through a board both carry what they would do: the summary,
the files and their previews, or the command. An updated app shows it and binds your answer to that
exact version; an answer for a version that has since changed, or one that arrives after the
decision expired, is refused. Replying with a number can **decline** such a question but never
approve it — the reply cannot show you what you would be approving — so the room points you to an
updated app or the board instead.

## A card waiting on you

A card also stops on a person when its agent keeps failing, says it is **blocked**, or is **not
authorised** to go on. That reaches the board's room too, as its own card: what is wrong, what the
agent said, and three choices.

- **Resume here** — with a required instruction for the next attempt.
- **Resume at an earlier stage** — one choice per earlier stage, with the same instruction.
- **Archive** — with an optional remark.

Moving the card forward is not offered from chat: a move skips the stage's work and cancels its
gates, which deserves the board. Your answer goes to the board as you, and names the exact wait you
were shown — if the card was resumed, archived or moved on the board meanwhile, or now waits on
something else, the board refuses it, nothing changes, and the room says so. A card that parks again
arrives as a new card. Whoever settles it, here or on the board, the card in the room closes.

An older app shows the card as text with a link to the board; an updated app shows the buttons.

## SuperToolkit approvals

When a SuperToolkit write needs approval and the host is connected to SuperPipeline, the request
reaches the board's room as an **approval request**: no card, no stage — what the agent wants to do
(the service, the capability, the target, every argument in full, the station and the agent), with
**Allow once** and **Deny**. Only **workspace owners and admins** can allow it; anyone else is told
so and nothing changes, and the agent that asked can never decide its own request. An updated app
binds your answer to exactly the request it showed; a reply with a number can deny it but never
allow it. SuperToolkit checks the decision again before it acts.

## Next

- [Talking to an agent in a room](/use/rooms/) — the bridge these cards arrive on
- [Dispatch and grants](/use/grants/) — who may answer for which agent
- [SuperPipeline's own docs](https://docs.superpipeline.dev) — boards, stages and gates
