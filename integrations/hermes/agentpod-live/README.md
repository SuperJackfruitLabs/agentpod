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

## Install on one profile

```sh
P=/root/.hermes/profiles/<profile>
cp "$P/config.yaml" "$P/config.yaml.bak-$(date +%Y%m%d%H%M)"
mkdir -p "$P/plugins" && cp -r agentpod-live "$P/plugins/"
```

Then add to `$P/config.yaml`:

```yaml
plugins:
  enabled: [agentpod-live]      # merge into any existing list
  stream_reasoning_deltas: true # reasoning deltas reach plugins only with this
```

Restart the profile's gateway: `systemctl --user restart hermes-gateway-<profile>.service`.

The plugin needs `MATRIX_HOMESERVER` and `MATRIX_ACCESS_TOKEN`, which the Matrix platform already requires. When either is missing, it registers no hooks. That matters because a registered stream hook makes Hermes stream every model call.

**To remove it**, restore the config backup and restart the gateway.

## Test

```sh
python3 -m unittest test_agentpod_live   # the plugin's own policy; stdlib only
<hermes-venv>/bin/python contract/run_in_hermes.py   # the plugin inside a real Hermes
```

The contract test runs one real `AIAgent` turn with the plugin loaded by Hermes's own plugin discovery:
- A local fake model streams reasoning, a tool call and an answer.
- A local fake homeserver records every `sendToDevice`.
- The test then checks the events against the hub's contract.

It needs a Python with Hermes installed (`uv pip install -e 'hermes-agent[acp]'`).

CI (`.github/workflows/hermes-plugin.yml`) runs it against three versions of Hermes:
- `fleet` is the commit in `hermes-fleet.ref`, which is what the stations run.
- `release` is Hermes's latest release.
- `main` is Hermes's main branch.

PRs run `fleet` and `release`. The nightly run adds `main` and opens an issue when it fails.

When the stations' Hermes is upgraded, update `hermes-fleet.ref` in the same change.
