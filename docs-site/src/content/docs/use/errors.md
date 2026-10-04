---
title: When a turn fails
description: One error shape whichever harness failed, the card a client can draw, and the plugins that recover what ACP drops.
---

A model provider runs out of quota. A credential expires. A request is malformed. What should reach
the room is the provider's own sentence.

What used to reach it depended entirely on which harness the agent ran. Six harnesses fail six
different ways over ACP: some reject the prompt with real text in the message, some emit the error
as an ordinary message chunk and resolve the turn normally — so the error arrives **posing as the
agent's answer** — and some drop the error entirely and resolve the turn, so the room says "the
agent completed without a reply" while the real reason sits in a log on a machine you are not
looking at.

AgentPod standardises this itself rather than waiting for six upstreams.

## One error shape

Every failed turn is normalised into one shape, whichever harness produced it: a **kind**, the
provider's or harness's **own words untrimmed**, which harness it was, and — when they are
knowable — the provider, the model, and each attempt that was made.

The kinds are a closed vocabulary: `quota`, `rate_limit`, `auth`, `bad_request`,
`context_exhausted`, `timeout`, `provider_unavailable`, `refusal`, `max_tokens`, `cancelled`,
`node_offline`, `harness_exited`, and `unknown`.

`unknown` is there deliberately. A failure that does not fit is reported as not fitting, rather
than squeezed into the nearest kind and misread later.

## The card in the room

A failure is posted as a notice carrying a **card a client can draw** — the kind, the sentence, the
harness, and the attempts if there were several. A client that does not understand the card shows
the prose; a client that does draws the card.

Four rules keep it honest:

- **One error per failed turn**, led by the model that was actually asked for. A turn that tried
  three models does not produce three cards; it produces one card listing three attempts.
- **The error is held until the turn ends, and dropped if the agent answers.** An error mid-turn
  that the harness then recovers from is not a failure, and reporting it would teach you to ignore
  the cards.
- **A recovered fallback is no error.** If the first provider failed and the second answered, you
  got an answer.
- **A run that ended well after its failure was reported is no error either.**

Errors reach encrypted rooms like anything else.

## Recovering what ACP drops

Two harnesses dropped their error before it ever reached the hub, so no amount of care at the hub
could recover it. For those, AgentPod ships a small plugin that runs inside the harness and reports
what the harness knows and the protocol discards:

| plugin | for |
|---|---|
| `agentpod-errors` | OpenClaw |
| `agentpod-errors` | Pi |

They report the failure; the hub normalises it into the shape above. Install them with `apn`, or
review and apply plugin changes across stations with `fleet plugins` — see
[apn and fleet](/use/cli/#plugins).

A third plugin, `agentpod-live`, reports a turn's *progress* rather than its failure: that the
agent is thinking, that an answer has begun streaming, and when the turn ended.

## Why not just fix the harnesses

The upstream issues are reported. Nothing here waits on them being accepted, because a fleet
running six harnesses cannot have its error reporting gated on six other projects' release
schedules — and a harness you pinned for a different reason would keep the old behaviour anyway.

## Next

- [Talking to an agent in a room](/use/rooms/) — where the card arrives
- [apn and fleet](/use/cli/) — installing and reviewing plugins
