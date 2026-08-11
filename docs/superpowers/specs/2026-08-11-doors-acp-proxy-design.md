# Doors — ACP proxy — Design

**Date:** 2026-08-11 · **Status:** draft (brainstormed with Rakesh)

## Purpose

Stop being the only way in. Today a station is reachable only through our console; Doors makes any station reachable from any ACP client — Zed, JetBrains, anything that speaks the protocol — including stations behind CGNAT, because the node dials out.

This is the one item in Horizon 1 that is **distribution rather than capability**. It puts stations in front of people who have installed nothing of ours and may never open our console.

## The correction this design starts from

The strategy says "be an ACP *server*". That does not map onto how ACP works, and building it literally would produce something no editor can connect to.

**ACP clients spawn an agent as a subprocess and speak JSON-RPC over its stdio.** They do not dial URLs. A hub that "is an ACP server" has no socket an editor would ever open.

So Doors is a **local stdio proxy**:

```
Zed / JetBrains  (on a laptop)
  ⇅ stdio, ACP JSON-RPC — the editor spawns this like any other agent
apn acp --station <id>                      ← the new piece
  ⇅ WSS
hub.agentpod.dev — existing acp.open / acp.attach / acp.close
  ⇅ broker (existing gateway rails)
node-agent  ⇅ stdio  harness            (on a machine somewhere else)
```

## Decisions (from brainstorm)

1. **The proxy lives in `apn`**, not a second binary. `apn` becomes both a node that serves stations *and* a client that reaches them. Someone running Zed installs `apn` purely as a client — it never enrolls. This avoids a second release pipeline, a second self-update story, and a second thing to sign.
2. **Concurrent attach from the start.** A session may have several clients at once — your console and your Zed on the same live transcript.
3. **One user, many clients.** Not multi-user collaboration: sessions are already scoped by `userId` and shared sessions were explicitly out of scope for the ACP program. Doors does not change that.
4. **Attach to the existing session machinery.** The proxy is another subscriber, not a parallel path. An editor and the console must be able to watch the same session.

## Verified facts (2026-08-11)

Checked against the code, and they make this much smaller than it looks:

- **The SDK ships the agent half, via a fluent API.** `@agentclientprotocol/sdk@1.3.0` exports `agent()` returning an `AgentApp`, built by chaining `.onRequest(...)` / `.onNotification(...)` / `.onConnect(...)` and finished with `.connect(stream)`. Nothing hand-rolls JSON-RPC, and handler params are parsed against the generated ACP schemas before a handler runs.
- **`AgentSideConnection` and `ClientSideConnection` are deprecated.** The SDK says so in-tree: *"@deprecated Prefer `agent`, which registers typed handlers with a single context object"*, and *"@deprecated Prefer `agent({ name }).connect(stream)`"*. They remain for backwards compatibility. **New code uses the fluent API.**
- **The hub is on the deprecated class today** (`ClientSideConnection` in `acp-sessions.ts:40`). That is pre-existing debt, not something Doors introduces — but Doors is the moment it becomes worth paying, because otherwise we add a second deprecated call site.
- **The SDK already ships v1/v2 version negotiation.** `agentProtocolRouter()` returns an `AgentProtocolRouter` with `.withV1(agent)` and `.withV2(agent)`: it consumes the client's `initialize` request and selects the highest configured version that does not exceed what the client asked for, forwarding every later wire item unchanged. Marked `@experimental`.
- **Concurrent attach is already supported by the hub.** `subscribers` is `Map<sessionId, Set<callback>>` and `fanOut` iterates the set (`acp-sessions.ts:191,298`). The console is simply the only client that exists today.
- **Permission answering is already first-answer-wins.** `answerPermission` resolves from `live.pending` and deletes it; a second client answering the same request gets `"No pending permission request."` — a clean error, not a race (`acp-sessions.ts:969–984`).
- **Prompts are already serialised.** A per-session `enqueue()` write queue chains work, so two clients prompting at once queue rather than interleave (`acp-sessions.ts:310`).
- **`acp.attach` already exists** in the contract (`protocol.ts:45`) and streams like `term.attach`.
- `apn` already ships for linux and darwin on amd64 and arm64, self-updates, and verifies against `SHA256SUMS`.

**Consequence:** the hub needs little or no change. Doors is mostly a new `apn` subcommand plus explicit tests for the multi-subscriber behaviour that has always been possible and never been exercised.

## Architecture

### `apn acp`

A stdio ACP agent that proxies to a hub station.

```
apn acp --station <station-id> [--hub <url>] [--token <t>] [--mode ask|accept-edits|full-auto]
```

- Speaks ACP to the editor over stdin/stdout via the fluent API — `agent({ name: "agentpod" }).onRequest(...).connect(stream)` — never the deprecated `AgentSideConnection`.
- Authenticates to the hub as a client (bearer; see Auth below).
- Opens or attaches a session on the station, then relays:
  - editor → hub: `prompt`, `cancel`, permission answers, mode changes
  - hub → editor: session updates, permission requests, errors
- Exits when the editor closes stdin or the session ends.

**It is a relay, not a translator.** The hub already terminates ACP and stores its events verbatim; the proxy's job is to move frames, not to reinterpret them. Anything that needs interpreting is a sign the boundary is wrong.

### Session selection

An editor asks for "an agent", not "session `acps_…`". So:

- `--station <id>` attaches to that station's most recent live session, or opens one if none is live.
- `--session <id>` attaches to a specific session, for the "resume exactly this" case.
- Neither given → error listing the caller's stations, rather than guessing.

### Auth

The proxy authenticates the same way the bridge spike did: `Authorization: Bearer <token>`, accepted by the hub's `authMiddleware` as either the static `API_TOKEN` or a Better Auth session token, with `?token=` for the WebSocket handshake.

> **This is a known weak point, not a design choice.** That credential is a single shared static secret mapping every caller to one `DEFAULT_USER_ID`, with no per-service identity, rotation or scoping — recorded in Horizon 3. Doors makes it more urgent by putting the token on laptops rather than servers. **`apn acp` must never write the token to disk**: it reads `AGENTPOD_TOKEN` from the environment or accepts `--token`, and documents the environment as the supported path.

### Concurrent attach

Already possible; this makes it real and tested.

| Collision | Behaviour | Status |
|---|---|---|
| Two clients watching | Both get live events via `fanOut` | Already works |
| Two clients prompt at once | Serialised by `enqueue()` | Already works |
| Two clients answer one permission | First wins; second gets a clean error | Already works |
| A client disconnects | Its subscriber is removed; session and others unaffected | Needs a test |
| Editor attaches to a console session | Same transcript, both live | Needs a test |

The editor-side surface must reflect that it is *sharing*: when another client answers a permission the proxy did not answer, the editor should see the resolution rather than a request that silently vanishes.

### Protocol versions: build for v2 without waiting for it

ACP v2 is coming, and the SDK has already made room for it. `AgentProtocolRouter` negotiates per connection: register a v1 agent and a v2 agent, and each client gets the highest version both sides support.

That removes the bet. We do **not** have to choose between shipping on v1 now and waiting for v2, and we do not need a flag day.

Two rules follow:

- **`apn acp`'s agent implementation is a pluggable `AgentConnector`, not a hard-wired connection.** Adding v2 then becomes `agentProtocolRouter().withV1(v1).withV2(v2)` — a registration, not a rewrite.
- **We do not adopt the router yet.** It is `@experimental` in the SDK, and v2 is a draft. Shipping Doors on experimental negotiation would make our distribution story depend on someone else's unreleased draft.

> **The docs and the SDK disagree about v2's maturity, and the SDK wins.** The website's v2 overview presents it as an active specification with no stability caveat; the shipping SDK marks v2 support `@experimental`. Where a protocol's own tooling hedges and its marketing does not, believe the tooling.

v2 keeps the outer shape — initialize, session setup, prompt lifecycle — but the [migration guide](https://agentclientprotocol.com/protocol/v2/migration) lists changes that reach further into AgentPod than a proxy alone, and they are worth knowing before we add call sites:

| v2 change | What it touches here |
|---|---|
| **`session/prompt` returns immediately** with an empty result; completion arrives via a `state_update` notification carrying the stop reason | The one change a relay cannot paper over. v1 keeps the response pending until the turn ends; our session service and the proxy both key off that. Different control flow, not a different field name. |
| **`session/set_mode` removed**, replaced by config options | Our permission modes — `ask` / `accept-edits` / `full-auto` — ride on `set-mode`, including `AcpClientMsg` in the contract and the console's mode selector. **15 non-test call sites across hub, console and contract** — measured, and the change that costs us most. |
| **Client `fs/*` and `terminal/*` methods removed** | **No impact, verified.** Our filesystem and terminal are *station capabilities* on the node-agent, not ACP client methods, and the hub answers no `fs/*` or `terminal/*` ACP method on a harness's behalf — grepped, zero call sites. |
| **`tool_call` merged into `tool_call_update`**; upsert semantics with three-state patching, and an agent-generated `messageId` per chunk | `acp_events` stores payloads verbatim so the ledger is insulated, but the console's `transcript.ts` destructures these shapes, and so does the bridge's projection. |
| **`authenticate` → `auth/login`**, `session/load` removed | Renames; cheap. |
| **Permission requests restructured** — prompt copy in a required `title`, `subject.toolCall` carrying only genuine tool-call state | Touches the permission card and the bridge's `elicitation` projection. |

**The guide's own advice is the strategy we had already arrived at:** *"Migrating does not mean dropping v1. v1-only Agents and Clients will remain common for some time, so implementers should support both versions side by side."* Negotiate per connection, keep separate protocol surfaces, share the business logic beneath them.

This sharpens the design rule rather than changing it. **Relay frames, do not reinterpret them** — and note precisely where relaying is not enough: the prompt lifecycle differs structurally, so the proxy needs a per-version notion of "the turn is over", not a per-version field map.

### Deprecation cleanup

The hub's `ClientSideConnection` call site should move to `client()` in the same slice that introduces `agent()` in `apn`. Not scope creep — the alternative is two deprecated call sites across two binaries, and the SDK will eventually drop them.

## Testing

- **node-agent (Go):** a scripted fake hub over WSS — attach, relay a prompt, receive a permission request, answer it, close. Reuses the fake-node rig pattern from the ACP slices.
- **hub:** explicit multi-subscriber tests. Two subscribers on one session both receive events; one disconnecting does not affect the other; the second answer to a permission errors cleanly. These behaviours exist today and are untested because there has only ever been one client.
- **Live verification** against a real station from a real editor before the slice closes, per the repo rule. That means a real Zed pointed at a real Hetzner station.

## Slices

1. **Relay.** `apn acp` speaking ACP over stdio, attaching to an existing session, relaying both directions. Prompt and response only.
2. **Interaction.** Permission requests and answers, cancel, mode. The full session surface.
3. **Sharing.** Multi-subscriber tests, disconnect semantics, and the editor-side treatment of a permission answered elsewhere.
4. **Discovery.** `apn acp --list` to print the caller's stations, so a first-time user can find an id without opening the console.

## Out of scope

Multi-user shared sessions. An `apn` that serves ACP over a socket rather than stdio. Editor-specific packaging or plugins — we ship a binary that speaks the protocol; distribution through Zed's agent registry is a later decision. Rewriting the console to use the same path.

### Attaching mid-conversation — answered by the protocol

**Yes, and the mechanism is `session/load`.** The SDK is explicit: on load the agent should *"restore the session context and conversation history"* and *"stream the entire conversation history back to the client via notifications"*. It is capability-gated — the agent must advertise `loadSession`.

The important part is **who replays**: the *agent* does. And `apn acp` is the agent as far as the editor is concerned. So the proxy's `session/load` handler is a near-direct pass-through of what the hub already provides — `subscribe {sinceSeq: 0}` returns a replay of `acp_events` followed by live updates, which is precisely "stream the history, then continue".

There is a second path, `session/resume`, which *"resumes the session context… without replaying the message history"*, gated on `session.resume`.

That gives the proxy two honest behaviours rather than one guess:

| Editor asks | Proxy does | Result |
|---|---|---|
| `session/new` | opens a fresh session on the station | empty transcript |
| `session/load` | `subscribe {sinceSeq: 0}` → replays history as notifications, then follows live | joins mid-conversation, sees everything |
| `session/resume` | `subscribe {sinceSeq: <latest>}` → live only | joins mid-conversation, sees only what happens next |

**Slice 1 must advertise `loadSession`**, because attaching to a station's existing session is the whole point of Doors — an editor that joins and sees a blank pane has not reached the agent, it has reached a fresh one.

> **v1/v2 divergence, recorded now:** v2 removes `session/load` entirely, and `session/resume` explicitly does *not* replay history. So "join and see what happened" is a v1 affordance whose v2 equivalent is unclear. This is the second structural difference between the versions that a relay cannot smooth over, alongside the prompt lifecycle — and another reason to keep per-version protocol surfaces over shared business logic rather than a field map.
>
> Also noted: `session/fork` is marked **UNSTABLE** in the SDK — *"not part of the spec yet, and may be removed or changed at any point"*. Attractive for run comparison later; not to be built on now.

## Open questions

1. **Which token, in practice.** The static `API_TOKEN` maps every caller to one user, which is wrong for a laptop client. A Better Auth session token is per-user but expires. Neither is right; the choice affects what slice 1 documents, and the real fix is the Horizon 3 credential work.
