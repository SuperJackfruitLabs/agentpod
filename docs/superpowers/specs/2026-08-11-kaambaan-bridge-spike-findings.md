# kaambaan Bridge Spike — Findings

**Date:** 2026-08-11 · **Status:** complete — all five research questions answered against live stations

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

## RQ2 — Permission round-trip · **BLOCKED — the return path does not exist in kaambaan**

The outbound half works. The inbound half is unimplemented.

### What works

An agent posts `postActivity {type: 'elicitation', signal: 'select', signalMetadata: {...}}` and the card moves to `input-required` (`board-do.ts:1350`; `signal: 'auth'` routes to `auth-required` instead). Verified live against a running board.

### What does not

**There is no way for a human to answer.** Three independent confirmations:

1. **`human_reply` is never fired.** The transition `input-required → working` is defined in `packages/contract/src/state-machine.ts:54` and **nothing in `apps/api/src` invokes it.** Same for `gate_request_changes` and `account_linked` — transitions that exist on paper with no code path.
2. **No gate is created.** After the elicitation, the board snapshot's `gates` array is empty, so `POST /v1/boards/{board}/gates/{gate}/resolve` — the working stage-review flow — has nothing to act on. Gates come from `submitForReview`, not from elicitations.
3. **Nothing constructs a `prompt` activity.** The contract's `ActivityType` includes `prompt` ("human-authored"), but `AgentActivityType` in `board-do.ts:267` is only the five agent types, and no code anywhere creates one.

So an elicitation is a **dead end**: the card sits at `input-required` until the 15-minute heartbeat reclaim frees it, and the agent blocked on the ACP permission request is never answered.

### Consequence for the strategy

§7 currently says *"Gates are already built — on both sides. A stage gate needing human approval is exactly an ACP permission request, and kaambaan's `input-required` is exactly where an ACP permission lands."*

The **state** mapping is right. The **return path** is not built. Stage-review gates work end to end (`gates-rest.test.ts` proves approve, reject and separation-of-duties); mid-run elicitations do not. And ACP permission requests map to elicitations, not to stage gates — so the ACP permission round-trip cannot complete through kaambaan today.

**This is a kaambaan-side task, and it is small**: an authenticated endpoint that posts a `prompt` activity against a run, firing `human_reply` to return the card to `working`, with the answer payload carried back to the waiting agent. The state machine already models it; only the wire and the handler are missing.

Until it exists, the bridge should run sessions in a mode that does not block — `accept-edits` or `full-auto` — or hold permission answering on the AgentPod side, where the console's existing permission UI already works.

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

5. **§7's "gates are already built on both sides" needs qualifying.** Stage-review gates are. Mid-run elicitations — which is what ACP permissions actually are — have no return path in kaambaan. **This is the one thing that blocks a `ask`-mode bridge**, and it is a small kaambaan-side task.

Plus the service-identity task — the shared static `API_TOKEN` is not an identity for a fleet-scale bridge (now Horizon 3).

## Verdict

**The seam holds. Harden it.** Four of five questions came back positive or neutral; the fifth (RQ2) is blocked by a gap in kaambaan that the state machine already anticipates and that nobody had noticed because no real agent had ever raised an elicitation against it.

Nothing found argues for abandoning the §7 boundary. Everything found argues that the *strategy document was written from docs rather than code* on both sides — five of the corrections here contradict a written claim, and every one of them was cheap to find once something real was running.
