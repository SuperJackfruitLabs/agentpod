> **Preserved 2026-08-14 from `apps/bridge/spike/findings/verified-surface.md`**, which was
> deleted with the spike in #310. The raw captures went with it; this distilled record did
> not, because two documents cite it as the evidence for four kaambaan doc-vs-code drifts —
> and a spec pointing at a file that no longer exists is how measured findings quietly become
> folklore.
>
> **What has changed since it was written.** "There is no card-read endpoint" is **fixed**:
> kaambaan PR #33 added `GET /v1/boards/:boardId/runs/:runId`, returning the claim response
> re-readably, which is what removed the bridge's dev-header dependency. The `tnt_dev` setup
> requirement still holds for local work. The elicitation and `response`-activity findings
> still hold, and the missing elicitation return path remains open.
>
> Everything below is unedited.

# Verified kaambaan surface (2026-08-11, kaambaan @ `573a9ba`, local `wrangler dev`)

Everything here was observed against a running instance, not read from docs. It corrects
four things the design and plan assumed.

## Setup requires `tnt_dev` / `usr_dev`

`apps/api/scripts/seed-dev.sql` seeds exactly one tenant (`tnt_dev`), one user (`usr_dev`)
and their membership. Any other `X-Tenant-Id` fails the catalog foreign key with an opaque
`500 D1_ERROR: FOREIGN KEY constraint failed`, with nothing naming the tenant. `pnpm
dev:setup` (D1 migrations + seed) is a prerequisite for `pnpm dev` — the plan omitted it.

## There is no card-read endpoint

| Path | Method | Result |
|---|---|---|
| `GET /v1/boards/{board}/cards` | GET | `405 method not allowed` |
| `GET /v1/boards/{board}/cards/{card}` | GET | `405 method not allowed` |
| `GET /v1/boards/{board}` | GET | `200` — the whole snapshot |

The board snapshot is the only read surface: `{boardId, tenantId, name, stages, cards, gates,
references, usage, github}`. Each card carries `{id, title, spec, ownerUserId,
currentStageKey, state, delegateAgentId, priority, contextId, createdAt, updatedAt, costUsd,
overBudget, attemptCount}`.

This is better than what the plan guessed at: `attemptCount` is exactly the RQ4 signal (a
reclaim should increment it), and `costUsd` is per-card metering for RQ5.

`POST /v1/boards/{board}/cards` returns `{card: {…}}` — the id is at `card.id`, not `cardId`.

## A `response` activity does not advance the card

Observed across one full run:

```
claim     → state=working    stage=work  attempts=1
thought   → state=working    stage=work  attempts=1
response  → state=working    stage=work  attempts=1
complete  → state=submitted  stage=done  attempts=1
```

Doc 04 §4's activity table says `response` "drives state to `completed`". It did not move
the card. `complete` advanced it to the next stage, where it sits as `submitted` awaiting
that stage's human owner — which is correct pipeline behaviour.

**Consequence for the bridge:** posting a terminal `response` activity is not sufficient.
`complete` must be called explicitly. (Caveat on precision: the snapshot exposes *card*
state; doc 04 describes *task* state. These may diverge, and the spike only observed the
card. Either way the operational rule holds.)

## Claim returns a lease epoch starting at 1

`{claimed: true, runId, leaseEpoch: 1, card, stage, handoff}` — `leaseEpoch` must be echoed
on every subsequent run call (`heartbeat`, `activities`, `complete`, `fail`).
