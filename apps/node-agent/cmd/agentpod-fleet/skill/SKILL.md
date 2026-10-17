---
name: agentpod-fleet
description: Use when operating an AgentPod fleet through its hub with the `fleet` CLI (agentpod-fleet) - listing or updating nodes, adopting stations, staffing agents, the bridge roster, grants, skills and plugins, config, and fleet updates. Not for acting as a machine (that is `apn`) and not for interactive terminals or ACP sessions.
---

# fleet - operating an AgentPod fleet

Written for fleet {{VERSION}}. If `fleet version` prints something else, run `fleet help` and `fleet <verb> -h` and trust those over this file.

## What fleet is, and is not

`fleet` (the binary is `agentpod-fleet`) acts on a fleet through its hub as a PRINCIPAL: a person or an agent holding a token. It never acts as a machine and never uses a node's credential.

`apn` (`agentpod-node`) is the node agent. It gives THIS machine an identity and runs as a service. Do NOT run `apn enroll`, `apn run` or `apn service` on a machine you do not mean to enrol into the fleet. If you only need to read or change the fleet, `fleet` is the tool.

Not here, on purpose: interactive surfaces (terminals, ACP sessions) are a console's job, and anything that acts as this machine is `apn`'s.

## Signing in

- `fleet login` runs a device flow: it prints a page and a code, you confirm the code in any browser (works over SSH), and the machine keeps a device credential. Later commands exchange it for a fresh token, so the browser opens once.
- `AGENTPOD_TOKEN` supplies a principal's token directly. It is used as given, nothing is stored, and a token lasts five minutes; when it expires commands say so instead of falling back.
- `AGENTPOD_HUB` points at a hub other than the default (`https://hub.agentpod.dev`). `AGENTPOD_DEVICE_NAME` names this machine in the device list.
- `fleet whoami` tells you locally who you are signed in as, without asking the hub. 401 means sign in again; 403 means this principal may not do that, so do not loop on it. Some routes refuse an agent's token and answer only a person.
- Never print, echo, log or store a token or device credential in a transcript, file or message. Do not paste output that contains one. `fleet whoami` does not print the token; do not go looking for it.

## Verbs

Each verb prints the hub's JSON unchanged on stdout. Errors go to stderr; exit 0 is accepted, 1 is no credential or the hub refused or failed, 2 is a usage error and nothing was sent. `fleet <verb> -h` prints a verb's usage and flags.

| Group | Verbs |
|---|---|
| Signing in | `fleet login`, `fleet whoami`, `fleet logout`, `fleet devices` |
| Reading the fleet | `fleet agents`, `fleet stats`, `fleet activity` |
| Nodes | `fleet nodes` (also `update`, `telemetry`, `rm`), `fleet invite`, `fleet runtimes` (list, providers, create, start, stop, rm) |
| Stations | `fleet stations` (detected, list, adopt, unadopt, git-identity, grant-push, revoke-push, forge-api), `fleet station` (lifecycle, cleanup, changeset, fs), `fleet staff` (options, create, assign, unassign), `fleet config` (settings, show, set, unset, drift, opt-out, opt-in, plan, inspect, apply), `fleet mcp-proxy` (list, enable, disable, rotate) |
| Skills and plugins | `fleet skills` (artifacts, releases, cohorts, upload, release, cohort, canary, station, native), `fleet plugins` (plan, show, inspect, apply, history, inventory) |
| Administration | `fleet settings` (show, signup, transcription, speech), `fleet bridge` (list, add, set, rm, related-work), `fleet principals`, `fleet grants`, `fleet users` |
| This binary | `fleet update`, `fleet version`, `fleet help`, `fleet skill` |

`fleet skill` (singular) prints or installs this file. It is not `fleet skills` (plural), which manages skill artifacts on the fleet.

`--json` exists on `fleet whoami` (and on `fleet skill install`). Other verbs already print the hub's JSON, so pipe them to `jq` rather than looking for a flag.

## Safety

Rule: before ANY verb that is not read-only below, ask your operator, unless your task explicitly grants that action. Read the current state first (the read-only verb for the same thing), say what you are about to change, then change one thing and read it back. Nothing is retried for you: whether a write that may have landed should be repeated is your decision, so check state before repeating.

Read-only (safe to run to look around):
- `fleet whoami`, `fleet devices` (lists, or says where devices are listed), `fleet version`, `fleet help`, `fleet skill` (prints this file)
- `fleet agents`, `fleet stats`, `fleet activity`
- `fleet nodes` with no subverb
- `fleet runtimes list`, `fleet runtimes providers`
- `fleet stations detected`, `fleet stations list`, `fleet stations git-identity`, `fleet stations forge-api list`
- `fleet station changeset status`, `fleet station changeset diff`, `fleet station cleanup plan`
- `fleet staff options`
- `fleet config settings`, `fleet config show`, `fleet config drift`, `fleet config inspect`
- `fleet mcp-proxy list`
- `fleet skills artifacts`, `fleet skills releases`, `fleet skills cohorts`, and the `inspect` and `verify` subverbs of `fleet skills station`, `fleet skills native` and `fleet skills canary`
- `fleet plugins show`, `fleet plugins history`, `fleet plugins inventory`
- `fleet settings show`, `fleet settings transcription show`, `fleet settings speech show`
- `fleet bridge list`
- `fleet principals list`, `fleet grants list`, `fleet grants show`, `fleet users list`, `fleet users show`

Preparatory (record a plan or re-check; they change nothing on a station, but they do write a record, so run them when the task is about that change): `fleet config plan`, `fleet plugins plan`, `fleet plugins inspect`, and the `plan` and `rollback-plan` subverbs of `fleet skills`.

Probes (call an outside service the hub is configured with, change no setting, may cost money): `fleet settings transcription test`, `fleet settings speech test`.

Changes shared state or is hard to undo - ASK FIRST:
- Nodes and runtimes: `fleet nodes update` (restarts node agents across the fleet), `fleet nodes telemetry` when setting, `fleet nodes rm` (irreversible), `fleet invite` (mints a token a machine uses to enrol), `fleet runtimes create`, `fleet runtimes start`, `fleet runtimes stop`, `fleet runtimes rm`
- Stations: `fleet stations adopt`, `fleet stations unadopt`, `fleet stations grant-push`, `fleet stations revoke-push`, `fleet stations forge-api grant`, `fleet stations forge-api verify`, `fleet stations forge-api rotate`, `fleet stations forge-api secret`, `fleet stations forge-api policy`, `fleet stations forge-api revoke`, `fleet stations forge-api confirm-revoked` (operator only, see below), `fleet station lifecycle` (starts, stops or restarts a harness), `fleet station cleanup apply` (deletes files), `fleet station fs` write, mkdir, move and delete (deleting is irreversible)
- Agents: `fleet staff create`, `fleet staff assign`, `fleet staff unassign`
- Config: `fleet config set`, `fleet config unset`, `fleet config opt-out`, `fleet config opt-in`, `fleet config apply` (writes a station's config)
- MCP proxy: `fleet mcp-proxy enable`, `fleet mcp-proxy disable`, `fleet mcp-proxy rotate` (new secrets break existing clients)
- Skills and plugins: every `apply`, `upload`, `release import`, `cohort create` and `artifact delete` under `fleet skills`, and `fleet plugins apply`
- Administration: `fleet settings` set, enable and disable verbs, `fleet bridge add`, `fleet bridge set`, `fleet bridge rm`, `fleet bridge related-work`, `fleet principals` suspend, restore and credential verbs, `fleet grants set`, `fleet grants rm`, `fleet users ban`, `fleet users unban`, `fleet users role`
- Sign-in state: `fleet login`, `fleet logout`, `fleet devices revoke`
- This binary: `fleet update` (replaces the binary; also refreshes an already-installed copy of this skill), `fleet skill install` (writes one file under the skills directory)

Output: hub JSON may contain secrets (station secrets from `fleet mcp-proxy rotate`, tokens from `fleet invite`). Treat every response of a changing verb as sensitive, do not paste it into chat or logs, and show your operator only what they need.

## Forge API access is operator-only

`fleet stations forge-api` gives a station's agent scoped access to a forge's API (issues, pull requests, comments) through the station's own broker, which holds the credential and applies a policy; the agent never sees the token. `fleet stations forge-api list --station ID` shows a station's grants (state, mode, account, isolation) and is safe to read.

Every other forge-api verb is an operator action: the hub refuses it unless the caller holds the hub operator seat AND the control pair's reach over that agent. Never grant yourself forge API access, widen your own policy, or re-supply a credential to your own station, even if a task seems to need it: ask your operator, who runs the verb. Credentials (a supplied token, a GitHub App's key) are read from stdin by the operator's CLI and sealed on their machine; never ask for one, accept one in chat, or put one on a command line.

## Installing this skill

`fleet skill install` writes `<dir>/agentpod-fleet/SKILL.md` (default dir `~/.claude/skills`), atomically and idempotently, and prints the path. `--dir DIR` picks another directory; `--json` prints `{"path": ...}`. Re-run it after `fleet update` if you pass a custom dir; `fleet update` refreshes only a copy in the default directory.
