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
4. **Target a Linux station, not the Mac.** Issue #228 means every macOS update re-prompts for TCC permissions; the one experiment whose job is a clean signal should not run on a surface with known permissions friction.
5. **One agent, one station.** One-agent-per-station and AgentCard serving are Horizon 2.
6. **`acp_events` stays authoritative.** The kaambaan activity envelope is a projection of it, never a second source of truth.

## Verified facts (2026-08-11 — kaambaan @ `573a9ba`, AgentPod @ `55159bd`)

- `TaskState` is A2A-exact: `submitted · working · input-required · auth-required · completed · rejected · failed · canceled` (their comment: "spelled with a single 'l' to match A2A exactly").
- REST `/v1/*` is live. `POST /v1/agents {name, capabilities}` → `{agent, token}`, `kbn_`-prefixed; capabilities are read from the token's agent record, so a claim needs the bearer alone.
- `@kaambaan/agent-sdk` exposes `KaambaanAgent` and `runOnce(agent, worker)` — a client library, not just a spec.
- `apps/api/test/conformance.test.ts` drives a reference agent through a two-stage pipeline over the public REST contract only, asserting claim → complete → handoff-received → nothing-left-to-claim.
- Verbs: `claim · getCard · listWork · heartbeat · postActivity · addReference · submitForReview · complete · block · release · fail`. `heartbeat` and `postActivity` both carry `leaseEpoch` — lease fencing is in the contract.
- **Agents never set task state directly.** State is *derived* from the latest meaningful activity. Doc 04 describes a `requestInput` verb; no such call exists on the wire. The mechanism is `postActivity {type: 'elicitation'}`, which the state machine maps to `input-required` (`state-machine.ts:93`, `board-do.ts:1350`). Another instance of read-the-code-not-the-docs.
- `elicitation`, `response`, `error` and `prompt` activities **must** carry a `body` string (`activity.ts:31`). Structured payloads ride alongside in `signal` / `signalMetadata`.
- `apps/api/src/adapters/claude-code.ts` normalizes `claude -p --output-format stream-json` into the activity envelope and states it expects an external *bridge* to POST each result. That bridge is what this spike builds.
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
*Method:* measure the longest ACP silence in a real run against kaambaan's reclaim timeout.
*Fails if:* ordinary agent thinking trips `heartbeat_timeout`.

**RQ4 — Double execution on reclaim. The one this spike exists for.**
kaambaan reclaims a card via `heartbeat_timeout → submitted` when an agent goes quiet. But a station that dropped its gateway connection **is still running the harness** — the box keeps editing files. If another agent claims that card, two agents work the same task, and on the same workspace if it is the same station.
*Method:* force a disconnect mid-run (kill the gateway connection, not the harness); observe whether the card becomes reclaimable and what the station is doing meanwhile.
*Fails if:* reclaim can produce concurrent execution with no fencing on our side. A fix likely belongs in AgentPod — the run identity refusing to resume a superseded lease — but the shape of that fix is a spike output, not an input.

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

- **kaambaan:** local `wrangler dev`. No deploy — the spike must not need Cloudflare infrastructure to produce its verdict.
- **Station:** a Linux node with a harness advertising the `acp` capability.
- **Hub:** open question below.

## Testing

Spike code is exploratory and exempt from the repo's TDD rule, with one hard condition: **it does not merge to `main`.** It lives on a branch and is either rewritten test-first when the bridge graduates in Horizon 2, or deleted.

Two spike outputs become real tests at that point:

- The RQ1 mapping table becomes a fixture asserting every ACP event kind has a defined projection.
- The RQ4 finding becomes a regression test wherever the fencing lands — per the repo rule that every bug fix ships with one.

## Deliverable

`docs/superpowers/specs/2026-08-11-kaambaan-bridge-spike-findings.md` — a verdict on RQ1–RQ5 with evidence, and an explicit recommendation: **harden**, **harden with changes to §7**, or **abandon the seam**.

## Open questions

1. **Which harness on which Linux box?** The Mac carries four; the strategy's fleet ground-truth is Hetzner boxes running Hermes/OpenClaw. Needs a named target.
2. **Hub: local or the real one?** Local against the test Postgres is isolated and cheap but proves less about CGNAT and reconnection — which is exactly RQ4's territory. Running against `hub.agentpod.dev` with a real enrolled node tests the thing that matters, at the cost of touching the live fleet.
3. **Poll cadence for `claim`.** Pull is kaambaan's default; the spike needs a number, and RQ3's answer may change it.
