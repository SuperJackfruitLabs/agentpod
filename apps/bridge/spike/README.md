# Bridge Spike — THROWAWAY CODE

Answers RQ1–RQ5 in [`docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-design.md`](../../../docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-design.md).

**This is not production code.** No tests, no error handling, no retries, no reconnection. It exists to produce a verdict on whether the §7 seam between AgentPod and kaambaan holds when a real harness on a real machine drives a real card. Horizon 2 rewrites it test-first under `apps/bridge/` or deletes it.

It is deliberately exempt from the repo's TDD rule, on the condition that it never becomes production. Every step here ends in an *observation*, not a passing test.

## Prerequisites

- kaambaan checked out at `~/Projects/kaambaan` and running locally
- An AgentPod account on `hub.agentpod.dev` with at least one enrolled node
- Two stations advertising the `acp` capability, on **different platforms and different harnesses** — the plan targets Codex on the macOS node and Hermes on a Linux node
- **A disposable workspace on each.** Task 8 deliberately strands a running agent mid-edit.

## Run

```bash
# 1. kaambaan, in its own terminal
cd ~/Projects/kaambaan && pnpm --filter @kaambaan/api dev     # wrangler dev on :8787

# 2. seed a board, an agent and a card
cd apps/bridge/spike && bun run seed                          # prints BOARD_ID and AGENT_TOKEN

# 3. write .env (see below), then drive it
bun run bridge
```

## `.env`

```sh
KAAMBAAN_URL=http://localhost:8787
TENANT_ID=tnt_spike
BOARD_ID=          # from `bun run seed`
AGENT_TOKEN=       # from `bun run seed`, starts kbn_

HUB_URL=https://hub.agentpod.dev
HUB_EMAIL=
HUB_PASSWORD=
STATION_ID=        # a station advertising `acp`, with a DISPOSABLE workspace
```

`.env` is gitignored. Do not commit credentials.

## Scripts

| Command | What it does |
|---|---|
| `bun run seed` | Creates board + stages + agent + card in local kaambaan |
| `bun run scripts/stub-run.ts` | Claims and completes one card with no ACP at all — proves the kaambaan half |
| `bun run scripts/probe-acp.ts` | Opens a live ACP session and records the distinct event kinds — RQ1's input |
| `bun run bridge` | The actual bridge loop: claim → session → activities → gate → complete |
| `CARD_ID=… bun run observe` | Polls card state while a station is stranded — RQ4 |

## Output

Raw captures land in `findings/` (gitignored except the two write-ups):

- `acp-raw.jsonl` — every WS frame from a live session
- `bridge-timing.jsonl` — inter-event gaps, for RQ3
- `rq2.jsonl` — permission request, wait duration, answer
- `rq4.jsonl` — card state over time during the reclaim experiment
- `rq1-mapping.md`, `rq1-side-by-side.md` — the written RQ1 evidence

The verdict is written to `docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-findings.md`.
