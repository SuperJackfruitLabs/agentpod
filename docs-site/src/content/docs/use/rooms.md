---
title: Talking to an agent in a room
description: The Matrix bridge — every station gets an identity and a room, so an agent whose harness never spoke Matrix can be reached from a phone.
---

A station is a place an agent works. It is also, if you turn the bridge on, **somebody you can
message**.

Every adopted station gets a Matrix identity and a room of its own. You send a message, the hub
hands it to the harness as a turn, and the agent's reply comes back as that agent — in a client you
already have, on a phone you already carry. The harness itself never learns Matrix exists.

This is the half of AgentPod that is not a console. The console is for operating the ground an
agent stands on; the room is for working with the agent.

## What you get per station

| | |
|---|---|
| **an identity** | the station appears as a user, named for its node and station key. The member list shows the readable form. |
| **a room** | one per station, created when the station is adopted |
| **a space** | rooms hang under a space named for the machine they run on. A flat roster is fine at thirty agents and unusable at two hundred; clients that read the hierarchy group the list for free. |

Rooms are **encrypted at creation**. Any client that can read an encrypted room can read these;
there is nothing extra to turn on.

## What reaches the room

- **The agent's replies**, posted as the agent, streaming as the turn progresses
- **Voice notes**, in both directions — see [Voice notes](/use/voice/)
- **Permission questions**, when the agent wants to run a tool and its mode says to ask
- **A card when a turn fails**, saying what failed rather than going silent — see
  [When a turn fails](/use/errors/)
- **Approval gates and questions from a board**, if the workspace is linked to a
  [superpipeline](https://docs.superpipeline.dev) board — see [Working a board](/use/boards/)
- **Images** you send, passed to the agent rather than just their file name

## Answering a permission question

An agent in `ask` mode parks when it wants to run a tool, and the question is posted where you are:

```
Permission needed: Write src/main.ts

1. Allow once
2. Allow always
3. Reject

Reply with the number, or the option's name.
```

Reply `1`, or `Allow once`. **Nothing else counts.** A reply that is not plainly one of the options
approves nothing and shows the list again.

That pedantry is deliberate. Against options named *Allow once* and *Allow always*, a bare "yes"
does not say which — and approving a tool call you did not mean to approve is the one failure worth
being awkward about.

A question **stops standing** the moment the turn moves on: answered in the console, cancelled, or
failed. A room can never approve something that was already decided.

## Messaging an agent is dispatching it

Sending a message spends the agent's time, so it needs the same authority as dispatching it any
other way — and **approving a permission question is dispatching by another name**, so it needs
that authority too.

Who may message which agent is read from a `mayDispatch` claim the hub signed into your token. It
is not a header, not a parameter, and not derived from anything sent alongside. See
[Dispatch and grants](/use/grants/).

## Mid-turn messages are held, not refused

A message that arrives while the agent is mid-turn is **held and delivered when the turn ends**,
rather than refused. The room says so as a notice. Refusing would make the room a worse place to
talk than a terminal, which is the opposite of the point.

## Notifications on a phone

The hub is the **push gateway**. A client registers a pusher with the homeserver, the homeserver
calls the hub for every event that should reach a phone, and the hub turns each call into one push
per device.

A **message** push carries the room, the event id and an unread count — not the message. The
device fetches and decrypts the event itself and words the notification locally. A push that
carried the text would put an encrypted room's contents through a service that has no business
seeing them.

One addition, and it is counts rather than text: the push for an agent's answer that ended a turn
with tool calls also carries how many steps ran and how many failed, which is what a client's
widget recap reads.

### The one exception: the fleet Live Activity

By operator decision of 2026-09-29, the Lock Screen fleet card is **pushed by the hub**, and those
pushes carry **agent names, the current step's title, and a pending decision's question and option
labels in plaintext** — readable by Apple in transit.

That is a deliberate widening of the gateway's otherwise strict line, taken so the card can say
something useful rather than "an agent needs you". It is the only place it applies: message pushes
still carry ids only, and nothing else changed.

A permission request or a gate the hub posted is also tagged on the push as time-sensitive, so it
reaches a person through Focus — the tag, not the text.

Pushes are configured per deployment and are optional: a hub with no push configuration answers
that route with a `404` and still boots. Pushes are not worth taking a control plane down for.

## Turning it on

The bridge is off unless the hub is configured for it: a homeserver URL, a server name, and the
application-service tokens. Deployment detail lives in the operator guide rather than here, because
it is a property of your hub and not of the product.

With the bridge off, everything else in AgentPod works exactly as it does now. Nothing in the
console depends on it.

## Next

- [Voice notes](/use/voice/) — speaking to an agent, and being answered
- [When a turn fails](/use/errors/) — the error card, and the harness plugins behind it
- [Working a board](/use/boards/) — agents that take work off a superpipeline board
- [Dispatch and grants](/use/grants/) — who may talk to whom
