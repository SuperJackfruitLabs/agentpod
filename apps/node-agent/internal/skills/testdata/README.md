# Synthetic bundle fixtures

`export-*.tar.gz` and `exports.json` were generated with the canonical SJL library
exporter at commit `9eb23464736073205aae699af9a457887bce9eea`. The input catalog,
skill and notice are entirely synthetic and defined in `generate_exports.py`.
The fixtures contain no retained model answers or real SJL skill content.

Regenerate with that library's Python environment:

```sh
/path/to/agent-skills/.venv/bin/python generate_exports.py /path/to/agent-skills
```

All six outputs include a resource path longer than a classic tar header allows,
forcing the exporter's PAX long-path format. Manifest metadata includes Unicode,
an HTML-sensitive character, a literal escape and U+2028, checking Python/Go digest
agreement rather than only a Go-generated fixture. Ordinary Go tests require no
Python or library checkout.

These establish artifact-format interoperability only. They do not establish
native discovery, session loading, behavioral quality, publisher authentication,
installation or rollback.

## Go native-placement probe

The placement unit tests exercise these archives through storage, publication,
upgrade, rollback, removal and recovery. An optional probe adds native discovery:

```sh
cd apps/node-agent
go test -c -o /absolute/path/placement-tests ./internal/skills
python3 internal/skills/testdata/probe_placement.py --harness codex --binary /absolute/path/codex --node-test-binary /absolute/path/placement-tests --output /absolute/path/new-report.json
```

Use `--harness opencode`, `openclaw` or `pi` with an explicit matching binary.
Pi also needs `--pi-skills-module /absolute/path/to/pi/dist/core/skills.js`.
The script creates disposable Git workspaces, invokes the Go test fixture and
queries native discovery. It does not invoke models, read credential stores,
change live settings or grant project trust. OpenCode uses isolated XDG paths;
OpenClaw uses temporary state/config. Only synthetic entries are retained from
native output. Codex uses one app-server with explicit refresh; the others use
fresh processes. Pi invokes its installed directory loader, not a full session.

The `native-placement-*-2026-09-21.json` reports contain 44 passing checks on
Codex 0.155.0, OpenCode 1.18.15, Pi 0.84.1 and OpenClaw 2026.2.12. Stored upgrades
remain undiscovered until publication; retained generations/backups are excluded
after native upgrade, rollback and deactivation. The Go receipt still reports
loading unknown. The `native-placement-admission-*-2026-09-21.json` reports repeat
those 44 checks after adding durable recovery admission. Separate process-exit
tests cover ten transaction boundaries and prove that fresh ACP/terminal managers
refuse new starts until recovery. Those children are shell/cat fixtures, not
native ACP sessions. Broker exposure, external-process/version gates and deployed
native/ACP evidence remain separate requirements.

### Codex ACP discovery comparison

`acp-placement-codex-2026-09-21.json` records all eleven placement lifecycle
checks through codex-acp 1.1.14 and its bundled Codex 0.147.0. The companion
`native-placement-codex-bundled-2026-09-21.json` exercises that same bundled
engine's native app-server discovery. This differs from the earlier host CLI
0.155.0 evidence. Both discover the exported qualified name
`sjl-fixture:sjl-fixture`.

Build the fixture test binary as above, then run:

```sh
python3 -B probe_placement.py --harness codex \
  --binary /absolute/adapter/node_modules/@openai/codex/bin/codex.js \
  --codex-acp-adapter /absolute/codex-acp \
  --node-test-binary /absolute/skills-tests --output /tmp/acp-evidence.json
python3 -B -m unittest discover -s . -p test_probe_codex_acp.py
```

The probe validates the adapter version and uses Node's `createRequire` resolution
to ensure `--binary` identifies its bundled engine. No inherited CODEX_PATH is
passed to ACP. Every scan starts a fresh adapter/session with an isolated HOME
and CODEX_HOME, a credential-free provider pointing at a closed loopback port,
no MCP servers and no client tools. Only `initialize` and `session/new` are sent;
no model prompt is sent. The probe observes `available_commands_update`, bounds
frames/queue/time, terminates the process group and reaps the adapter. Synthetic
client tests run in the required node-agent CI job; real installed-runtime probes
remain opt-in.

The first probe assertion incorrectly expected the unqualified name from a
minimal hand-written fixture. Inspecting the exported fixture's actual command
update established the qualified name; the final report tests that exact name.
The discovery evidence establishes fresh-session advertisement and lifecycle
isolation, not model use, production authentication, trust, existing-session
refresh, AgentPod transport or external-process quiescence. Remote activation
and all other harness ACP comparisons remain pending.
