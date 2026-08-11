# kaambaan Bridge Spike — Design

**Date:** 2026-08-11 · **Status:** draft (brainstormed with Rakesh)

## Purpose

Validate or kill the §7 seam in [the suite strategy](../../strategy/2026-08-10-suite-strategy.md) before Horizon 0 builds anything on it. The strategy now assumes AgentPod bridges to kaambaan as a Kaambaan-compatible agent — the fleet becomes the work plane's executor.

That assumption rests on a contract that has never met a real machine. Every kaambaan test drives a synthetic in-process agent through `cloudflare:test`'s `SELF.fetch`. The conformance kit proves the contract is *self-consistent*; it cannot prove it survives a persistent ACP session that blocks mid-flight on a permission request, or a station behind CGNAT that drops halfway through a claim.

**This is a spike, not a feature.** Its deliverable is a written verdict. If it passes, Horizon 2 hardens the bridge; if it fails, §7 is rewritten before a line of production code depends on it.

## Decisions (from brainstorm)

1. **REST, not MCP.** They have different callers — software decides here, not a model. REST is also what the conformance kit exercises, and `POST /v1/agents` mints a bearer that authorizes a claim with no OAuth dance.
2. **No shared package in either direction.** kaambaan's contract is `private: true`, designed for wire projection, and on zod 4 against our zod 3.25. The bridge validates with its own schemas.
3. **Lands as `apps/bridge`** in this monorepo — its own process and deploy, sharing contract packages directly, without the cross-repo tax.
4. **Both Linux and macOS, and more than one harness.** The earlier draft confined the spike to Linux to keep #228 off the critical path; Rakesh will absorb the macOS re-prompts. This is the better call for RQ1 — different harnesses emit different ACP event shapes, and envelope fidelity that holds for one proves little.
5. **Against the live hub** (`hub.agentpod.dev`) and the real fleet, not a local hub. RQ4 is about disconnection and reconnection, and a loopback connection cannot fail the way a real one does.
6. **Poll for the spike; webhooks in Horizon 2.** `work.available` push is implemented in kaambaan (`push/deliver.ts`, with SSRF protection) and our hub is publicly reachable, so webhooks work — but kaambaan's own design says push only tells an agent to call `claim`, which stays atomic. The spike polls every **5s**; H2 subscribes to `work.available` and keeps a slow (60s) poll as a safety net, since a missed webhook must never strand a card.
7. **One agent, one station.** One-agent-per-station and AgentCard serving are Horizon 2.
8. **`acp_events` stays authoritative.** The kaambaan activity envelope is a projection of it, never a second source of truth.

## Verified facts (2026-08-11 — kaambaan @ `573a9ba`, AgentPod @ `55159bd`)

- `TaskState` is A2A-exact: `submitted · working · input-required · auth-required · completed · rejected · failed · canceled` (their comment: "spelled with a single 'l' to match A2A exactly").
- REST `/v1/*` is live. `POST /v1/agents {name, capabilities}` → `{agent, token}`, `kbn_`-prefixed; capabilities are read from the token's agent record, so a claim needs the bearer alone.
- `@kaambaan/agent-sdk` exposes `KaambaanAgent` and `runOnce(agent, worker)` — a client library, not just a spec.
- `apps/api/test/conformance.test.ts` drives a reference agent through a two-stage pipeline over the public REST contract only, asserting claim → complete → handoff-received → nothing-left-to-claim.
- Verbs: `claim · getCard · listWork · heartbeat · postActivity · addReference · submitForReview · complete · block · release · fail`. `heartbeat` and `postActivity` both carry `leaseEpoch` — lease fencing is in the contract.
- **Agents never set task state directly.** State is *derived* from the latest meaningful activity. Doc 04 describes a `requestInput` verb; no such call exists on the wire. The mechanism is `postActivity {type: 'elicitation'}`, which the state machine maps to `input-required` (`state-machine.ts:93`, `board-do.ts:1350`). Another instance of read-the-code-not-the-docs.
- `elicitation`, `response`, `error` and `prompt` activities **must** carry a `body` string (`activity.ts:31`). Structured payloads ride alongside in `signal` / `signalMetadata`.
- `apps/api/src/adapters/claude-code.ts` normalizes `claude -p --output-format stream-json` into the activity envelope and states it expects an external *bridge* to POST each result. That bridge is what this spike builds.
- `HEARTBEAT_TIMEOUT_MS = 15 * 60 * 1000` (`board-do.ts:16`), marked `⚠️ OPEN` in kaambaan's own docs/08 §3. A separate circuit breaker auto-blocks a card for a human after consecutive failed/reclaimed runs.
- **Reclaim immediately re-offers the card.** `reclaimExpired` ends the run with `outcome='reclaimed'`, then `endAttempt` re-queues it and notifies `work.available` (`board-do.ts:1500–1512`). This is what makes RQ4 concrete rather than theoretical.
- Outbound push is implemented — `apps/api/src/push/{deliver,ssrf}.ts` and the `work.available` event — so the H2 bridge can subscribe rather than poll.
- kaambaan's README and roadmap say "P0 — Foundations"; the code is through roughly P5/P6. **Read the tests, not the phase labels.**
- AgentPod side: 39 stations on the Mac node alone (claude-code 25, opencode 8, codex 5, openclaw 1), all advertising `acp`.

## Research questions

The spike succeeds by answering these with evidence, not by producing working code. Each is falsifiable.

**RQ1 — Envelope fidelity.** Does the ACP event stream map onto kaambaan's five activity types (`thought · action · response · elicitation · error`) without information loss?
*Method:* enumerate every ACP event kind emitted during one real run; map each; list what has no home.
*Fails if:* tool-call structure, file diffs, or reasoning blocks can only be represented by stuffing markdown into `body`. That would mean the board can never render what the console renders, and attempts-comparison degrades to comparing prose.
*Known pressure point:* four of the five activity types require a `body` string, so anything structured must ride in `action`/`parameter`/`result` or `signalMetadata`. ACP tool calls and diffs are structured; whether they fit is the question.

**RQ2 — Permission round-trip.** Does an ACP permission request survive `input-required` and back to `working`?
*Method:* run a card whose work triggers exactly one permission prompt. The bridge posts `postActivity {type: 'elicitation', body, signal: 'select', signalMetadata}` — carrying ACP's permission options as the structured payload, since `body` is a required markdown string and the options are not text. A human answers on the board; the bridge routes the answer back into the blocked ACP call.
*Fails if:* the lease epoch invalidates while waiting on a human, the ACP permission options cannot survive the `signalMetadata` round-trip, or the answer cannot be routed back into the blocked call.

**RQ3 — Lease versus thinking time.** What heartbeat cadence does a long, silent agent need?
*Partly answered from code:* `HEARTBEAT_TIMEOUT_MS = 15 * 60 * 1000` (`board-do.ts:16`) — fifteen minutes, and flagged `⚠️ OPEN` in kaambaan's own docs/08. Generous enough that ordinary thinking should not trip it, which downgrades this risk.
*Method:* heartbeat every 60s while a run is live; record the longest ACP silence observed.
*Fails if:* a real run's silence approaches fifteen minutes — in which case the timeout is the wrong number, not our cadence.

**RQ4 — Double execution on reclaim. The one this spike exists for.**
kaambaan reclaims a card when an agent goes quiet. But a station that dropped its *gateway connection* **is still running the harness** — the box keeps editing files. The code makes this concrete:

```
board-do.ts:1510  UPDATE runs SET status='ended', outcome='reclaimed' …
board-do.ts:1511  this.endAttempt(…)   // endAttempt re-queues + notifies work.available
```

The card is **immediately re-offered to every eligible agent** while the original station works on. If another agent claims it — or the same fleet claims it onto the same station — two runs edit one workspace.
*Method:* force a gateway disconnect mid-run (kill the connection, not the harness); wait out the timeout; observe whether the card is re-offered and what the station is doing meanwhile. **Use a disposable workspace** — this runs on the live fleet.
*Fails if:* reclaim can produce concurrent execution with no fencing on our side. The fix likely belongs in AgentPod — a run refusing to resume under a superseded lease epoch — but its shape is a spike output, not an input.

**RQ5 — Usage attribution.** Does the ACP stream carry token usage we can attach to activities, per harness?
*Soft fail:* if usage is unavailable, H3's cost-per-run needs another source, and the strategy's "nobody else can compute that" claim needs qualifying.

## Architecture (spike only)

```
kaambaan (wrangler dev, local)
  ⇅  REST /v1/*  —  claim · heartbeat · postActivity · complete
                     (elicitation is an activity type, not a verb)
apps/bridge  (Bun, this monorepo)
  • one kaambaan agent identity, one station
  • poll-claim loop (pull is kaambaan's default; push is an accelerator we skip)
  • ACP event → activity envelope projection
  ⇅  hub session API (existing)
hub
  ⇅  broker stream (existing gateway rails)
node-agent (Linux station)
  ⇅  stdio
harness in ACP mode
```

The bridge is the only new component. Everything below it already exists and is not modified by the spike — if the spike needs to change the hub or node-agent to work at all, that is itself a finding.

## Scope fence

**In:** one board, one stage, one card, one station, one harness, one permission gate, one forced disconnect.

**Out:** one-agent-per-station, AgentCard serving, `changeset`/delivery, retries and backoff, concurrency and WIP limits, multiple cards, console UI, the MCP surface, production error handling, and anything to do with orgs.

## Environment

- **kaambaan:** local `wrangler dev`. No deploy — the spike must not need Cloudflare infrastructure to produce its verdict. Its outbound webhooks are unused here anyway (we poll).
- **Hub:** the live `hub.agentpod.dev`, against the real fleet. RQ4 is about a connection failing the way real connections fail.
- **Stations:** at least two, spanning **both** an enrolled Linux node and the macOS node, and **at least two different harnesses**, so RQ1's mapping is not an artefact of one harness's event vocabulary. Workspaces must be disposable — RQ4 deliberately strands a running agent.
- **macOS caveat:** #228 means updates re-prompt for TCC permissions. Accepted deliberately; it is friction during the run, not a threat to the verdict.

## Testing

Spike code is exploratory and exempt from the repo's TDD rule, with one hard condition: **it does not merge to `main`.** It lives on a branch and is either rewritten test-first when the bridge graduates in Horizon 2, or deleted.

Two spike outputs become real tests at that point:

- The RQ1 mapping table becomes a fixture asserting every ACP event kind has a defined projection.
- The RQ4 finding becomes a regression test wherever the fencing lands — per the repo rule that every bug fix ships with one.

## Deliverable

`docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-findings.md` — a verdict on RQ1–RQ5 with evidence, and an explicit recommendation: **harden**, **harden with changes to §7**, or **abandon the seam**.

## Open questions

1. **Which two harnesses, and which two stations?** Settled in principle — one Linux, one macOS, two different harnesses — but the specific pair needs naming before the plan. The macOS node carries claude-code, opencode, codex and openclaw; the Linux fleet runs Hermes and OpenClaw.
2. **Windows is claimed but not built.** The intent is that stations run on Linux, macOS *or Windows*. Today the release matrix is `linux/{amd64,arm64}` and `darwin/{amd64,arm64}` only, and service management is systemd + LaunchAgent. Windows needs a `windows/amd64` target, a service integration (SCM or scheduled task), and path/process handling that currently assumes POSIX — a piece of work, not a matrix row. **Out of scope for this spike**, but it should become a Horizon 1 item rather than an assumption.
