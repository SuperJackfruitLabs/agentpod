---
title: Working a board
description: The SuperPipeline bridge — a hub that claims work from a board and runs it on a station, and the gates and questions that come back to a room.
---

AgentPod answers "where does this agent live, and is it healthy". Deciding *what* an agent should
work on is a different job in a different plane, which is what
[SuperPipeline](https://docs.superpipeline.dev) is for.

The bridge joins them: the hub can **claim work from a board** and run it on a station.

The bridge claims by calling the board. The board calls back through three signed doors under
`/public`, each refused without a valid signature:

| door | what arrives | signed with |
|---|---|---|
| `POST /public/bridge/superpipeline/work` | `work.available`: a card one of this hub's agents could claim is ready | `SUPERPIPELINE_PUSH_SECRET` |
| `POST /public/bridge/superpipeline/push` | gates, questions, follow-ups, waiting cards and their reminders and outcomes | `SUPERPIPELINE_PUSH_SECRET` |
| `POST /public/bridge/superpipeline/events` | `gate.pending` from the suite's [event relay](https://treaty.superjackfruit.com/relay/) | `TREATY_RELAY_DELIVERY_SECRET` |

The three exist only on a hub with a Matrix bridge configured. The hub registers the push
subscriptions with each board itself, with the board's own credential, so there is nothing to set
up on the board. With the push secret unset, nothing is registered and the first two doors answer
503; the relay door answers 503 without its own secret.

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
| poll | every 5s after a cycle that found nothing, unless the board says work is ready first |
| backoff | 30s after a failed cycle — claim, release, claim is not a fix |
| heartbeat | every 60s while a card is being worked, against the board's 15-minute reclaim |
| turn timeout | 30 minutes for one prompt turn; on expiry the run is failed **on the board** rather than left hanging |

**Work is claimed when it appears.** Each roster entry subscribes, with its own credential, to the
board's `work.available` push. When a card it could claim appears (created, advanced, released,
reclaimed or unblocked), every idle loop on that board ends its wait and claims at once; the board
still decides which card, if any, each one gets. The poll stays underneath as the floor, for a lost
push or a hub the board cannot reach. A wake never cuts a backoff short.

**A board that is briefly down does not end a run.** For a Salaam station's strict run, a heartbeat
that gets a 5xx or times out (a SuperPipeline redeploy answers 502) is retried after 1, 2 and 4
seconds, and if the board is still down the run is driven again on the next cycle with its session
kept. Only a lease the board refuses stops the work.

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
A gate also reaches the hub through the suite's [event relay](https://treaty.superjackfruit.com/relay/) as a
[`gate.pending`](https://treaty.superjackfruit.com/events/gate-pending-v1/) event, whose signature the hub checks before it reads
the body ([how a subscriber verifies](https://treaty.superjackfruit.com/relay/#verifying-a-delivery)). A gate delivered both ways
is posted once.

What crosses the room is [Treaty](https://treaty.superjackfruit.com)'s: the [gate card](https://treaty.superjackfruit.com/matrix/cards/superpipeline-gate-v2/) and
its [decision](https://treaty.superjackfruit.com/matrix/answers/superpipeline-gate-decision-v2/), the
[question card](https://treaty.superjackfruit.com/matrix/cards/superpipeline-question-v2/) and its
[answer](https://treaty.superjackfruit.com/matrix/answers/superpipeline-question-answer-v2/), and the
[receipt](https://treaty.superjackfruit.com/matrix/receipts/superpipeline-gate-outcome-v1/) that closes a decided gate.

**A board whose chat has moved.** Board chat is moving to a separate communication service, one
board at a time, and exactly one path serves a board. A board listed in the hub's
`BOARD_CHAT_MOVED_BOARDS` setting is no longer served here: nothing pushed or relayed for it is
posted, its old room is told once that its chat has moved, and any answer typed in that room is
ignored, so a stale card cannot decide anything twice.

**Buttons only.** A question whose agent offered no options cannot be answered from the room, and
the room says where it can be answered rather than pretending.

**Some questions approve an exact operation.** A strict decision (a Salaam agent asking to write a
file) and a harness permission routed through a board both carry what they would do: the summary,
the files and their previews, or the command. An updated app shows it and binds your answer to that
exact version; an answer for a version that has since changed, or one that arrives after the
decision expired, is refused. Replying with a number can **decline** such a question but never
approve it — the reply cannot show you what you would be approving — so the room points you to an
updated app or the board instead.

**A gate may offer a choice of versions.** An agent drafting a post can hand over up to three
versions; the gate then asks you to choose one. An updated app shows each version and approves the
one you pick; request changes and reject send the whole set back. Each version is shown within an
equal share of the room's space, so a long one never crowds out the others, and a version that could
not be shown in full here cannot be chosen from the room — choose it on the board. An older app, the
phone's Lock Screen and a reply by number never approve any version: they can only send the set back,
and say where to choose. Once a version is approved, the room's receipt names it.

**A gate may need more than one approver.** A workspace owner or admin can set a stage to need two
to five approvals — from the stage's deciders, or from the workspace's owners and admins — before
its gate passes. Each approval short of that is said in the room as a reply to the gate
([gate progress](https://treaty.superjackfruit.com/matrix/notices/agentpod-gate-progress-v2/)), for example
"Approved by asha — 1 of 2. Waiting for 1 more.", and the gate stays open; the approval that reaches
the number passes it, and the room's receipt says so. Each person counts once: approving again is
refused with a reply saying it is still waiting for others, and an approval from someone who does
not count for that gate is refused with a reply saying why. One rejection or request for changes
still ends the gate at once. The delivery is manual unless everyone who approved chose automatic.

**An approval may wait for its release time.** A workspace owner or admin can set a stage to hold
its approvals for a cooling-off period (5 minutes to 7 days), and a post can say it must not go out
before a set time. The gate then says so before anyone approves ("If approved, it goes ahead after
Mon 16 Nov, 09:00 UTC"). An approval is recorded at once but does not act until that time: the
room's receipt says "Approved by rakesh — goes ahead after … unless pulled back", and nothing is
posted or advanced until then. Until it acts, anyone who may decide the gate, or a workspace owner
or admin, can **pull it back** with a comment, from the app or on the board; that sends the work back
for changes, and the room replies "Pulled back by … — returned for changes: …"
([pulled back](https://treaty.superjackfruit.com/matrix/notices/agentpod-decision-pulled-back-v2/)). When the time comes
the room replies "Released — it went ahead." ([released](https://treaty.superjackfruit.com/matrix/notices/agentpod-decision-released-v2/)) or, if what was approved changed or expired meanwhile,
"Did not go ahead: …". Pulling back after it went ahead is refused, and nobody can move the time.

**A gate may be decided by checks.** A workspace owner or admin can give a stage up to five
machine checks: CI on the card's linked pull request, or a verdict on its latest run. The checks run
before anyone is asked. While they run the card waits on the stage and nothing is posted; once every
check has passed, the gate opens as usual and lists them ("Checks: build (CI) ✓, quality (verdict)
✓."). A check that fails sends the card back for changes, and the board's room says so ("CI check
“build” failed on “Ship it” — returned for changes."). Checks still pending past the stage's
timeout are reminded and then escalated like any decision: the workspace's owners and admins are
invited, and a card ([checks waiting](https://treaty.superjackfruit.com/matrix/cards/agentpod-checks-waiting-v2/)) lists the
checks so they can **override** one ([the override](https://treaty.superjackfruit.com/matrix/answers/superpipeline-check-override-v2/)), with a comment, from the app or
on the board. The room then says who overrode which check and why. Both lines are Treaty notices:
[check failed](https://treaty.superjackfruit.com/matrix/notices/agentpod-check-failed-v2/) and
[check overridden](https://treaty.superjackfruit.com/matrix/notices/agentpod-check-overridden-v2/). Agents never override, and
whoever produced the work cannot override a check on it.

## A card waiting on you

A card also stops on a person when its agent keeps failing, says it is **blocked**, or is **not
authorised** to go on. That reaches the board's room too, as its own card
([the waiting card](https://treaty.superjackfruit.com/matrix/cards/superpipeline-attention-v2/)): what is wrong, what the
agent said, and three choices.

- **Resume here** — with a required instruction for the next attempt.
- **Resume at an earlier stage** — one choice per earlier stage, with the same instruction.
- **Archive** — with an optional remark.

Moving the card forward is not offered from chat: a move skips the stage's work and cancels its
gates, which deserves the board. Your answer goes to the board as you, and names the exact wait you
were shown — if the card was resumed, archived or moved on the board meanwhile, or now waits on
something else, the board refuses it, nothing changes, and the room says so. A card that parks again
arrives as a new card. Whoever settles it, here or on the board, the card in the room closes.
The answer is an [attention answer](https://treaty.superjackfruit.com/matrix/answers/superpipeline-attention-answer-v2/), and the
card closes by its [outcome](https://treaty.superjackfruit.com/matrix/receipts/superpipeline-attention-outcome-v1/).

An older app shows the card as text with a link to the board; an updated app shows the buttons.

## When nobody answers

A board can give a stage a **timeout**: remind after so long, escalate after longer. It applies to
everything waiting on that stage — its gate, an agent's question, a delivery follow-up, a waiting
card. The board keeps the clock; nothing is ever approved, rejected or resumed because time passed.

- **Each card says when.** A gate, question, follow-up or waiting card with a timeout carries its
  deadline, so an updated app can show "escalates in 3 h".
- **The reminder** ([decision reminded](https://treaty.superjackfruit.com/matrix/notices/superpipeline-decision-reminded-v1/)) is a
  short reply to the card in the board room: *Still waiting: "Launch post"
  has waited 3 h for an approval.* Once per decision.
- **The escalation** ([decision escalated](https://treaty.superjackfruit.com/matrix/notices/superpipeline-decision-escalated-v1/)) invites the workspace's **owners and admins** — as your workspace's Accounts
  settings list them, and only those who have linked a Matrix account — into the board room, then
  replies to the card: *Escalated to workspace admins after 6 h …*, with a link to the card. Once per
  decision. An invited admin sees what the room sees and answers like anyone in it; the board judges
  every answer by its usual rules. Each admin is invited to a board once: somebody who leaves the room
  is not invited back by the next escalation. Because the room is encrypted, an admin cannot read what
  was posted before they joined, so when they join, each card still waiting is **moved below**: posted
  again in full — preview, options, deadline — with the escalation under it. The copy below is the one
  that counts; the earlier card says *Moved below* and an answer to it is refused, so nothing is
  answered twice. If the board cannot be read at that moment, only the escalation (with its link) is
  posted again.

A board that more than one workspace on the hub knows is never escalated, and a card the room never
showed is not replied to.

A gate whose approval subject **expires** before anyone approves it is closed by the board; the card
in the room closes as *Expired*, and the board parks the card for a person (it arrives as a waiting
card).

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
