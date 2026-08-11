# kaambaan Bridge Spike — Findings

**Date:** 2026-08-11 · **Status:** RQ1, RQ3, RQ4, RQ5 answered against live stations; RQ2 outstanding

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

## RQ4 — Double execution on reclaim · **SPLIT VERDICT: kaambaan PASSES, the workspace does not**

Run against Codex on `~/Projects/research` (backed up first). The bridge was killed mid-run so heartbeats stopped while the hub-owned ACP session kept the harness working.

### Timeline

| t | Event |
|---|---|
| 0s | Bridge killed. Card `working`, `delegate=agt_59945e…`, session `status=working` |
| ~180s | **Codex finished on its own** — `summaries/` written, session `idle` |
| **900s** | **Card reclaimed** — `state=submitted`, `delegate=None`. Exactly `HEARTBEAT_TIMEOUT_MS`, to the second |
| ~1400s | Second agent claimed it: `run_ac35286e…`, **`leaseEpoch=2`**, `attempts` 1→2 |

### What this proves

**kaambaan fences correctly.** The new claim came back with `leaseEpoch=2`. Every run call carries its epoch, so the original run — still holding epoch 1 — can no longer write activities, complete, or otherwise corrupt board state. The design's fear that reclaim lets two agents *drive the same card* is unfounded: kaambaan's state machine is safe.

**But the fence is around kaambaan's data, not around the machine.** The original harness kept executing with no idea its lease had been revoked. In this run it happened to finish first, so nothing collided. Had it still been working — which is the whole point of a task that outlives 15 minutes — two harnesses would have been writing the same directory. kaambaan would have correctly ignored the first one's *activities* while its *file writes* landed anyway.

**Nothing tells the harness to stop.** That gap is entirely on our side, and it is the concrete deliverable this spike was run to find:

> **When a run's lease is superseded, the bridge must end the ACP session.** The hub owns session lifecycle and already exposes `DELETE /api/acp/sessions/:id`. The bridge learns its epoch is stale on the next `heartbeat` or `activities` call — the natural place to hook it.

### Two secondary findings

- **`attemptCount` increments on *claim*, not on reclaim.** The plan assumed the reverse and would have watched the wrong signal. Reclaim moves `working → submitted` and clears `delegateAgentId`; those are what to watch.
- **A completed-but-unreported run is re-dispatched.** The work was finished and on disk at t+180s, yet at t+900s the board offered it again — the bridge died before calling `complete`, so the board never learned. This is likely the *common* failure in production, more so than concurrent writes: not a race, just silently repeated work. It also means an at-least-once delivery model, so **card work must be idempotent or the bridge must check for prior output before starting.**
- Releasing the second run with `fail` pushed the card to `input-required` — kaambaan's consecutive-failure circuit breaker, working as documented.

### Workspace outcome

Clean. Three summaries created, the three originals byte-identical to the backup. The backup was the right call and was not needed.

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

## Recommendation: **harden, with changes to §7 and §8**

The seam holds. The contract carries the work, the states line up, the lease is comfortable, and kaambaan's fencing is sound — RQ4, the question with the power to kill this, came back with kaambaan behaving correctly. Four amendments are earned:

1. **§7 gains a coalescing requirement.** A bridge that posts 1:1 is not viable at 1,051 events per prompt, and the 18× spread between harnesses means no fixed rate limit fits. This is a property of the seam, not of our code.
2. **§8's cost claim must be qualified.** Cost per run is not available over ACP on any harness tested. Either the claim goes, or the roadmap gains per-harness cost adapters with the N-harness maintenance §10 warns about. The context window is worth keeping in its place.
3. **The bridge must end the ACP session when its lease is superseded.** kaambaan fences its own state; nothing fences the machine. This is the concrete engineering deliverable of the spike and it belongs in Horizon 2's bridge item.
4. **Card work must be idempotent, or the bridge must check for prior output.** Reclaim is at-least-once: a finished-but-unreported run gets re-dispatched.

Plus the service-identity task — the shared static `API_TOKEN` is not an identity for a fleet-scale bridge (now Horizon 3).

**Outstanding:** RQ2 (permission round-trip). It is the last unanswered question and the lowest-risk one — the state mapping is already confirmed on both sides, and what remains is verifying that ACP's option list survives `signalMetadata` and that an answer routes back into the blocked call.
