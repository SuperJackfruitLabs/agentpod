# kaambaan Bridge Spike — Findings

**Date:** 2026-08-11 · **Status:** partial — RQ1, RQ3, RQ5 answered against live stations; RQ2 and RQ4 not yet run

Answers the research questions in [the spike design](./2026-08-11-kaambaan-bridge-spike-design.md). Evidence is in `apps/bridge/spike/findings/`.

## Setup actually used

| | |
|---|---|
| kaambaan | local `wrangler dev`, `573a9ba`, `DEV_AUTH=true` |
| Hub | live `hub.agentpod.dev` |
| Station A | **Codex** on the macOS node `node_161e685104dc488ebd11` |
| Station B | **Hermes** on a Linux fleet node |
| Prompt | `"List the files in this directory, then stop."` — identical on both |

---

## RQ1 — Envelope fidelity · **PASS WITH CHANGES**

Both harnesses emit exactly 8 distinct event kinds. The top-level mapping is not the problem; three specific things are.

### 1. Volume makes the naive projection unusable

| Harness | ACP events | Wall clock | Activities at 1:1 |
|---|---:|---:|---:|
| Codex | 57 | 13s | 48 |
| Hermes | **1,051** | 53s | **1,045** |

*The same trivial prompt.* Hermes streams token-by-token — 840 `agent_message_chunk` plus 202 `agent_thought_chunk` — so a 1:1 projection would fire **over a thousand HTTP POSTs at the board for one short instruction**, and an 18× spread between harnesses means no fixed rate limit fits both.

**This is the headline RQ1 result and no synthetic test could have produced it.** Ephemeral chunks must be coalesced — buffered and flushed on a timer or on a non-ephemeral boundary — before the bridge posts anything. kaambaan's envelope already anticipates this with `ephemeral: true` ("render transiently, replaced by the next activity"), but nothing in either system enforces that a producer coalesces first.

### 2. Three kinds have no projection

| Kind | Payload | Verdict |
|---|---|---|
| `available_commands_update` | the harness's slash-command catalogue | Deliberate drop — no board representation, and none wanted |
| `session_info_update` | `{threadStatus: {type: active\|idle}}`, `{title}` | Deliberate drop — kaambaan derives its own state; forwarding ours would fight its state machine |
| `usage_update` | `{used, size}` | Deliberate drop — see RQ5; it is not what it sounds like |

None is a blocker, but all three were invisible until a real harness ran: the design anticipated `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan` — and `plan` never appeared while three unanticipated kinds did.

### 3. One genuine loss

`agent_thought_chunk` → `thought`. kaambaan has no reasoning affordance distinct from ordinary messages, so the console's collapsible reasoning block cannot be reconstructed from the activity stream. Hermes emitted 202 of these; on a board they are indistinguishable from what the agent actually said.

**Verdict: the seam carries the work, but a bridge that projects 1:1 is not viable.** Coalescing is a requirement, not an optimisation.

---

## RQ2 — Permission round-trip · **NOT RUN**

Requires a card whose work triggers a permission prompt under `ask` mode. The code path exists (`bridge.ts:handlePermission`) and the projection emits `elicitation` with ACP's options in `signalMetadata`, but the gate-resolution shape on the board is still unverified — the design flagged this and it remains open.

---

## RQ3 — Lease versus thinking time · **PASS**

| Harness | Longest silence | `HEARTBEAT_TIMEOUT_MS` | Headroom |
|---|---:|---:|---|
| Codex | 6.6s | 900s | 136× |
| Hermes | 12.3s | 900s | 73× |

Ordinary thinking comes nowhere near the reclaim timeout. A 60s heartbeat is comfortable. **Caveat:** both runs were trivial. A genuine multi-minute task — a long build, a slow test suite — was not exercised, and that is where a silence approaching 15 minutes would actually live.

---

## RQ4 — Double execution on reclaim · **NOT RUN**

Needs a 15-minute wall-clock wait. The reasoning that motivated it is unchanged and still evidenced in kaambaan's code (`board-do.ts:1500–1512`: reclaim ends the run, re-queues the card, notifies `work.available`). `scripts/observe-reclaim.ts` is written and ready.

---

## RQ5 — Usage attribution · **FAIL**

**Neither harness emits token counts or cost. At all.**

Searched both captures for `inputTokens`, `input_tokens`, `outputTokens`, `output_tokens`, `costUsd`, `total_cost_usd` — **zero occurrences across 1,108 events**.

The one field that sounds right is not:

```jsonc
// Codex
{"sessionUpdate": "usage_update", "used": 16256, "size": 258400}
// Hermes
{"sessionUpdate": "usage_update", "used": 18375, "size": 262144}
```

That is **context-window occupancy** — how full the context is — not tokens consumed and not money. It cannot be summed across a run, and two `usage_update` events per run would not be enough to sum anyway.

### This invalidates a load-bearing claim in the strategy

§8 currently states:

> ACP adapters emit token usage (the Codex adapter advertises it explicitly). Add a usage event type and, keyed by run, we get cost per task, per agent, per machine, per person. **Nobody else can compute that for self-hosted agents, because nobody else is on the box.**

The last sentence is true and useless: nobody else can compute it, *and neither can we* — not from the ACP stream. Being on the box does not help when the harness never reports the number.

**§8 needs revising, and the cost thread in §11 and Horizon 3 depends on it.** Options, none free:

1. **Parse harness-native logs** rather than the ACP stream. kaambaan's own `adapters/claude-code.ts` reads `claude -p --output-format stream-json`, whose terminal `result` event *does* carry `total_cost_usd` — so the data exists, just not over ACP. This means a per-harness cost adapter, which is exactly the N-harness cost §10 warns about.
2. **Push it upstream** — ask ACP to carry usage, since every client wants it.
3. **Estimate** from context-window deltas. Cheap, wrong, and worse than nothing for anything billable.

---

## Two gaps found on the way, independent of any verdict

### The hub's service identity is weaker than assumed — but it exists

An earlier draft of this document said the hub had *no* bearer or API-key path. **That was wrong.** `apps/hub/src/auth/middleware.ts` accepts, in order: a static `API_TOKEN` mapping to `DEFAULT_USER_ID`; a Better Auth session token as `Authorization: Bearer`; or a session cookie. It also reads `?token=` as a query fallback, which is how a WebSocket authenticates.

So a service credential exists. It is just a **single shared static secret mapping every caller to one default user** — no per-service identity, no rotation, no scoping. For Horizon 2 that is a real weakness, and it connects directly to the H3 note about a station carrying two credentials.

The spike runs on a Better Auth session token used as a bearer, which works for both REST and the WS handshake.

### `@kaambaan/agent-sdk` is a subset of the documented envelope

Its `AgentActivity` exposes only `{type, body, action, ephemeral, signal}` — no `usage`, `parameter`, `result` or `signalMetadata`. Those are precisely the fields RQ1, RQ2 and RQ5 need, so the bridge hand-rolls its REST calls. Either kaambaan widens the SDK or every bridge author rediscovers this.

### Four kaambaan doc-versus-code drifts

Recorded in full in `apps/bridge/spike/findings/verified-surface.md`: no `requestInput` verb exists (post an `elicitation` activity instead); a `response` activity does not advance a card despite doc 04 §4 saying so; there is no card-read endpoint (the board snapshot is the only read surface); and `pnpm dev:setup` with tenant `tnt_dev` is a prerequisite that fails with an opaque `D1_ERROR` otherwise.

---

## Recommendation so far: **harden, with changes to §7 and §8**

Nothing found so far kills the seam. The contract carries the work, the states line up, and the lease is comfortable. But three amendments are already earned:

1. **§7 gains a coalescing requirement.** A bridge that posts 1:1 is not viable at 1,051 events per prompt. This belongs in the strategy, not just the implementation, because it is a property of the seam rather than of our code.
2. **§8's cost claim must be qualified.** Cost per run is not available over ACP today. Either the claim goes, or the roadmap gains a per-harness cost adapter with N-harness maintenance attached.
3. **Horizon 2's bridge item gains a service-identity task** — the shared static `API_TOKEN` is not an identity for a fleet-scale bridge.

**This recommendation is provisional.** RQ2 and RQ4 are unrun, and RQ4 is the one with the power to force a redesign — if reclaim can produce two agents on one workspace, the fix lands in AgentPod's run identity and changes Horizon 0's shape.
