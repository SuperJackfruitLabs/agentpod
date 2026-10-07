---
title: "apn reference"
description: "Every apn command and subcommand: synopsis, flags, environment, what it needs and how it exits. Generated from the binary."
---

<!-- Generated from the agentpod-node binary's command table and source. Do not edit by hand:
     cd apps/node-agent && go test ./cmd/agentpod-node -run TestReferencePage -update -->

`apn` (`agentpod-node`) is the resident agent on an enrolled host. Every command acts on **this machine**: its service, its enrolment, the harnesses installed on it. Acting on the fleet as a person is [`fleet`](/reference/fleet/)'s job, and `apn` never reads the credential `fleet login` stores. For the reasoning behind the split, see [apn and fleet](/use/cli/).

Each command's text below is what `apn help <command>` prints, from the same table in the binary. `apn node <command>` is the same as `apn <command>`. This page is generated from that table and the source, and a test fails when a command or flag exists without an entry here.

## Commands

**Service**

| Command | What it does |
|---|---|
| [`apn status`](#apn-status) | Show local service + hub connection state (`--json` for scripts). |
| [`apn start`](#apn-start) | Enable and start the background service. |
| [`apn stop`](#apn-stop) | Stop and disable the service (sticky across reboots). |
| [`apn restart`](#apn-restart) | Restart the running service. |
| [`apn logs`](#apn-logs) | Show service logs (-f to follow, -n N for last N lines). |
| [`apn service`](#apn-service) | Install \| uninstall the platform service (launchd/systemd). |
| [`apn telemetry`](#apn-telemetry) | Show, enable or disable OpenTelemetry export (`--endpoint` URL). |

**Node**

| Command | What it does |
|---|---|
| [`apn node`](#apn-node) | Explicit spelling for the machine-scoped verbs (apn node status, …). |
| [`apn enroll`](#apn-enroll) | Enroll this machine with a hub (`--hub`, `--token`, `--force`, `--otlp-endpoint`). |
| [`apn run`](#apn-run) | Run the agent in the foreground. |
| [`apn native-skills`](#apn-native-skills) | Show, enable or disable native skill placement on this node. |
| [`apn plugin-management`](#apn-plugin-management) | Show, enable or disable Console plugin management on this node. |
| [`apn hermes-skills`](#apn-hermes-skills) | Register or remove the managed skills directory in a Hermes profile. |
| [`apn hermes-live`](#apn-hermes-live) | Install, enable or remove the agentpod-live streaming plugin in a Hermes profile. |
| [`apn openclaw-errors`](#apn-openclaw-errors) | Install, enable or remove the agentpod-errors plugin in OpenClaw. |
| [`apn pi-errors`](#apn-pi-errors) | Install, enable or remove the agentpod-errors extension in Pi. |
| [`apn detect`](#apn-detect) | Print detected harness stations as JSON. |
| [`apn scan`](#apn-scan) | Check this machine's agents for exposure (`--json`). |
| [`apn acp`](#apn-acp) | Attach an ACP editor to a station (`--list`, `--station`). |

**Maintenance**

| Command | What it does |
|---|---|
| [`apn update`](#apn-update) | Self-update from the latest release (`--check`, `--force`). |
| [`apn help`](#apn-help) | Show this list, or one command in detail. |
| [`apn version`](#apn-version) | Print version and platform. |

## Environment

| Variable | Meaning |
|---|---|
| `$AGENTPOD_HUB_URL` | `apn enroll`: the hub, when `--hub` is not given. |
| `$AGENTPOD_ENROLL_TOKEN` | `apn enroll`: the one-time enrollment token, when `--token` is not given. |
| `$AGENTPOD_HUB` | `apn acp`: the hub, when `--hub` is not given. Default `https://hub.agentpod.dev`. |
| `$AGENTPOD_TOKEN` | `apn acp`: a person's hub token. Prefer it to `--token`, which lands in shell history. |
| `$OTEL_EXPORTER_OTLP_ENDPOINT` | `apn run`: the OTLP/HTTP collector to export traces to; unset exports nothing. Normally written to `otel.env` by `apn telemetry enable`. |
| `$OTEL_SDK_DISABLED` | `apn run`: `true` turns export off even with an endpoint set. |

## Exit status

Unless a command says otherwise:

- **0** — it did what it was asked.
- **1** — it failed; the reason is on stderr.
- **2** — a usage error: an unknown command, verb or argument. Nothing was changed.

`-h` or `--help` as the first argument prints the command's help and exits 0 before anything else runs, so `apn stop -h` never stops the service.

## Credentials

Commands that talk to the hub use **this machine's** credential, stored by `apn enroll` in the node config (`~/.config/agentpod-node/config.json` on Linux, `~/Library/Application Support/agentpod-node/config.json` on macOS). It says "I am this host" and nothing more. The exceptions are `apn enroll`, which spends a one-time enrollment token, and `apn acp`, which takes a person's token explicitly.

## apn status

Show local service + hub connection state (`--json` for scripts).

```text
apn status [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | bool | `false` | Print the local and hub state as one JSON object. |

`apn help status` prints:

```text
apn status — show local service state and hub connection state.

Local block: whether the service is installed / enabled / running (with
PID), the binary version, and the config path. Hub block: reachability
and credential validity, checked against the existing
GET /public/nodes/credential-check endpoint (no new endpoints).

Exit code is 0 iff the service is running AND the stored hub credential
is valid — safe to use in scripts/health checks.
```

**Needs:** The node's enrolled credential, for the hub check. Not enrolled is reported, not an error.

**Exit status:** 0 only when the service is running **and** the hub accepts the stored credential; 1 otherwise. Safe in a health check.

```sh
apn status
apn status --json | jq .hub
```

## apn start

Enable and start the background service.

```text
apn start
```

`apn help start` prints:

```text
apn start — enable and start the background service (the symmetric
inverse of 'apn stop').

macOS: `launchctl enable` + `launchctl bootstrap`. Linux: `systemctl
[--user] enable --now`.

If no service is installed yet, this prints a hint pointing at
'apn service install' (or run in the foreground with 'apn run').
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn start
```

## apn stop

Stop and disable the service (sticky across reboots).

```text
apn stop
```

`apn help stop` prints:

```text
apn stop — stop the service AND disable it (sticky across
reboots/logins — it will not come back on its own).

macOS: `launchctl bootout` + `launchctl disable`. Linux: `systemctl
[--user] stop` + `disable`.

Undo with 'apn start' — it re-enables and starts.
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn stop
```

## apn restart

Restart the running service.

```text
apn restart
```

`apn help restart` prints:

```text
apn restart — restart the running service in place.

macOS: `launchctl kickstart -k`. Linux: `systemctl [--user] restart`.
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn restart
```

## apn logs

Show service logs (-f to follow, -n N for last N lines).

```text
apn logs [-f] [-n N]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `-f` | bool | `false` | Follow log output. |
| `-n N` | int | `50` | Number of lines to show. |

`apn help logs` prints:

```text
apn logs [-f] [-n N] — show service logs.

macOS: reads/tails ~/Library/Logs/agentpod-node.log.
Linux: execs `journalctl [--user] -u agentpod-node [-f] [-n N]`.
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn logs -n 200
apn logs -f
```

## apn service

Install | uninstall the platform service (launchd/systemd).

```text
apn service <install|uninstall>
```

Subcommands: [`install`](#apn-service-install), [`uninstall`](#apn-service-uninstall).

`apn help service` prints:

```text
apn service <install|uninstall> — manage the platform service
definition.

install: writes a plist (macOS LaunchAgent) or systemd unit from a
template embedded in the binary, then enables and starts it.
Idempotent — re-running replaces the file and restarts. Non-root
Linux uses a --user unit; root Linux uses a system unit; macOS uses a
LaunchAgent (refuses to run as root).

uninstall: stops, disables, and removes the plist/unit. Idempotent —
a no-op when nothing is installed. Leaves config/enrollment untouched.
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn service install
```

### apn service install

Write the service definition, enable it and start it.

```text
apn service install
```

Idempotent: re-running replaces the plist or unit and restarts the service.

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn service install
```

### apn service uninstall

Stop, disable and remove the service definition.

```text
apn service uninstall
```

A no-op when nothing is installed. Configuration and enrolment are left alone, so `apn service install` brings the same node back.

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn service uninstall
```

## apn telemetry

Show, enable or disable OpenTelemetry export (`--endpoint` URL).

```text
apn telemetry <status|enable|disable>
```

The file is `/etc/agentpod-node/otel.env` for a system unit and `~/.config/agentpod-node/otel.env` for a user unit. From elsewhere, an admin can do the same to every node with [`fleet nodes telemetry`](/reference/fleet/#fleet-nodes-telemetry).

Subcommands: [`status`](#apn-telemetry-status), [`enable`](#apn-telemetry-enable), [`disable`](#apn-telemetry-disable).

`apn help telemetry` prints:

```text
apn telemetry <status|enable|disable> — control this node's OpenTelemetry
export through its otel.env file.

status [--json]: the config path, endpoint, enabled/disabled and, when
enabled, whether the collector answers (a ~2 s GET of <endpoint>/v1/traces;
any HTTP response counts).
enable --endpoint URL: validate (http/https only), write, restart the service.
disable: comment the endpoint out, restart the service.
Nothing is restarted when the file would not change.

Unsupported on macOS (launchd has no env-file hook).
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

**Exit status:** As below for each verb; 1 on macOS, where it is unsupported; 2 for an unknown verb.

```sh
apn telemetry status
```

### apn telemetry status

The config path, endpoint, on or off, and whether the collector answers.

```text
apn telemetry status [--json]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | bool | `false` | Machine-readable JSON output. |

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn telemetry status --json
```

### apn telemetry enable

Turn export on to an endpoint and restart the service.

```text
apn telemetry enable --endpoint URL
```

The URL is validated (http or https only) before anything is written. Nothing restarts when the file would not change.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--endpoint URL` | string | — | OTLP/HTTP collector base URL (http or https). **Required.** |

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn telemetry enable --endpoint https://otel.example.com:4318
```

### apn telemetry disable

Comment the endpoint out and restart the service.

```text
apn telemetry disable
```

**Needs:** The user the node service runs as. A root Linux install manages a system unit; any other Linux user, a user unit; macOS, a LaunchAgent (never as root).

```sh
apn telemetry disable
```

## apn node

Explicit spelling for the machine-scoped verbs (apn node status, …).

```text
apn node <verb> [flags]
```

`apn help node` prints:

```text
apn node <verb> — the explicit form of the machine-scoped verbs.

Every verb apn dispatches is a node verb — this binary is machine-scoped only,
the fleet-acting verbs live in the separate `fleet` binary — and both spellings
work here: `apn status` and `apn node status` are the same command. The bare
forms are kept because existing runbooks name them.
```

**Needs:** Whatever the verb needs.

```sh
apn node status   # the same as apn status
```

## apn enroll

Enroll this machine with a hub (`--hub`, `--token`, `--force`, `--otlp-endpoint`).

```text
apn enroll [--hub URL] [--token TOKEN] [--force] [--otlp-endpoint URL]
```

Writes this machine's identity to `~/.config/agentpod-node/config.json` (Linux) or `~/Library/Application Support/agentpod-node/config.json` (macOS). Re-enrolling replaces only the identity and keeps every local setting, including the native-skill and plugin-management gates. Mint the token with [`fleet invite`](/reference/fleet/#fleet-invite).

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--hub URL` | string | `$AGENTPOD_HUB_URL` | Hub base URL. |
| `--token TOKEN` | string | `$AGENTPOD_ENROLL_TOKEN` | One-time enrollment token from `fleet invite`. |
| `--force` | bool | `false` | Re-enroll even when a valid config exists. |
| `--otlp-endpoint URL` | string | — | OTLP/HTTP collector base URL to enable telemetry export. |

`apn help enroll` prints:

```text
apn enroll [--hub URL] [--token TOKEN] [--force] [--otlp-endpoint URL] — enroll this
machine with a hub.

Falls back to the AGENTPOD_HUB_URL/AGENTPOD_ENROLL_TOKEN environment
variables when the flags are omitted. Idempotent: running it again on
an already-enrolled machine is a friendly no-op unless the stored
credential is no longer valid, or --force is passed.

--otlp-endpoint URL also enables OpenTelemetry export to that collector (validated
before contacting the hub; applies on an already-enrolled machine too; no restart —
same as 'apn telemetry enable'). Ignored with a warning on macOS.
```

**Needs:** A one-time enrollment token — the machine's invitation, not a person's token.

**Exit status:** 0 when enrolled, or already enrolled and kept. 1 when the hub or token is missing, the hub refused the token, or the config could not be written.

```sh
apn enroll --hub https://hub.agentpod.dev --token "$ENROLL_TOKEN"
AGENTPOD_HUB_URL=https://hub.agentpod.dev AGENTPOD_ENROLL_TOKEN=… apn enroll
```

## apn run

Run the agent in the foreground.

```text
apn run
```

Reads the OpenTelemetry variables below at start. Exits when interrupted.

`apn help run` prints:

```text
apn run — run the agent in the foreground: connects to the hub and
handles terminal sessions until interrupted (Ctrl-C).

This is what the installed service runs under the hood; run it
directly for debugging.
```

**Needs:** The node's enrolled credential. Without one it exits 1 and says to enroll.

```sh
apn run
```

## apn native-skills

Show, enable or disable native skill placement on this node.

```text
apn native-skills <status|enable|disable>
```

Subcommands: [`status`](#apn-native-skills-status), [`enable`](#apn-native-skills-enable), [`disable`](#apn-native-skills-disable).

`apn help native-skills` prints:

```text
apn native-skills <status|enable|disable> — control the separate native
skill-placement gate for this node.

Native placement writes into a harness-visible skill directory. It is disabled
by default and must be deliberately enabled by the node operator. `enable` and
`disable` update only this node's local configuration; restart the node service
after either change before the hub can observe the new capability.
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn native-skills status
```

### apn native-skills status

Whether native placement is enabled on this node.

```text
apn native-skills status
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

**Exit status:** 0; 1 when the node is not enrolled.

```sh
apn native-skills status
```

### apn native-skills enable

Allow native skill placement; restart the service afterwards.

```text
apn native-skills enable
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn native-skills enable && apn restart
```

### apn native-skills disable

Refuse native skill placement; restart the service afterwards.

```text
apn native-skills disable
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn native-skills disable && apn restart
```

## apn plugin-management

Show, enable or disable Console plugin management on this node.

```text
apn plugin-management <status|enable|disable>
```

The fleet side of this is [`fleet plugins`](/reference/fleet/#fleet-plugins).

Subcommands: [`status`](#apn-plugin-management-status), [`enable`](#apn-plugin-management-enable), [`disable`](#apn-plugin-management-disable).

`apn help plugin-management` prints:

```text
apn plugin-management <status|enable|disable> — let the Console install and
remove the agentpod-live plugin in this node's Hermes profiles.

Each change is planned on the node, reviewed in the Console and applied only
if the profile still matches the review; the node probes Hermes's version
itself. It is disabled by default. `enable` and `disable` update only this
node's local configuration; restart the node service after either change.
Nothing here restarts a gateway.
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn plugin-management status
```

### apn plugin-management status

Whether the console may manage plugins on this node.

```text
apn plugin-management status
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

**Exit status:** 0; 1 when the node is not enrolled.

```sh
apn plugin-management status
```

### apn plugin-management enable

Allow console plugin management; restart the service afterwards.

```text
apn plugin-management enable
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn plugin-management enable && apn restart
```

### apn plugin-management disable

Refuse console plugin management; restart the service afterwards.

```text
apn plugin-management disable
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn plugin-management disable && apn restart
```

## apn hermes-skills

Register or remove the managed skills directory in a Hermes profile.

```text
apn hermes-skills <status|register|unregister> --profile NAME [--apply]
```

Subcommands: [`status`](#apn-hermes-skills-status), [`register`](#apn-hermes-skills-register), [`unregister`](#apn-hermes-skills-unregister).

`apn help hermes-skills` prints:

```text
apn hermes-skills <status|register|unregister> --profile NAME [--apply] —
a published skill is inert until skills.external_dirs names its directory.
Without --apply the command prints the exact change and writes nothing.
It edits one profile's own config.yaml and leaves the rest of it alone.
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-skills status --profile default
```

### apn hermes-skills status

Whether the profile's config names the managed skills directory.

```text
apn hermes-skills status --profile NAME
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--profile NAME` | string | — | The Hermes profile, a directory under `~/.hermes/profiles/`. **Required.** |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-skills status --profile default
```

### apn hermes-skills register

Add the managed skills directory to `skills.external_dirs`.

```text
apn hermes-skills register --profile NAME [--apply]
```

Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--profile NAME` | string | — | The Hermes profile, a directory under `~/.hermes/profiles/`. **Required.** |
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-skills register --profile default          # show the change
apn hermes-skills register --profile default --apply  # make it
```

### apn hermes-skills unregister

Undo what `register` changed.

```text
apn hermes-skills unregister --profile NAME [--apply]
```

Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--profile NAME` | string | — | The Hermes profile, a directory under `~/.hermes/profiles/`. **Required.** |
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-skills unregister --profile default --apply
```

## apn hermes-live

Install, enable or remove the agentpod-live streaming plugin in a Hermes profile.

```text
apn hermes-live <status|enable|disable> --profile NAME [--apply] [--replace-unmanaged]
```

Subcommands: [`status`](#apn-hermes-live-status), [`enable`](#apn-hermes-live-enable), [`disable`](#apn-hermes-live-disable).

`apn help hermes-live` prints:

```text
apn hermes-live <status|enable|disable> --profile NAME [--apply] [--replace-unmanaged] —
a harness-mode Hermes profile streams into AgentPod clients only with this plugin.
enable installs the copy shipped in this apn, on a Hermes the CI contract tested,
and adds it to plugins.enabled with plugins.stream_reasoning_deltas: true.
Without --apply it prints the exact change and writes nothing. disable removes it
and undoes the configuration edit. Neither restarts the gateway; that is yours to do.
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-live status --profile default
```

### apn hermes-live status

The plugin's install state, the Hermes version and whether it is a tested one.

```text
apn hermes-live status --profile NAME
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--profile NAME` | string | — | The Hermes profile, a directory under `~/.hermes/profiles/`. **Required.** |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-live status --profile default
```

### apn hermes-live enable

Install the shipped plugin and enable it in the profile's config.

```text
apn hermes-live enable --profile NAME [--apply] [--replace-unmanaged]
```

Refused on a Hermes version the plugin was not tested against. Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--profile NAME` | string | — | The Hermes profile, a directory under `~/.hermes/profiles/`. **Required.** |
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |
| `--replace-unmanaged` | bool | `false` | Replace a plugin directory of the same name that this apn did not install. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-live enable --profile default --apply
systemctl --user restart hermes-gateway-default.service
```

### apn hermes-live disable

Remove the plugin and undo the config edit.

```text
apn hermes-live disable --profile NAME [--apply]
```

Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--profile NAME` | string | — | The Hermes profile, a directory under `~/.hermes/profiles/`. **Required.** |
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn hermes-live disable --profile default --apply
```

## apn openclaw-errors

Install, enable or remove the agentpod-errors plugin in OpenClaw.

```text
apn openclaw-errors <status|enable|disable> [--apply]
```

See [When a turn fails](/use/errors/).

Subcommands: [`status`](#apn-openclaw-errors-status), [`enable`](#apn-openclaw-errors-enable), [`disable`](#apn-openclaw-errors-disable).

`apn help openclaw-errors` prints:

```text
apn openclaw-errors <status|enable|disable> [--apply] —
OpenClaw's ACP bridge drops why a turn failed; this plugin reports it to this node.
enable installs the copy shipped in this apn, on an OpenClaw the CI contract tested,
into ~/.agentpod/openclaw and adds it to ~/.openclaw/openclaw.json with
hooks.allowConversationAccess. Without --apply it prints the exact change and writes
nothing. disable removes both. Neither restarts the gateway; that is yours to do.
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn openclaw-errors status
```

### apn openclaw-errors status

The plugin's install state, the OpenClaw version and whether it is a tested one.

```text
apn openclaw-errors status
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn openclaw-errors status
```

### apn openclaw-errors enable

Install the shipped plugin and register it in `~/.openclaw/openclaw.json`.

```text
apn openclaw-errors enable [--apply]
```

Refused on an OpenClaw version the plugin was not tested against. Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn openclaw-errors enable --apply
```

### apn openclaw-errors disable

Remove the plugin and its registration.

```text
apn openclaw-errors disable [--apply]
```

Without `--apply` it prints the exact change and writes nothing. It never restarts a gateway; that is the operator's call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn openclaw-errors disable --apply
```

## apn pi-errors

Install, enable or remove the agentpod-errors extension in Pi.

```text
apn pi-errors <status|enable|disable> [--apply]
```

See [When a turn fails](/use/errors/).

Subcommands: [`status`](#apn-pi-errors-status), [`enable`](#apn-pi-errors-enable), [`disable`](#apn-pi-errors-disable).

`apn help pi-errors` prints:

```text
apn pi-errors <status|enable|disable> [--apply] —
pi-acp drops why a turn failed; this extension reports it to this node.
enable installs the copy shipped in this apn, on a Pi the CI contract tested,
as ~/.pi/agent/extensions/agentpod-errors.ts. Without --apply it prints what it
would do and writes nothing. Nothing needs restarting: each new Pi session loads it.
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn pi-errors status
```

### apn pi-errors status

The extension's install state, the Pi version and whether it is a tested one.

```text
apn pi-errors status
```

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn pi-errors status
```

### apn pi-errors enable

Install the shipped extension into Pi's extensions directory.

```text
apn pi-errors enable [--apply]
```

Refused on a Pi version the extension was not tested against. Without `--apply` it prints what it would do and writes nothing. Nothing needs restarting.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn pi-errors enable --apply
```

### apn pi-errors disable

Remove the extension.

```text
apn pi-errors disable [--apply]
```

Without `--apply` it prints what it would do and writes nothing.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--apply` | bool | `false` | Make the change; without it, print what would change and write nothing. |

**Needs:** The user the node service runs as, editing its own files. No hub contact.

```sh
apn pi-errors disable --apply
```

## apn detect

Print detected harness stations as JSON.

```text
apn detect
```

`apn help detect` prints:

```text
apn detect — print the harness stations detected on this host as
JSON. Debug/ops smoke test for the descriptors; no hub connection
required.
```

**Needs:** Nothing: no enrolment, no hub, no network.

```sh
apn detect | jq '.[].key'
```

## apn scan

Check this machine's agents for exposure (`--json`).

```text
apn scan [--json] [--no-color]
```

See [Checking for exposure](/use/scan/).

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | bool | `false` | Emit the report as JSON. |
| `--no-color` | bool | `false` | Disable ANSI colour (it is already off when stdout is not a terminal). |

`apn help scan` prints:

```text
apn scan [--json] [--no-color] — check the agent runtimes on this
host for the two ways they get taken over: a listener bound to every
network interface, and credential files other users can read.

Needs no hub, no account and no network. Prints a graded report and
exits 0 (clean), 1 (warnings) or 2 (critical), so it works in cron.

A check that cannot determine an answer says so — it is never
reported as a pass.
```

**Needs:** Nothing: no enrolment, no hub, no network.

**Exit status:** 0 clean, 1 warnings, 2 critical.

```sh
apn scan
apn scan --json > posture.json
```

## apn acp

Attach an ACP editor to a station (`--list`, `--station`).

```text
apn acp --list [--hub URL]
apn acp --station ID [--session ID] [--hub URL]
```

See [Attaching an editor](/use/acp/).

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--list` | bool | `false` | List the stations you can attach an editor to. |
| `--station ID` | string | — | Station to attach to; required unless `--list`. |
| `--session ID` | string | — | Specific session to resume. |
| `--hub URL` | string | `$AGENTPOD_HUB`, else `https://hub.agentpod.dev` | Hub base URL. |
| `--token TOKEN` | string | `$AGENTPOD_TOKEN` | Hub token (prefer the AGENTPOD_TOKEN env var). |

`apn help acp` prints:

```text
apn acp --list — show the stations you can attach an editor to.

apn acp --station <id> [--session <id>] [--hub <url>] [--token <t>] —
make a station on another machine look like a local agent to any ACP
client (Zed, JetBrains, anything that speaks the protocol).

The editor spawns this and talks ACP over its stdio; the frames are
piped to the hub, which does the protocol work. Reaches stations
behind NAT or CGNAT, because the node dials out.

Prefer the AGENTPOD_TOKEN environment variable over --token: a token
on the command line lands in shell history.

This is the one command that needs no enrolled node — a laptop can
install apn purely as a client.
```

**Needs:** A person's hub token, from `$AGENTPOD_TOKEN` or `--token` — never this host's credential, and never the file `fleet login` writes. Needs no enrolled node.

**Exit status:** 0 when the editor closes the session. 1 when the hub refuses or drops it. 2 without `--station` or `--list`.

```sh
AGENTPOD_TOKEN=… apn acp --list
AGENTPOD_TOKEN=… apn acp --station stn_123
```

## apn update

Self-update from the latest release (`--check`, `--force`).

```text
apn update [--check] [--force]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--check` | bool | `false` | Resolve and report current/latest version, no changes. |
| `--force` | bool | `false` | Update even when already on the latest version. |

`apn help update` prints:

```text
apn update [--check] [--force] — self-update from the latest GitHub
release.

--check resolves and reports the current/latest version without
changing anything. --force updates even when already on the latest
version. On success the service is restarted automatically; if the
restart fails, the binary is already swapped and this prints a
manual-restart hint.
```

**Needs:** Network access to GitHub releases, and write access to the binary's own path. The download is verified against the release's `SHA256SUMS`.

**Exit status:** 0 when up to date, updated, or (with `--check`) reported. 1 when the release could not be fetched or verified, or the binary was swapped but the restart failed (the right restart command is printed).

```sh
apn update --check
apn update
```

## apn help

Show this list, or one command in detail.

```text
apn help [COMMAND]
apn -h
apn
```

| Argument | Meaning |
|---|---|
| `COMMAND` | one command, to print its detail |

`apn help help` prints:

```text
apn help [command] — with no argument, the commands grouped by purpose; with one,
that command's detail. 'apn <command> -h' prints the same detail, plus the
command's flags and their defaults where it has any.
```

**Needs:** Nothing: no enrolment, no hub, no network.

**Exit status:** 0; 2 for an unknown COMMAND.

```sh
apn help
apn help enroll
```

## apn version

Print version and platform.

```text
apn version
```

`apn help version` prints:

```text
apn version — print the binary version and platform (GOOS/GOARCH).
```

**Needs:** Nothing: no enrolment, no hub, no network.

**Exit status:** 0.

```sh
apn version   # agentpod-node v0.1.90 linux/amd64
```
