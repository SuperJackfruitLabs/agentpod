# agentpod-live (Hermes plugin)

Makes a **harness-mode** Hermes station stream into AgentPod clients.
It sends the same to-device events the hub sends for bridge-mode stations:

- `dev.agentpod.stream.delta` carries the answer.
- `dev.agentpod.thought.delta` carries the reasoning.
- `dev.agentpod.tool.update` carries each tool call.

The event bodies and the pacing are the same as the hub's; see `apps/hub/src/services/matrix-as/live.ts`.

**Why it is needed.** The hub skips harness rooms (`inbound.ts` returns for any `identityMode !== "bridge"`), so it never sees the turn. Hermes also hard-codes Matrix to buffer-only (`gateway/run_turn.py`), so the answer arrives as a single message at the end.

**How it works.** The plugin observes the turn through `pre_llm_call`, `on_stream_delta`, `pre_tool_call`, `post_tool_call` and `post_llm_call`.

- It reads the room and reader from the gateway's session context.
- It sends events with the agent's own Matrix token, `PUT /sendToDevice` to the reader's devices (`*`).
- All sending is best-effort, and the room message Hermes sends is unchanged.

## The fleet card

The hub's fleet Live Activity (the Lock Screen card in Supermessage) learns about a bridge-mode turn from the hub's own bridge. It never sees a harness-mode turn, so the plugin reports each turn itself:

- turn started; each tool step, with its title and `completed`/`total`; turn finished, with `total`/`failed` and the first failed step;
- the answer beginning to stream (`writing`, no text), once each time the turn moves into it, for the card's Writing phase. Text that arrives while a tool is still running does not count. A hub older than this report kind drops it;
- an approval asked (`pre_approval_request`), once its prompt is in the room, and answered (`post_approval_response`);
- the answer's event id, for a turn that ran tools, so the answer's push carries the turn's counts.

Each report is one JSON line to the node's fleet socket, `~/.agentpod/fleet.sock` (`AGENTPOD_FLEET_SOCKET` overrides). The node forwards it to the hub over its authenticated connection, and the hub decides whose card it belongs on (`packages/contract/src/fleet-report.ts`). A report carries no more text than the card shows: a step title cut to 60 characters, a question cut to 120.

- **The answer's event id** is given to plugins by no hook. Hermes's Matrix adapter logs `Matrix: sent event %s to %s` when a send returns, and a logging handler reads the id from that line. If Hermes changes the line, answer pushes lose their counts and nothing else; the contract test pins it.
- **Best-effort, like the live events.** Reports have their own thread. A report waits at most 0.5 s on the node and is dropped on any failure. A node without the socket (older than the release that added it) costs one failed connect per report, and the plugin logs it once.
- **Needs `MATRIX_USER_ID`.** Without it the hub could not place a report, so none is made; streaming is unaffected.

## Install on one profile

`apn` ships this plugin and installs it. On the host that runs the profile:

```sh
apn hermes-live status  --profile <profile>           # what is there, and whether it loaded
apn hermes-live enable  --profile <profile>           # review: the files and the config diff
apn hermes-live enable  --profile <profile> --apply   # install and enable
```

`enable` does three things:

- **Version gate.** It refuses a Hermes outside the range the CI contract tested, and says why. If the version cannot be determined, it holds rather than refuses.
- **Plugin files.** It installs the copy embedded in this `apn` at `<profile>/plugins/agentpod-live/`.
- **Configuration.** It adds the plugin to `plugins.enabled` and sets `plugins.stream_reasoning_deltas: true`, which reasoning deltas need in order to reach plugins. Every other line of `config.yaml` is left byte for byte, and the file is backed up beside itself first.

It never restarts the gateway. Restart it from the Console, or with `systemctl --user restart hermes-gateway-<profile>.service`. After that, `status` shows the gateway's `agentpod-live: registered` line and each turn's outcome.

`apn hermes-live disable --profile <profile> --apply` removes the plugin and undoes the configuration edit. If nothing else changed since enable, it restores the backup exactly.

A copy installed by hand is handled in one of two ways:

- If it is byte-identical to this plugin, `enable` adopts it.
- If it differs, `enable` refuses until you pass `--replace-unmanaged`, which sets it aside; `disable` restores it.

The streaming and fleet hooks need `MATRIX_HOMESERVER` and `MATRIX_ACCESS_TOKEN`, which the Matrix platform already requires. When either is missing, they are not registered. That matters because a registered stream hook makes Hermes stream every model call. The remote-bench hooks below are registered either way.

## Remote bench

While the node has attached the profile to a remote bench (`bench.remote.attach`), Hermes's terminal backend is SSH into the bench and every file tool lands there. The node writes `<profile>/agentpod-bench.json` (0600; the bench id, working directory and expiry, no secret) and removes it on detach. The plugin treats a missing, malformed or expired file as detached, and then does nothing.

- **Replace-mode `patch` becomes V4A.** ACP edit approval previews a replace-mode edit by reading the target from the gateway host's own disk (`acp_adapter/edit_approval.py`), so on a remote backend it denies every one. A `pre_tool_call` hook, which runs before edit approval, rewrites the call into the one-hunk V4A update (`mode="patch"`) that searches for exactly `old_string` and replaces it with exactly `new_string`. Both modes apply through the same fuzzy matcher, uniqueness rule included. `replace_all`, an empty `old_string`, a carriage return or a path with surrounding whitespace has no V4A form; those calls are blocked with a message that tells the model to send V4A instead. Only a path under the bench's working directory is rewritten: it is resolved lexically against that directory, `..` included, and named resolved in the V4A header. An absolute path outside it, a `..` escape or a `~` path (never expanded to the gateway's home) is blocked with a message naming the directory the bench exposes. V4A and `write_file` calls pass untouched. Hermes offers no per-profile switch to turn replace mode off.
- **The model is told where it is.** A plugin prompt section (`agentpod-remote-bench`) names the bench and its working directory for each new session. Hermes freezes sections per session, so an open session keeps what it started with; the hub opens a new session after attach and detach.

The node, not the plugin, refuses an attach that would copy credential files to the bench (`terminal.credential_files`, or a skill declaring `required_credential_files`): Hermes has no hook for its file sync.

## Supported Hermes versions

- `requires_hermes` in `plugin.yaml` is the oldest Hermes the contract tests (`hermes-fleet.ref`). Hermes itself refuses to load the plugin below it.
- `hermes-tested.max` is the newest Hermes the contract passed on. Only `apn hermes-live enable` enforces it. An upper bound in `requires_hermes` would stop streaming on the next `hermes update`.
- Raise `hermes-tested.max` only after the contract's `release` job passes on that Hermes. Copy `__init__.py`, `plugin.yaml` and `hermes-tested.max` into `apps/node-agent/internal/hermeslive/plugin/` in the same change; CI checks that they match.

## Test

```sh
python3 -m unittest test_agentpod_live   # the plugin's own policy; stdlib only
<hermes-venv>/bin/python contract/run_in_hermes.py   # the plugin inside a real Hermes
```

The contract test runs one real `AIAgent` turn with the plugin loaded by Hermes's own plugin discovery:
- A local fake model streams reasoning, a tool call and an answer.
- A local fake homeserver records every `sendToDevice`.
- The test then checks the events against the hub's contract.
- Remote bench: for each edit in `EQUIVALENCE` (a mid-line fragment, whole lines, a duplicate `old_string`, a whitespace-sensitive edit, a CRLF file), replace mode on a local backend and the rewritten V4A must leave the same file and fail together; attached, the edit may land only through V4A (replace mode is made to fail, as it does remotely). A path outside the working directory and `replace_all` must be blocked, and the bench note must be in the system prompt only while attached. The unit tests that need Hermes's own V4A parser run here too; the stdlib-only unit job skips them.

It needs a Python with Hermes installed (`uv pip install -e 'hermes-agent[acp]'`).

CI (`.github/workflows/hermes-plugin.yml`) runs it against three versions of Hermes:
- `fleet` is the commit in `hermes-fleet.ref`, which is what the stations run.
- `release` is Hermes's latest release.
- `main` is Hermes's main branch.

PRs run `fleet` and `release`. The nightly run adds `main` and opens an issue when it fails.

When the stations' Hermes is upgraded, update `hermes-fleet.ref` in the same change.
