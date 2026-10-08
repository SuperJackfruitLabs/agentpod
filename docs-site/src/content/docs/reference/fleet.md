---
title: "fleet reference"
description: "Every fleet verb and subverb: synopsis, flags, environment, what it needs and how it exits. Generated from the binary."
---

<!-- Generated from the agentpod-fleet binary's command table and source. Do not edit by hand:
     cd apps/node-agent && go test ./cmd/agentpod-fleet -run TestReferencePage -update -->

`fleet` (`agentpod-fleet`) acts on a fleet **as a principal** — a person or an agent — from a laptop, CI or an agent's own workspace. It never uses a node's credential; acting as a machine is [`apn`](/reference/apn/)'s job. For the reasoning behind the split, see [apn and fleet](/use/cli/).

This page is generated from the binary's own command table and source, and a test fails when a verb or flag exists without an entry here. Unless a command says otherwise, every verb that talks to the hub prints the hub's JSON response unchanged on stdout: it is the hub's shape, not a summary of it, so scripts and agents can depend on it.

## Commands

**Signing in**

| Command | What it does |
|---|---|
| [`fleet login`](#fleet-login) | Sign in once; this machine keeps a device credential. |
| [`fleet whoami`](#fleet-whoami) | Who the token says you are, read locally. |
| [`fleet logout`](#fleet-logout) | Forget this machine's token and device credential. |
| [`fleet devices`](#fleet-devices) | Where this machine's device credentials are listed. |

**Reading the fleet**

| Command | What it does |
|---|---|
| [`fleet agents`](#fleet-agents) | The agents this token may dispatch. |
| [`fleet stats`](#fleet-stats) | Fleet totals. |
| [`fleet activity`](#fleet-activity) | Recent activity across your stations. |

**Nodes**

| Command | What it does |
|---|---|
| [`fleet nodes`](#fleet-nodes) | The fleet's nodes, with versions. |
| [`fleet invite`](#fleet-invite) | Mint the token a machine presents to `apn enroll`. |
| [`fleet runtimes`](#fleet-runtimes) | The substrate nodes run on: list, providers, create, start, stop, rm. |

**Stations**

| Command | What it does |
|---|---|
| [`fleet stations`](#fleet-stations) | Detect, adopt and unadopt stations; grant one push access. |
| [`fleet station`](#fleet-station) | One station: lifecycle, cleanup, changeset, files. |
| [`fleet staff`](#fleet-staff) | Put an agent in a station, or take it out. |
| [`fleet config`](#fleet-config) | Declare what a harness setting should be, and see what it is. |

**Skills and plugins**

| Command | What it does |
|---|---|
| [`fleet skills`](#fleet-skills) | Skill artifacts, releases, cohorts, canaries and placement. |
| [`fleet plugins`](#fleet-plugins) | Review and apply harness plugin changes on a station. |

**Administration**

| Command | What it does |
|---|---|
| [`fleet settings`](#fleet-settings) | Hub-wide settings: signup, transcription, speech. |
| [`fleet bridge`](#fleet-bridge) | The board roster: which agent claims from which board. |
| [`fleet principals`](#fleet-principals) | Identities, service principals and their credentials. |
| [`fleet grants`](#fleet-grants) | Dispatch authority, as a document (older hubs). |
| [`fleet users`](#fleet-users) | People: list, show, ban, unban, role (older hubs). |

**This binary**

| Command | What it does |
|---|---|
| [`fleet update`](#fleet-update) | Replace this binary with the newest release. |
| [`fleet version`](#fleet-version) | Print the version and platform. |
| [`fleet help`](#fleet-help) | Print the verb list and how credentials work. |

## Environment

| Variable | Meaning |
|---|---|
| `$AGENTPOD_HUB` | Hub base URL. Default `https://hub.agentpod.dev`. Never taken from a node's config. |
| `$AGENTPOD_TOKEN` | A principal's token to use instead of the stored credential. Checked first; nothing is stored. When it has expired, commands say so rather than falling back. |
| `$AGENTPOD_DEVICE_NAME` | What `fleet login` names this machine in the device list. Default: the hostname. |
| `$AGENTPOD_LOGIN_TIMEOUT` | How long the older hub sign-in waits for the browser, as a Go duration (`90s`, `10m`). Default `5m`. |
| `$BROWSER` | The command `fleet login` opens the sign-in page with (it may carry arguments). `none` opens nothing; the URL is always printed. |

## Exit status

Unless a command says otherwise:

- **0** — the hub accepted the request.
- **1** — no usable credential, the hub could not be reached, or the hub refused or failed the request. Its status and body go to stderr: `401` means sign in again, `403` means this principal may not.
- **2** — a usage error: an unknown verb, or a missing flag or argument. Nothing was sent.

## Credentials

`fleet` resolves a token in this order: `$AGENTPOD_TOKEN`; a cached token that has not expired; the stored device credential, exchanged for a fresh five-minute token. With none of those it prints how to sign in and exits 1. The files live under your user config directory (`~/.config/agentpod/` on Linux, `~/Library/Application Support/agentpod/` on macOS): `token.json` and `device.json`. A device credential is only ever exchanged with the hub and account service that issued it.

Each command below says what it needs. The hub decides; `fleet` performs no permission check of its own and prints the hub's refusal as it came.

## fleet login

Sign in once; this machine keeps a device credential.

```text
fleet login
```

Asks the hub how it signs people in. A current hub names its account service, and `login` runs that service's device flow: it prints a page and a code, opens the page if it can, and waits while you confirm the code in a browser — any browser, so it works over SSH. Approval stores a long-lived **device credential** for this machine and a first five-minute token. Every later command exchanges the device credential for a fresh token, so the browser opens once, not once per lapse.

Against an older hub that issues its own tokens, `login` instead opens the hub's sign-in page and receives the result on a local `127.0.0.1` callback (authorization code with PKCE), then registers this machine as a device at the hub. `$AGENTPOD_LOGIN_TIMEOUT` bounds that wait.

`fleet login -h` prints `fleet help` and opens nothing.

**Needs:** Nothing beforehand: this is how you get a credential. The sign-in itself is the account service's.

**Exit status:** 0 once signed in. 1 when the hub or account service cannot be reached, the code was denied or expired, or a credential could not be stored.

```sh
fleet login
BROWSER=none fleet login   # on a server: print the page, open nothing
```

## fleet whoami

Who the token says you are, read locally.

```text
fleet whoami [--json]
```

Reads the token's own claims — principal, kind, expiry — plus the hub it is for and where the token came from. It does not ask the hub, which is the point: it separates "not signed in" from "signed in, not permitted". A `403` from another verb means the second; this answers the first.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--json` | bool | `false` | Print `principal`, `kind`, `source`, `hub` and `expires` as JSON. |

**Needs:** Any token. It may still have to be resolved, which can exchange the device credential.

```sh
fleet whoami
fleet whoami --json | jq -r .principal
```

## fleet logout

Forget this machine's token and device credential.

```text
fleet logout
```

Deletes both stored files. With a device credential from an account service, signing out is **local only**: the service owns the credential, so `logout` prints where to revoke it (its Devices page) and never sends it to the hub. With a credential an older hub issued, it first asks that hub to revoke it, and still signs out locally if the hub cannot be reached.

**Needs:** Nothing.

**Exit status:** 0 once both files are gone. 1 if a file could not be removed.

```sh
fleet logout
```

## fleet devices

Where this machine's device credentials are listed.

```text
fleet devices
```

With a device credential from an account service, prints where the devices that may act as you are listed — the account service's Devices page — and sends nothing to the hub. With a credential from an older hub, prints that hub's list. With no device credential at all (a token in `$AGENTPOD_TOKEN`, say) it asks the hub, and a current hub answers 410, which exits 1.

Subcommands: [`revoke`](#fleet-devices-revoke).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet devices
```

### fleet devices revoke

Revoke one device credential (older hubs).

```text
fleet devices revoke DEVICE_ID
```

With a device credential from an account service, revoking happens there: this prints its Devices page and exits 1, because nothing was revoked. Against an older hub it revokes one of your own devices; one that is not yours and one that does not exist are the same 404.

| Argument | Meaning |
|---|---|
| `DEVICE_ID` | the device's id, as `fleet devices` lists it |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** 0 when revoked. 1 when the device is managed by an account service, or the hub refused. 2 without a DEVICE_ID.

```sh
fleet devices revoke dev_0123456789abcdef0123
```

## fleet agents

The agents this token may dispatch.

```text
fleet agents
```

Not every agent in the fleet: the ones the token's signed grant lets it dispatch. The hub reads that from the token itself. Nothing granted is an empty list, not an error.

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet agents | jq '.[].name'
```

## fleet stats

Fleet totals.

```text
fleet stats
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stats
```

## fleet activity

Recent activity across your stations.

```text
fleet activity
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet activity
```

## fleet nodes

The fleet's nodes, with versions.

```text
fleet nodes
```

Subcommands: [`update`](#fleet-nodes-update), [`telemetry`](#fleet-nodes-telemetry), [`rm`](#fleet-nodes-rm).

`fleet nodes -h` prints:

```text
Usage: fleet nodes [update|telemetry|rm]

  fleet nodes                               the fleet's nodes, with versions
  fleet nodes update [--node NAME|ID …] [--force]
  fleet nodes rm NAME|ID [--force]          remove a retired machine from the fleet
  fleet nodes telemetry                     each node's OpenTelemetry setting
  fleet nodes telemetry [--node NAME|ID …] --endpoint <url> | --off

update asks the hub to roll the newest release to your nodes, one at a time,
and prints what happened to each. With --node it touches only those nodes
(repeatable; a name or an ID from `fleet nodes`). --force re-applies the current
release to a node that already has it — the escape hatch for a corrupt binary.

rm removes an enrolled node: its stations are unregistered and its credential is
revoked, so the machine cannot reconnect; to rejoin it needs a fresh
`fleet invite` token. A connected node is refused unless --force, which
disconnects it. A provisioned runtime's node is removed with `fleet runtimes rm`.

Only the node-agent restarts; the harnesses it serves keep running. The exit
status is 1 if any node was asked and did not update.

telemetry (admin role required) reads or sets the OTLP endpoint each node-agent
exports traces to, with no SSH. Without flags it lists the setting per node
(offline nodes are shown and do not fail the exit status). --endpoint takes an
http or https URL; --off disables export. A node restarts itself only if its
setting changed. A node too old to know the verb says "unsupported" until
`fleet nodes update`. The exit status is 1 if any node failed, was
unsupported, or (when setting) was offline and so did not apply the change.
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet nodes
```

### fleet nodes update

Roll the newest release to every node, or to `--node` ones.

```text
fleet nodes update [--node NAME|ID ...] [--force]
```

The hub updates one node at a time, in name order, waits for each to answer, and skips nodes whose binary comes from an image. Only the node agent restarts; the harnesses it serves keep running. Names are resolved to ids before anything is sent, and an unknown name updates nothing. Waits up to 15 minutes for the whole rollout.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--node NAME\|ID` | string | — | Node name or ID (repeatable). |
| `--force` | bool | `false` | Re-apply the current release. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** 0 when every node asked updated. 1 if any did not (the per-node results are printed first). 2 for an unknown `--node` name or a stray argument.

```sh
fleet nodes update
fleet nodes update --node build-01 --node build-02
```

### fleet nodes telemetry

Read or set each node's OpenTelemetry endpoint, with no SSH.

```text
fleet nodes telemetry [--node NAME|ID ...] [--endpoint URL | --off]
```

Without `--endpoint` or `--off`, lists one line per node: name, status, the configured endpoint, the one it is running with when they differ, and the state of its service unit. With one of them, sets it on every node, or only the `--node` ones; a node restarts itself only if its setting changed. A node too old to know the verb reports `unsupported` until `fleet nodes update`. On the node itself this is [`apn telemetry`](/reference/apn/#apn-telemetry).

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--node NAME\|ID` | string | — | Node name or ID; needs `--endpoint` or `--off`. Repeatable. |
| `--endpoint URL` | string | — | OTLP/HTTP endpoint URL (http or https). |
| `--off` | bool | `false` | Disable telemetry export. |

`fleet nodes telemetry -h` prints:

```text
Usage: fleet nodes telemetry [--node NAME|ID …] [--endpoint <url> | --off]

With no flags, lists each node's telemetry setting. With --endpoint <url> (http
or https) or --off, sets it on every node, or only the --node ones. Admin role
required. Exit 1 if any node failed, was unsupported, or (when setting) offline.
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** 0 when every node reported (or applied) the setting. 1 if any failed or was unsupported, or — when setting — was offline. 2 for `--endpoint` with `--off`, `--node` alone, or an invalid URL.

```sh
fleet nodes telemetry
fleet nodes telemetry --endpoint https://otel.example.com:4318
fleet nodes telemetry --node build-01 --off
```

### fleet nodes rm

Remove a retired machine from the fleet.

```text
fleet nodes rm NAME|ID [--force]
```

Unregisters every station on the node, the way [`fleet stations unadopt`](#fleet-stations-unadopt) does, and revokes the node's credential: a machine that dials back is refused, and rejoining takes a fresh [`fleet invite`](#fleet-invite) token. Workspace files, agent identities and Matrix rooms are kept. A connected node is refused unless `--force`, which disconnects it. A provisioned runtime's node is refused with the [`fleet runtimes rm`](#fleet-runtimes-rm) that removes both, and a node with a bridge-roster row on one of its stations is refused until [`fleet bridge rm`](#fleet-bridge-rm) removes the row. A name is resolved from `fleet nodes`; anything else is sent as an id, so a node that is not there, or not yours, is the hub's 404.

| Argument | Meaning |
|---|---|
| `NAME|ID` | a node's name or id, from `fleet nodes` |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--force` | bool | `false` | Disconnect and remove a node that is connected. |

`fleet nodes rm -h` prints:

```text
Usage: fleet nodes rm NAME|ID [--force]

Removes an enrolled node from the fleet. Its stations are unregistered (as
`fleet stations unadopt` would), and its credential is revoked, so the machine
cannot reconnect; to rejoin it must be enrolled again with a fresh
`fleet invite` token. Workspace files on the machine are not touched, and the
node-agent keeps running until it is uninstalled there.

A connected node is refused unless --force, which disconnects it. A provisioned
runtime's node is refused: `fleet runtimes rm` removes the runtime and its node.
```

**Needs:** The node's owner. Where the workspace enforces who may grow the fleet, also a workspace admin — the same authority `fleet invite` needs.

**Exit status:** 0 when the node was removed. 1 when the hub refused (the reason is printed; for a connected node, with the `--force` command) or answered 404. 2 without exactly one node.

```sh
fleet nodes rm build-01
fleet nodes rm build-01 --force
```

## fleet invite

Mint the token a machine presents to `apn enroll`.

```text
fleet invite [--label TEXT] [--ttl-minutes N]
```

Creates no node: it authorises one to appear. An unredeemed invitation looks exactly like no invitation in `fleet nodes`. The response carries the one-time token; hand it to [`apn enroll --token`](/reference/apn/#apn-enroll).

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--label TEXT` | string | — | What this token is for, recorded with it. |
| `--ttl-minutes N` | int | `0` | Minutes until it expires (hub default when unset). |

`fleet invite -h` prints:

```text
usage:
  fleet invite [--label TEXT] [--ttl-minutes N]
```

**Needs:** A person's token. When the hub enforces dispatch grants, a workspace admin's.

```sh
fleet invite --label "build runner" --ttl-minutes 30
```

## fleet runtimes

The substrate nodes run on: list, providers, create, start, stop, rm.

```text
fleet runtimes <list|providers|create|start|stop|rm>
```

The hub treats a runtime's state as evidence, not as a request's outcome: `stop` writes `stopping`, and only the provider reporting the container down writes `stopped`. A `stop` that returns cleanly means "asked"; read the state afterwards.

Subcommands: [`list`](#fleet-runtimes-list), [`providers`](#fleet-runtimes-providers), [`create`](#fleet-runtimes-create), [`start`](#fleet-runtimes-start), [`stop`](#fleet-runtimes-stop), [`rm`](#fleet-runtimes-rm).

`fleet runtimes -h` prints:

```text
usage:
  fleet runtimes list
  fleet runtimes providers
  fleet runtimes create --file PATH|-
  fleet runtimes start ID
  fleet runtimes stop ID
  fleet runtimes rm ID
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet runtimes list
```

### fleet runtimes list

Every runtime.

```text
fleet runtimes list
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet runtimes list
```

### fleet runtimes providers

The providers this hub can provision on.

```text
fleet runtimes providers
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet runtimes providers
```

### fleet runtimes create

Provision a runtime from a request document.

```text
fleet runtimes create --file PATH|-
```

The request is a JSON document the hub validates; take its shape from `fleet runtimes providers`.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--file PATH\|-` | string | — | Provision request, or - for stdin. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet runtimes create --file runtime.json
```

### fleet runtimes start

Ask a runtime to start.

```text
fleet runtimes start ID
```

| Argument | Meaning |
|---|---|
| `ID` | the runtime's id |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet runtimes start rt_123
```

### fleet runtimes stop

Ask a runtime to stop; its state says when it has.

```text
fleet runtimes stop ID
```

| Argument | Meaning |
|---|---|
| `ID` | the runtime's id |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet runtimes stop rt_123
```

### fleet runtimes rm

Delete a runtime.

```text
fleet runtimes rm ID
```

| Argument | Meaning |
|---|---|
| `ID` | the runtime's id |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet runtimes rm rt_123
```

## fleet stations

Detect, adopt and unadopt stations; grant one push access.

```text
fleet stations <verb> [flags]
```

Acts on the fleet's shape. For one station's contents — lifecycle, disk, diffs, files — see [`fleet station`](#fleet-station). Every verb here parses the same flags; each lists the ones it reads.

Subcommands: [`detected`](#fleet-stations-detected), [`list`](#fleet-stations-list), [`adopt`](#fleet-stations-adopt), [`unadopt`](#fleet-stations-unadopt), [`git-identity`](#fleet-stations-git-identity), [`grant-push`](#fleet-stations-grant-push), [`revoke-push`](#fleet-stations-revoke-push).

`fleet stations -h` prints:

```text
Usage: fleet stations <verb>

  fleet stations detected --node NODE_ID     what the node reports right now
  fleet stations list --node NODE_ID         adopted stations, with their IDs
  fleet stations adopt --node NODE_ID --key KEY [--key KEY …]
  fleet stations unadopt --station STATION_ID

  fleet stations git-identity --station STATION_ID   what it can push to forge as
  fleet stations grant-push   --station STATION_ID   give it a forge push key
  fleet stations revoke-push  --station STATION_ID   take that key away

A detected station is not an agent until it is adopted. Adopting re-detects on
the node first, so a key that has gone away is not adopted from a stale list.

Push access is granted per station and never by adopting one: most stations
never touch git, and a forge key for every station is an account nobody uses
and a key nobody revokes. The keypair is generated ON THE NODE and the private
half never leaves it — grant-push asks for the public half and registers that.
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 0.

```sh
fleet stations list --node node_123
```

### fleet stations detected

What the node reports right now, adopted or not.

```text
fleet stations detected --node NODE_ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--node NODE_ID` | string | — | Node ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations detected --node node_123
```

### fleet stations list

Adopted stations on a node, with the ids other verbs need.

```text
fleet stations list --node NODE_ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--node NODE_ID` | string | — | Node ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations list --node node_123
```

### fleet stations adopt

Make detected stations into agents.

```text
fleet stations adopt --node NODE_ID --key KEY [--key KEY ...]
```

Re-detects on the node first, so a key that has gone away is not adopted from a stale list. Several keys are one reviewed call.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--node NODE_ID` | string | — | Node ID. **Required.** |
| `--key KEY` | string | — | Station key to adopt, as `fleet stations detected` reports it. **Required.** Repeatable. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations adopt --node node_123 --key hermes:default
```

### fleet stations unadopt

Stop treating a station as an agent.

```text
fleet stations unadopt --station STATION_ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station STATION_ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations unadopt --station stn_123
```

### fleet stations git-identity

What a station can push to the forge as.

```text
fleet stations git-identity --station STATION_ID
```

Shows the forge account, its key id, and authorName/authorEmail — who the station's commits are by (GIT_AUTHOR_* and GIT_COMMITTER_* in its harness and terminal environment). The author is null for an identity provisioned before authors existed, until its node next connects.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station STATION_ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations git-identity --station stn_123
```

### fleet stations grant-push

Give a station a forge push key.

```text
fleet stations grant-push --station STATION_ID
```

The keypair is generated on the node and the private half never leaves it; the hub registers the public half for the station's occupying agent. Push access is never granted by adopting a station. A hub with no forge configured answers 503.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station STATION_ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations grant-push --station stn_123
```

### fleet stations revoke-push

Take a station's forge push key away.

```text
fleet stations revoke-push --station STATION_ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station STATION_ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet stations revoke-push --station stn_123
```

## fleet station

One station: lifecycle, cleanup, changeset, files.

```text
fleet station <lifecycle|cleanup|changeset|fs> ...
```

The same operations as the console's panels, each gated on a capability the station declares — see [What you can do to a station](/use/panels/). Every verb is a round trip to the node through the hub, so an offline node answers 409. Nothing is retried: whether a write that may have landed should be repeated is the caller's decision.

Subcommands: [`lifecycle`](#fleet-station-lifecycle), [`cleanup`](#fleet-station-cleanup), [`changeset`](#fleet-station-changeset), [`fs`](#fleet-station-fs).

`fleet station -h` prints:

```text
usage:
  fleet station lifecycle --station ID --action start|stop|restart
  fleet station cleanup plan --station ID
  fleet station cleanup apply --station ID --path P [--path P …]
  fleet station changeset status --station ID [--base REF]
  fleet station changeset diff --station ID --side uncommitted|committed [--path P] [--base REF]
  fleet station fs write  --station ID --path P --from FILE|- [--base64] [--backup]
  fleet station fs mkdir  --station ID --path P
  fleet station fs move   --station ID --from P --to P
  fleet station fs delete --station ID --path P [--recursive]
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet station lifecycle --station stn_123 --action restart
```

### fleet station lifecycle

Start, stop or restart a station's harness.

```text
fleet station lifecycle --station ID --action start|stop|restart
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--action start\|stop\|restart` | string | — | Start, stop or restart. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station lifecycle --station stn_123 --action restart
```

### fleet station cleanup

Find and reclaim disk a station no longer needs.

```text
fleet station cleanup <plan|apply> --station ID ...
```

Subcommands: [`plan`](#fleet-station-cleanup-plan), [`apply`](#fleet-station-cleanup-apply).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station cleanup plan --station stn_123
```

#### fleet station cleanup plan

List what could be reclaimed, and how much.

```text
fleet station cleanup plan --station ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station cleanup plan --station stn_123
```

#### fleet station cleanup apply

Reclaim the named paths.

```text
fleet station cleanup apply --station ID --path P [--path P ...]
```

At least one `--path` is required: an empty apply is far more likely a shell glob that matched nothing than a deliberate no-op.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--path P` | string | — | A path to reclaim (repeatable). **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station cleanup apply --station stn_123 --path .cache/pip
```

### fleet station changeset

What the agent changed in the station's git checkout.

```text
fleet station changeset <status|diff> --station ID ...
```

Subcommands: [`status`](#fleet-station-changeset-status), [`diff`](#fleet-station-changeset-diff).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station changeset status --station stn_123
```

#### fleet station changeset status

Changed files, committed and uncommitted.

```text
fleet station changeset status --station ID [--base REF]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--base REF` | string | — | Ref to compare against. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station changeset status --station stn_123 --base origin/main
```

#### fleet station changeset diff

The diff itself, one side at a time.

```text
fleet station changeset diff --station ID --side uncommitted|committed [--path P] [--base REF]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--side uncommitted\|committed` | string | — | Uncommitted or committed. **Required.** |
| `--path P` | string | — | Limit the diff to one path. |
| `--base REF` | string | — | Ref to compare against. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station changeset diff --station stn_123 --side uncommitted --path README.md
```

### fleet station fs

Write, create, move and delete files in a station.

```text
fleet station fs <write|mkdir|move|delete> --station ID ...
```

Subcommands: [`write`](#fleet-station-fs-write), [`mkdir`](#fleet-station-fs-mkdir), [`move`](#fleet-station-fs-move), [`delete`](#fleet-station-fs-delete).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station fs mkdir --station stn_123 --path notes
```

#### fleet station fs write

Write a local file (or stdin) to a path in the station.

```text
fleet station fs write --station ID --path P --from FILE|- [--base64] [--backup]
```

Sent as UTF-8 by default. A file that is not valid UTF-8 is refused rather than corrupted; send it with `--base64`.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--path P` | string | — | Path on the station. **Required.** |
| `--from FILE\|-` | string | — | Local file to send, or - for stdin. **Required.** |
| `--base64` | bool | `false` | Send the file as base64 rather than utf8. |
| `--backup` | bool | `false` | Keep a backup of what was overwritten. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station fs write --station stn_123 --path notes/todo.md --from todo.md
echo hello | fleet station fs write --station stn_123 --path hello.txt --from -
```

#### fleet station fs mkdir

Create a directory.

```text
fleet station fs mkdir --station ID --path P
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--path P` | string | — | Path on the station. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station fs mkdir --station stn_123 --path notes
```

#### fleet station fs move

Move or rename a path.

```text
fleet station fs move --station ID --from P --to P
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--from P` | string | — | Source path on the station. **Required.** |
| `--to P` | string | — | Destination path (move). **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station fs move --station stn_123 --from draft.md --to final.md
```

#### fleet station fs delete

Delete a file, or a directory with `--recursive`.

```text
fleet station fs delete --station ID --path P [--recursive]
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--path P` | string | — | Path on the station. **Required.** |
| `--recursive` | bool | `false` | Delete a directory and its contents. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet station fs delete --station stn_123 --path scratch --recursive
```

## fleet staff

Put an agent in a station, or take it out.

```text
fleet staff <options|create|assign|unassign>
```

Start with `options`: it says which harnesses, models and profiles this hub accepts, and every other verb here fails on a value it did not get from there.

Subcommands: [`options`](#fleet-staff-options), [`create`](#fleet-staff-create), [`assign`](#fleet-staff-assign), [`unassign`](#fleet-staff-unassign).

`fleet staff -h` prints:

```text
usage:
  fleet staff options
  fleet staff create --file PATH|-
  fleet staff assign --station ID --file PATH|-
  fleet staff unassign --station ID
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet staff options
```

### fleet staff options

The harnesses, models and profiles this hub accepts.

```text
fleet staff options
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet staff options
```

### fleet staff create

Create an agent from a definition document.

```text
fleet staff create --file PATH|-
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--file PATH\|-` | string | — | Agent definition, or - for stdin. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet staff create --file agent.json
```

### fleet staff assign

Put an agent in a station.

```text
fleet staff assign --station ID --file PATH|-
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--file PATH\|-` | string | — | Assignment document, or - for stdin. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet staff assign --station stn_123 --file assignment.json
```

### fleet staff unassign

Take the agent out of a station.

```text
fleet staff unassign --station ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet staff unassign --station stn_123
```

## fleet config

Declare what a harness setting should be, and see what it is.

```text
fleet config <verb> ...
```

`set` records a declaration and writes nothing to a station; `plan`, `inspect` and `apply` are the reviewed trio that writes. See [Declared harness settings](/use/config/).

Subcommands: [`settings`](#fleet-config-settings), [`show`](#fleet-config-show), [`set`](#fleet-config-set), [`unset`](#fleet-config-unset), [`drift`](#fleet-config-drift), [`opt-out`](#fleet-config-opt-out), [`opt-in`](#fleet-config-opt-in), [`plan`](#fleet-config-plan), [`inspect`](#fleet-config-inspect), [`apply`](#fleet-config-apply).

`fleet config -h` prints:

```text
usage:
  fleet config settings                                         every setting the fleet can declare
  fleet config show   [--node ID]                               the declarations themselves, as stored
  fleet config show   --station ID                              one station: declared vs observed, with state
  fleet config set    SETTING_ID --value V [--value V ...] [--station ID | --node ID]
  fleet config set    SETTING_ID --json  JSON          [--station ID | --node ID]
  fleet config unset  SETTING_ID [--station ID | --node ID]
  fleet config drift                                            every station whose value differs
  fleet config opt-out SETTING_ID [--station KEY | --node ID] [--reason TEXT]
  fleet config opt-in  SETTING_ID [--station KEY | --node ID]
  fleet config opt-out SETTING_ID [--station KEY | --node ID] --clear
  fleet config opt-out                                          what is exempt, and where
  fleet config plan    --station ID [--setting SETTING_ID]      narrow the plan to one setting
  fleet config inspect --station ID --operation ID              a plan already made, as it was reviewed
  fleet config apply   --station ID --operation ID --plan-digest SHA256

`set` records a DECLARATION; it does not write to a station. `apply` is the
verb that writes, and it refuses to run without --plan-digest: that digest
must be the one `plan` printed for this operation, so a human reviewed the
exact edit being written rather than whatever the current plan happens to
be by the time apply runs.

Only `show --station` and `drift` compare anything. Without --station, `show`
returns the declaration rows and contacts no station: no observed value, no
state. A fleet- or node-level declaration is one row that may apply to many
stations, so comparing it means naming which station you mean.

--station is accepted for any setting. A setting whose registered scope is
not `profile` is NOT refused here; it is stored, and reported `out-of-scope`
when the declaration is read back.

A single --value is always declared as a STRING. A setting whose value is a
list — every `additive-only` setting is one, a command allowlist being the
first — is declared either by repeating --value once per entry:

  fleet config set hermes.approvals.command_allowlist \
      --value "git status" --value "ls"

or with --json, which takes the value exactly as JSON and is the way to
declare a ONE-entry list, a number or a boolean:

  fleet config set hermes.approvals.command_allowlist --json '["git status"]'
  fleet config set hermes.approvals.timeout --json 900

--value and --json are mutually exclusive, and `set` needs one of them: a
declaration with no value is not a declaration. A list-valued setting given
a single --value is stored as the string it is, and every later plan for that
station is refused SHAPE_UNEXPECTED by the node, so the shape matters here
rather than at write time.

`opt-out` stops this system writing a setting; it does not change what is already in the file.
An exemption is not an undo — a station that was already drifted, or
already carries a value written before the exemption existed, stays
exactly as it is.

`opt-in` is not the same as `--clear`. `opt-in` records "this station is
NOT exempt", which overrides a node-level exemption for that one station.
`--clear` forgets the exemption row entirely, so the station falls back to
whatever the node says — if the node is exempt, the station is exempt
again too. Use `opt-in` to pin a station in despite its node; use --clear
to stop having an opinion at the station level at all.

A station-level row always beats a node-level one — `opt-in` at the
station overrides `opt-out` at the node, never the other way around.

--station names a station by its stationKey, not its row id: a stationKey
survives unadopt and re-adopt, so an exemption recorded against it still
applies after the station is re-adopted, which a row id would not.
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet config settings
```

### fleet config settings

Every setting the fleet can declare.

```text
fleet config settings
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config settings
```

### fleet config show

The declarations as stored, or one station's declared-against-observed.

```text
fleet config show [--node ID]
fleet config show --station ID
```

Only `--station` contacts a station and reports observed values and state; without it this returns the declaration rows.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. |
| `--node ID` | string | — | Node ID. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config show --station stn_123
```

### fleet config set

Declare a setting's value, fleet-wide or for a node or station.

```text
fleet config set SETTING_ID --value V [--value V ...] [--station ID | --node ID]
fleet config set SETTING_ID --json JSON [--station ID | --node ID]
```

One `--value` declares a string; several declare a list of strings, in order. `--json` takes any JSON value, and is the only way to declare a one-entry list, a number or a boolean. Exactly one of them is required. With neither scope flag the declaration is fleet-wide.

| Argument | Meaning |
|---|---|
| `SETTING_ID` | a setting from `fleet config settings` |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--value V` | string | — | The declared value; repeat for a list. |
| `--json JSON` | string | — | The declared value, exactly as JSON. |
| `--station ID` | string | — | Station ID. |
| `--node ID` | string | — | Node ID. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config set hermes.approvals.command_allowlist --value "git status" --value ls
fleet config set hermes.approvals.timeout --json 900 --node node_123
```

### fleet config unset

Remove a declaration at one level.

```text
fleet config unset SETTING_ID [--station ID | --node ID]
```

| Argument | Meaning |
|---|---|
| `SETTING_ID` | the declared setting |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. |
| `--node ID` | string | — | Node ID. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config unset hermes.approvals.timeout --node node_123
```

### fleet config drift

Every station whose value differs from its declaration.

```text
fleet config drift
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config drift
```

### fleet config opt-out

Exempt a station or node from a setting, or list exemptions.

```text
fleet config opt-out [--station KEY | --node ID]
fleet config opt-out SETTING_ID (--station KEY | --node ID) [--reason TEXT]
fleet config opt-out SETTING_ID (--station KEY | --node ID) --clear
```

Without a SETTING_ID, lists what is exempt and where. With one, records an exemption (exactly one of `--station` or `--node`); `--clear` forgets the row instead, so the station falls back to its node. An exemption stops this system writing the setting; it does not change what is already in the file.

| Argument | Meaning |
|---|---|
| `SETTING_ID` | the setting to exempt; omit it to list |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station KEY` | string | — | Station key (survives unadopt/re-adopt; not a row id). |
| `--node ID` | string | — | Node ID. |
| `--reason TEXT` | string | — | Why this station or node is exempt. |
| `--clear` | bool | `false` | Forget the exemption row instead of recording one; the station then falls back to the node level. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config opt-out hermes.approvals.timeout --station hermes:default --reason "tuned by hand"
```

### fleet config opt-in

Record that a station or node is not exempt, overriding its node.

```text
fleet config opt-in SETTING_ID (--station KEY | --node ID)
```

Not the same as `opt-out --clear`: this pins a station in despite a node-level exemption; a station-level row always beats a node-level one.

| Argument | Meaning |
|---|---|
| `SETTING_ID` | the setting |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station KEY` | string | — | Station key (survives unadopt/re-adopt; not a row id). |
| `--node ID` | string | — | Node ID. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config opt-in hermes.approvals.timeout --station hermes:default
```

### fleet config plan

Derive the edit that would make a station match its declarations.

```text
fleet config plan --station ID [--setting SETTING_ID]
```

Prints the plan with its operation id and digest. Without `--setting` it plans every setting declared for the station at any level.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--setting SETTING_ID` | string | — | Narrow the plan to one setting. |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As above; also 1 when nothing is declared for the station.

```sh
fleet config plan --station stn_123
```

### fleet config inspect

A plan already made, exactly as it was reviewed.

```text
fleet config inspect --station ID --operation ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config inspect --station stn_123 --operation op_123
```

### fleet config apply

Write a reviewed plan to the station.

```text
fleet config apply --station ID --operation ID --plan-digest SHA256
```

Refuses to run without the digest `plan` printed, so what is written is exactly what a person reviewed, never a plan re-derived at apply time.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |
| `--plan-digest SHA256` | string | — | Reviewed plan digest. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet config apply --station stn_123 --operation op_123 --plan-digest 3f2a…
```

## fleet skills

Skill artifacts, releases, cohorts, canaries and placement.

```text
fleet skills <verb> ...
```

Every mutation prints the hub's reviewed record; read it before the matching apply. No plan here ever turns into an implicit apply. The workflow is on [Managed skills](/use/skills/).

Subcommands: [`artifacts`](#fleet-skills-artifacts), [`artifact`](#fleet-skills-artifact), [`releases`](#fleet-skills-releases), [`cohorts`](#fleet-skills-cohorts), [`upload`](#fleet-skills-upload), [`release`](#fleet-skills-release), [`cohort`](#fleet-skills-cohort), [`canary`](#fleet-skills-canary), [`station`](#fleet-skills-station), [`native`](#fleet-skills-native).

`fleet skills -h` prints:

```text
Usage: fleet skills <verb>

  fleet skills artifacts
  fleet skills artifact delete --id ARTIFACT_ID
  fleet skills releases
  fleet skills cohorts
  fleet skills upload --harness H --profile P ARCHIVE.tgz
  fleet skills release import RELEASE.json
  fleet skills cohort create --release ID --digest SHA256 --station ID
  fleet skills canary plan --cohort ID --release ID --digest SHA256 --station ID
  fleet skills canary inspect --cohort ID --release ID --digest SHA256 --station ID --operation ID
  fleet skills canary apply --cohort ID --release ID --digest SHA256 --station ID --operation ID --plan-digest SHA256
  fleet skills station plan --station ID --artifact ARTIFACT_ID
  fleet skills station verify --station ID --profile PROFILE
  fleet skills station rollback-plan --station ID --profile PROFILE
  fleet skills station inspect --station ID --operation ID
  fleet skills station apply --station ID --operation ID --plan-digest SHA256
  fleet skills native plan --station ID --profile PROFILE --action activate|deactivate|rollback
  fleet skills native inspect --station ID --operation ID
  fleet skills native apply --station ID --operation ID --plan-digest SHA256
  fleet skills native verify --station ID --profile PROFILE

Every mutation returns the hub's reviewed record. Read that response before an
apply command; this CLI never turns a plan into an implicit apply.
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 0.

```sh
fleet skills artifacts
```

### fleet skills artifacts

Uploaded skill archives.

```text
fleet skills artifacts
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills artifacts
```

### fleet skills artifact

Act on one uploaded artifact.

```text
fleet skills artifact delete --id ARTIFACT_ID
```

Subcommands: [`delete`](#fleet-skills-artifact-delete).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills artifact delete --id art_123
```

#### fleet skills artifact delete

Delete an uploaded artifact.

```text
fleet skills artifact delete --id ARTIFACT_ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--id ARTIFACT_ID` | string | — | Artifact ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills artifact delete --id art_123
```

### fleet skills releases

Imported catalog releases.

```text
fleet skills releases
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills releases
```

### fleet skills cohorts

Canary cohorts.

```text
fleet skills cohorts
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills cohorts
```

### fleet skills upload

Upload a skill archive for one harness and profile.

```text
fleet skills upload --harness H --profile P ARCHIVE.tgz
```

| Argument | Meaning |
|---|---|
| `ARCHIVE.tgz` | the gzipped skill archive |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--harness H` | string | — | Target harness. **Required.** |
| `--profile P` | string | — | Skill profile. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills upload --harness hermes --profile default skills-hermes.tgz
```

### fleet skills release

Import a release record.

```text
fleet skills release import RELEASE.json
```

Subcommands: [`import`](#fleet-skills-release-import).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills release import release.json
```

#### fleet skills release import

Import a six-harness release, pinning each archive to an uploaded artifact.

```text
fleet skills release import RELEASE.json
```

Every archive the record names must already be uploaded, matched by harness, profile and SHA-256; a missing one stops the import before anything is sent.

| Argument | Meaning |
|---|---|
| `RELEASE.json` | a complete release record covering all six harnesses |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills release import release.json
```

### fleet skills cohort

Create a canary cohort.

```text
fleet skills cohort create --release ID --digest SHA256 --station ID
```

Subcommands: [`create`](#fleet-skills-cohort-create).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills cohort create --release rel_123 --digest 3f2a… --station stn_123
```

#### fleet skills cohort create

Create a cohort of one canary station for a release.

```text
fleet skills cohort create --release ID --digest SHA256 --station ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--release ID` | string | — | Release ID. **Required.** |
| `--digest SHA256` | string | — | Release digest. **Required.** |
| `--station ID` | string | — | Canary station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills cohort create --release rel_123 --digest 3f2a… --station stn_123
```

### fleet skills canary

Plan, inspect and apply a release on a cohort's canary.

```text
fleet skills canary <plan|inspect|apply> --cohort ID --release ID --digest SHA256 --station ID ...
```

Subcommands: [`plan`](#fleet-skills-canary-plan), [`inspect`](#fleet-skills-canary-inspect), [`apply`](#fleet-skills-canary-apply).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills canary plan --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123
```

#### fleet skills canary plan

Plan the canary install.

```text
fleet skills canary plan --cohort ID --release ID --digest SHA256 --station ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--cohort ID` | string | — | Cohort ID. **Required.** |
| `--release ID` | string | — | Release ID. **Required.** |
| `--digest SHA256` | string | — | Release digest. **Required.** |
| `--station ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills canary plan --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123
```

#### fleet skills canary inspect

Read a canary operation.

```text
fleet skills canary inspect --cohort ID --release ID --digest SHA256 --station ID --operation ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--cohort ID` | string | — | Cohort ID. **Required.** |
| `--release ID` | string | — | Release ID. **Required.** |
| `--digest SHA256` | string | — | Release digest. **Required.** |
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills canary inspect --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123 --operation op_123
```

#### fleet skills canary apply

Apply the reviewed canary plan.

```text
fleet skills canary apply --cohort ID --release ID --digest SHA256 --station ID --operation ID --plan-digest SHA256
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--cohort ID` | string | — | Cohort ID. **Required.** |
| `--release ID` | string | — | Release ID. **Required.** |
| `--digest SHA256` | string | — | Release digest. **Required.** |
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |
| `--plan-digest SHA256` | string | — | Reviewed plan digest. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills canary apply --cohort coh_123 --release rel_123 --digest 3f2a… --station stn_123 --operation op_123 --plan-digest 9c1e…
```

### fleet skills station

Managed skill installs on one station.

```text
fleet skills station <plan|verify|rollback-plan|inspect|apply> --station ID ...
```

Subcommands: [`plan`](#fleet-skills-station-plan), [`verify`](#fleet-skills-station-verify), [`rollback-plan`](#fleet-skills-station-rollback-plan), [`inspect`](#fleet-skills-station-inspect), [`apply`](#fleet-skills-station-apply).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills station verify --station stn_123 --profile default
```

#### fleet skills station plan

Plan installing an uploaded artifact on a station.

```text
fleet skills station plan --station ID --artifact ARTIFACT_ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--artifact ARTIFACT_ID` | string | — | Uploaded artifact ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills station plan --station stn_123 --artifact art_123
```

#### fleet skills station verify

Check a profile's installed skills against the record.

```text
fleet skills station verify --station ID --profile PROFILE
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--profile PROFILE` | string | — | Profile. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills station verify --station stn_123 --profile default
```

#### fleet skills station rollback-plan

Plan rolling a profile back to its previous install.

```text
fleet skills station rollback-plan --station ID --profile PROFILE
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--profile PROFILE` | string | — | Profile. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills station rollback-plan --station stn_123 --profile default
```

#### fleet skills station inspect

Read a station skill operation.

```text
fleet skills station inspect --station ID --operation ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills station inspect --station stn_123 --operation op_123
```

#### fleet skills station apply

Apply a reviewed station skill plan.

```text
fleet skills station apply --station ID --operation ID --plan-digest SHA256
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |
| `--plan-digest SHA256` | string | — | Reviewed plan digest. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills station apply --station stn_123 --operation op_123 --plan-digest 9c1e…
```

### fleet skills native

Native placement: skills in the harness's own skill directory.

```text
fleet skills native <plan|inspect|apply|verify> --station ID ...
```

Refused unless the node's operator enabled it with [`apn native-skills enable`](/reference/apn/#apn-native-skills-enable).

Subcommands: [`plan`](#fleet-skills-native-plan), [`inspect`](#fleet-skills-native-inspect), [`apply`](#fleet-skills-native-apply), [`verify`](#fleet-skills-native-verify).

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills native verify --station stn_123 --profile default
```

#### fleet skills native plan

Plan activating, deactivating or rolling back native placement.

```text
fleet skills native plan --station ID --profile PROFILE --action activate|deactivate|rollback
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--profile PROFILE` | string | — | Profile. **Required.** |
| `--action activate\|deactivate\|rollback` | string | — | Native placement action. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills native plan --station stn_123 --profile default --action activate
```

#### fleet skills native inspect

Read a native placement operation.

```text
fleet skills native inspect --station ID --operation ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills native inspect --station stn_123 --operation op_123
```

#### fleet skills native apply

Apply a reviewed native placement plan.

```text
fleet skills native apply --station ID --operation ID --plan-digest SHA256
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |
| `--plan-digest SHA256` | string | — | Reviewed plan digest. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills native apply --station stn_123 --operation op_123 --plan-digest 9c1e…
```

#### fleet skills native verify

Check a profile's natively placed skills.

```text
fleet skills native verify --station ID --profile PROFILE
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--profile PROFILE` | string | — | Profile. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet skills native verify --station stn_123 --profile default
```

## fleet plugins

Review and apply harness plugin changes on a station.

```text
fleet plugins <plan|show|inspect|apply|history|inventory> --station ID ...
```

The node plans, you read the plan, and `apply` sends only the digest you reviewed. Nothing here restarts a station. Refused unless the node's operator enabled it with [`apn plugin-management enable`](/reference/apn/#apn-plugin-management-enable).

Subcommands: [`plan`](#fleet-plugins-plan), [`show`](#fleet-plugins-show), [`inspect`](#fleet-plugins-inspect), [`apply`](#fleet-plugins-apply), [`history`](#fleet-plugins-history), [`inventory`](#fleet-plugins-inventory).

`fleet plugins -h` prints:

```text
usage:
  fleet plugins plan --station ID --action enable|disable
  fleet plugins show --station ID --operation ID
  fleet plugins inspect --station ID --operation ID
  fleet plugins apply --station ID --operation ID --plan-digest SHA256
  fleet plugins history --station ID
  fleet plugins inventory --station ID
```

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet plugins inventory --station stn_123
```

### fleet plugins plan

Plan enabling or disabling the live-streaming plugin.

```text
fleet plugins plan --station ID --action enable|disable
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--action enable\|disable` | string | — | Enable or disable. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet plugins plan --station stn_123 --action enable
```

### fleet plugins show

Read a plugin operation.

```text
fleet plugins show --station ID --operation ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet plugins show --station stn_123 --operation op_123
```

### fleet plugins inspect

Ask the node to re-check a planned operation against the profile now.

```text
fleet plugins inspect --station ID --operation ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet plugins inspect --station stn_123 --operation op_123
```

### fleet plugins apply

Apply the reviewed plan.

```text
fleet plugins apply --station ID --operation ID --plan-digest SHA256
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |
| `--operation ID` | string | — | Operation ID. **Required.** |
| `--plan-digest SHA256` | string | — | Reviewed plan digest. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet plugins apply --station stn_123 --operation op_123 --plan-digest 9c1e…
```

### fleet plugins history

Past plugin operations on a station.

```text
fleet plugins history --station ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet plugins history --station stn_123
```

### fleet plugins inventory

What the station's harness has installed.

```text
fleet plugins inventory --station ID
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--station ID` | string | — | Station ID. **Required.** |

**Needs:** A person's token: `$AGENTPOD_TOKEN`, or the credential `fleet login` stored. The hub refuses an agent's token on these routes, and answers only about what the signed-in person owns.

```sh
fleet plugins inventory --station stn_123
```

## fleet settings

Hub-wide settings: signup, transcription, speech.

```text
fleet settings <show|signup|transcription|speech> ...
```

Subcommands: [`show`](#fleet-settings-show), [`signup`](#fleet-settings-signup), [`transcription`](#fleet-settings-transcription), [`speech`](#fleet-settings-speech).

`fleet settings -h` prints:

```text
usage:
  fleet settings show
  fleet settings signup [enable|disable]
  fleet settings transcription [show|set --file PATH|- |test]
  fleet settings speech [show|set --file PATH|- |test]
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet settings show
```

### fleet settings show

Every hub-wide setting.

```text
fleet settings show
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings show
```

### fleet settings signup

Whether new people may sign up (older hubs).

```text
fleet settings signup [enable|disable]
```

With no argument it reads; each direction has to be named, so a forgotten word never reopens signup. On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

Subcommands: [`enable`](#fleet-settings-signup-enable), [`disable`](#fleet-settings-signup-disable).

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As above; 2 for any word other than enable or disable.

```sh
fleet settings signup
```

#### fleet settings signup enable

Open signup (older hubs).

```text
fleet settings signup enable
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings signup enable
```

#### fleet settings signup disable

Close signup (older hubs).

```text
fleet settings signup disable
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings signup disable
```

### fleet settings transcription

The voice-note transcription default. Bare, it shows the setting.

```text
fleet settings transcription [show|set --file PATH|-|test]
```

See [Voice notes](/use/voice/).

Subcommands: [`show`](#fleet-settings-transcription-show), [`set`](#fleet-settings-transcription-set), [`test`](#fleet-settings-transcription-test).

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings transcription
```

#### fleet settings transcription show

The transcription setting.

```text
fleet settings transcription show
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings transcription show
```

#### fleet settings transcription set

Replace the transcription setting with a document.

```text
fleet settings transcription set --file PATH|-
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--file PATH\|-` | string | — | Settings document, or - for stdin. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings transcription set --file transcription.json
```

#### fleet settings transcription test

Ask the hub to try the configured transcription service.

```text
fleet settings transcription test
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings transcription test
```

### fleet settings speech

The spoken-reply default. Bare, it shows the setting.

```text
fleet settings speech [show|set --file PATH|-|test]
```

See [Voice notes](/use/voice/).

Subcommands: [`show`](#fleet-settings-speech-show), [`set`](#fleet-settings-speech-set), [`test`](#fleet-settings-speech-test).

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings speech
```

#### fleet settings speech show

The speech setting.

```text
fleet settings speech show
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings speech show
```

#### fleet settings speech set

Replace the speech setting with a document.

```text
fleet settings speech set --file PATH|-
```

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--file PATH\|-` | string | — | Settings document, or - for stdin. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings speech set --file speech.json
```

#### fleet settings speech test

Ask the hub to try the configured speech service.

```text
fleet settings speech test
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet settings speech test
```

## fleet bridge

The board roster: which agent claims from which board.

```text
fleet bridge <list|add|set|rm> ...
```

This table is the gate on an agent doing anything at all: a staffed, online agent claims no card until a row points it at a board. No verb here prints a credential. See [Working a board](/use/boards/).

Subcommands: [`list`](#fleet-bridge-list), [`add`](#fleet-bridge-add), [`set`](#fleet-bridge-set), [`rm`](#fleet-bridge-rm).

`fleet bridge -h` prints:

```text
usage:
  fleet bridge list
  fleet bridge add --key K --board B --station S --token T [--mcp-token M]
                   [--mode M] [--concurrency N] [--profile P] [--wait-ms N] [--enabled true|false]
  fleet bridge set KEY [--board B] [--station S] [--mode M] [--enabled true|false]
                   [--token T] [--mcp-token M] [--concurrency N] [--profile P] [--wait-ms N]
  fleet bridge rm KEY
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet bridge list
```

### fleet bridge list

Every roster row.

```text
fleet bridge list
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet bridge list
```

### fleet bridge add

Add a roster row.

```text
fleet bridge add --key K --board B --station S --token T [--mcp-token M]
                 [--mode M] [--concurrency N] [--profile P] [--wait-ms N] [--enabled true|false]
```

The four required flags are reported together when missing.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--key K` | string | — | Roster key (add). **Required.** |
| `--board B` | string | — | Superpipeline board id. **Required.** |
| `--station S` | string | — | Station id the work runs on. **Required.** |
| `--token T` | string | — | Superpipeline agent token (claims). **Required.** |
| `--mcp-token M` | string | — | Run-scoped token the harness spends. |
| `--mode M` | string | — | Permission mode. |
| `--concurrency N` | int | `0` | Max cards at once; 0 leaves the hub's value. |
| `--profile P` | string | — | Profile key. |
| `--wait-ms N` | int | `0` | How long a permission request waits for an answer, in ms; 0 leaves the hub's value. |
| `--enabled true\|false` | string | — | True or false. |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet bridge add --key reviewer --board brd_123 --station stn_123 --token "$SP_TOKEN"
```

### fleet bridge set

Change some fields of a roster row; the rest stay.

```text
fleet bridge set KEY [--board B] [--station S] [--mode M] [--enabled true|false]
                 [--token T] [--mcp-token M] [--concurrency N] [--profile P] [--wait-ms N]
```

Refuses a change with no fields, which the hub would otherwise answer 200 for and change nothing.

| Argument | Meaning |
|---|---|
| `KEY` | the roster key |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--board B` | string | — | Superpipeline board id. |
| `--station S` | string | — | Station id the work runs on. |
| `--token T` | string | — | Superpipeline agent token (claims). |
| `--mcp-token M` | string | — | Run-scoped token the harness spends. |
| `--mode M` | string | — | Permission mode. |
| `--concurrency N` | int | `0` | Max cards at once; 0 leaves the hub's value. |
| `--profile P` | string | — | Profile key. |
| `--wait-ms N` | int | `0` | How long a permission request waits for an answer, in ms; 0 leaves the hub's value. |
| `--enabled true\|false` | string | — | True or false. |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet bridge set reviewer --board brd_456
```

### fleet bridge rm

Remove a roster row.

```text
fleet bridge rm KEY
```

| Argument | Meaning |
|---|---|
| `KEY` | the roster key |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet bridge rm reviewer
```

## fleet principals

Identities, service principals and their credentials.

```text
fleet principals <verb> ...
```

Only `list` works against a current hub; the rest are managed by the account service.

Subcommands: [`list`](#fleet-principals-list), [`suspend`](#fleet-principals-suspend), [`restore`](#fleet-principals-restore), [`add-service`](#fleet-principals-add-service), [`add-credential`](#fleet-principals-add-credential), [`revoke-credential`](#fleet-principals-revoke-credential).

`fleet principals -h` prints:

```text
usage:
  fleet principals list
  fleet principals suspend ID
  fleet principals restore ID
  fleet principals add-service HANDLE --client CLIENT --scope SCOPE[,SCOPE]
  fleet principals add-credential PRN_ID --client CLIENT
  fleet principals revoke-credential SVC_ID
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet principals list
```

### fleet principals list

Who exists in this workspace, read through the account service.

```text
fleet principals list
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet principals list
```

### fleet principals suspend

Suspend a principal, reversibly (older hubs).

```text
fleet principals suspend ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `ID` | a `prn_` id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet principals suspend prn_123
```

### fleet principals restore

Undo a suspension (older hubs).

```text
fleet principals restore ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `ID` | a `prn_` id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet principals restore prn_123
```

### fleet principals add-service

Create a service principal with its first credential (older hubs).

```text
fleet principals add-service HANDLE --client CLIENT --scope SCOPE[,SCOPE]
```

The response carries the credential's secret once; it cannot be read again. On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `HANDLE` | the service's handle |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--client CLIENT` | string | — | The HUB_OAUTH_CLIENTS id whose audiences its tokens carry. **Required.** |
| `--scope SCOPE[,SCOPE]` | string | — | Comma-separated grant scopes, e.g. evidence:read. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet principals add-service evidence-reader --client superwitness --scope evidence:read
```

### fleet principals add-credential

Add a credential to a service principal: the first half of a rotation (older hubs).

```text
fleet principals add-credential PRN_ID --client CLIENT
```

The old credential keeps working until `revoke-credential`, so the consumer can switch with no gap. On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `PRN_ID` | the service principal's id |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--client CLIENT` | string | — | The HUB_OAUTH_CLIENTS id whose audiences its tokens carry. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet principals add-credential prn_123 --client superwitness
```

### fleet principals revoke-credential

Revoke one service credential (older hubs).

```text
fleet principals revoke-credential SVC_ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `SVC_ID` | the credential's `svc_` id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet principals revoke-credential svc_123
```

## fleet grants

Dispatch authority, as a document (older hubs).

```text
fleet grants <list|show|set|rm> ...
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens. See [Dispatch and grants](/use/grants/).

Subcommands: [`list`](#fleet-grants-list), [`show`](#fleet-grants-show), [`set`](#fleet-grants-set), [`rm`](#fleet-grants-rm).

`fleet grants -h` prints:

```text
usage:
  fleet grants list
  fleet grants show PRINCIPAL_ID
  fleet grants set PRINCIPAL_ID --file PATH|-
  fleet grants rm PRINCIPAL_ID
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet grants list
```

### fleet grants list

Every grant.

```text
fleet grants list
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet grants list
```

### fleet grants show

One principal's grant.

```text
fleet grants show PRINCIPAL_ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `PRINCIPAL_ID` | a `prn_` id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet grants show prn_123
```

### fleet grants set

Replace a principal's grant with a document.

```text
fleet grants set PRINCIPAL_ID --file PATH|-
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `PRINCIPAL_ID` | a `prn_` id |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--file PATH\|-` | string | — | Grant document, or - for stdin. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet grants set prn_123 --file grant.json
```

### fleet grants rm

Remove a principal's grant.

```text
fleet grants rm PRINCIPAL_ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `PRINCIPAL_ID` | a `prn_` id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet grants rm prn_123
```

## fleet users

People: list, show, ban, unban, role (older hubs).

```text
fleet users <list|show|ban|unban|role> ...
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

Subcommands: [`list`](#fleet-users-list), [`show`](#fleet-users-show), [`ban`](#fleet-users-ban), [`unban`](#fleet-users-unban), [`role`](#fleet-users-role).

`fleet users -h` prints:

```text
usage:
  fleet users list
  fleet users show ID
  fleet users ban ID --reason "why" [--expires RFC3339]
  fleet users unban ID
  fleet users role ID --role ROLE
```

**Needs:** A workspace admin's token. Anyone else is refused with 403.

**Exit status:** As below for each verb; with no verb, prints the usage and exits 2.

```sh
fleet users list
```

### fleet users list

Every account.

```text
fleet users list
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet users list
```

### fleet users show

One account.

```text
fleet users show ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `ID` | the user's id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet users show usr_123
```

### fleet users ban

Ban an account, with a recorded reason.

```text
fleet users ban ID --reason "why" [--expires RFC3339]
```

A reason is required: a ban nobody can review later is one the next person cannot lift with confidence. On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `ID` | the user's id |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--reason TEXT` | string | — | Why, recorded with the ban. **Required.** |
| `--expires RFC3339` | string | — | RFC3339 instant the ban lifts itself. |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet users ban usr_123 --reason "shared credentials" --expires 2026-12-01T00:00:00Z
```

### fleet users unban

Lift a ban.

```text
fleet users unban ID
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `ID` | the user's id |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet users unban usr_123
```

### fleet users role

Set an account's role.

```text
fleet users role ID --role ROLE
```

On a hub that signs in through an account service (every current hub), this record is managed there: the hub answers 410 `managed_by_org_plane` with the account service's URL, which this prints, and the command exits 1. It works as described only against an older hub that still issues its own tokens.

| Argument | Meaning |
|---|---|
| `ID` | the user's id |

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--role ROLE` | string | — | The role to set. **Required.** |

**Needs:** A workspace admin's token. Anyone else is refused with 403.

```sh
fleet users role usr_123 --role admin
```

## fleet update

Replace this binary with the newest release.

```text
fleet update [--check] [--force]
```

Fetches the `agentpod-fleet` asset for this platform and verifies it against the release's `SHA256SUMS`. There is no service to restart: the next invocation is the new binary.

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `--check` | bool | `false` | Resolve and report current/latest version, no changes. |
| `--force` | bool | `false` | Update even when already on the latest version. |

**Needs:** Nothing from the hub. Network access to GitHub releases, and write access to the binary's own path.

**Exit status:** 0 when up to date, updated, or (with `--check`) reported. 1 when the release could not be fetched or verified.

```sh
fleet update --check
fleet update
```

## fleet version

Print the version and platform.

```text
fleet version
```

**Needs:** Nothing. Runs without a credential or a hub.

**Exit status:** 0.

```sh
fleet version   # agentpod-fleet v0.1.90 darwin/arm64
```

## fleet help

Print the verb list and how credentials work.

```text
fleet help
fleet -h
fleet
```

All three print the same text. A group's own usage is `fleet <verb> -h`; for verbs with flags, `fleet <verb> <subverb> -h` prints them with their defaults.

**Needs:** Nothing. Runs without a credential or a hub.

**Exit status:** 0.

```sh
fleet help
```
