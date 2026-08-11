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

- **The SDK ships the agent half.** `@agentclientprotocol/sdk` exports `AgentSideConnection` and `ndJsonStream`. We implement an interface; nothing hand-rolls JSON-RPC. (The hub already uses `ClientSideConnection` from the same package.)
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

- Speaks ACP to the editor over stdin/stdout via `AgentSideConnection`.
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

## Open questions

1. **Does an editor tolerate an agent it did not spawn the state of?** Attaching to a session with existing history means the editor joins mid-conversation. ACP has session replay, but whether Zed renders a pre-existing transcript on attach is unverified and shapes slice 1.
2. **Which token, in practice.** The static `API_TOKEN` maps every caller to one user, which is wrong for a laptop client. A Better Auth session token is per-user but expires. Neither is right; the choice affects what slice 1 documents, and the real fix is the Horizon 3 credential work.
