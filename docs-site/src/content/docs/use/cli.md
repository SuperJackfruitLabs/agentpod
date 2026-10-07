---
title: apn and fleet
description: Two binaries — the resident node daemon and the client that acts as you — and why their credentials never mix.
---

AgentPod ships two command-line binaries. `apn` (`agentpod-node`) is the resident daemon
installed on an enrolled host. `fleet` (`agentpod-fleet`) is a separate client you run
anywhere that is **not** an enrolled node — a laptop, CI, an agent's own workspace.

Every command, subcommand, flag and environment variable is in the generated references:
[`apn` reference](/reference/apn/) and [`fleet` reference](/reference/fleet/). This page is
the why; those are the what.

## Two binaries, not two modes

`apn` acts on **this machine**: `status`, `start`, `stop`, `logs`, `service`, `telemetry`,
`enroll`, `run`, the harness plugin installers, `detect`, `scan`, `acp`, `update`. Those that talk to the hub use the credential `apn enroll`
stored on this host, which says *"I am this host."*

`fleet` acts on the fleet **as you** — everything from `whoami` to rolling a release to editing a
grant. It uses a token held by a person or an agent: the one `fleet login` obtains from your
workspace's account service, or `$AGENTPOD_TOKEN`.

```sh
apn status          # how is this machine?
fleet whoami        # who am I?
```

`apn` and `fleet` are separate binaries built from the same repository and sharing no code —
`apn` links none of `fleet`'s code, and `fleet` links none of `apn`'s. A fleet command
**never falls back to the node's credential**, and that is now structural rather than
conventional: `fleet` cannot reach the node's credential at all, and `apn` cannot reach the
stored fleet token — `apn` links none of the code that reads `fleet login`'s token file.
`apn acp` is the one exception, and it is narrower than it looks: it accepts a principal
token you hand it explicitly, via `$AGENTPOD_TOKEN` or `--token`, never the file on disk. A
node secret asserts which host you are; it was never an authority to operate a fleet, and
treating it as one would mean that rooting any laptop in the fleet hands over the whole
fleet. The two credentials are stored separately, in separate config directories, and are
never substituted for one another.

## Installing `fleet`

```sh
curl -fsSL https://github.com/SuperJackfruitLabs/agentpod/releases/latest/download/install-fleet.sh | sh
```

This installs a client only — it enrols nothing and installs no service. `apn` has its own
installer; see [Enrolling a node](/use/nodes/).

## Signing in

```sh
fleet login
```

`fleet login` signs in through your workspace's **account service**. It prints a page and a
code, opens the page if it can, and waits while you confirm the code in a browser. Any browser
will do — the one on your laptop works for a `fleet` running over SSH — and `BROWSER=none`
stops it trying to open one.

The browser opens **once**, not once per lapse. A token lasts five minutes; approving the code
also stores a **device credential** for this machine, and every later command exchanges it for a
fresh token without a browser. The account service issues, lists and revokes device
credentials, so that is where you manage them:

```sh
fleet devices      # says where this machine's devices are listed: the account service's Devices page
fleet logout       # signs this machine out: deletes the stored token and device credential
```

`fleet logout` is **local**. It deletes both files but does not revoke the device credential,
which belongs to the account service — it prints the Devices page where you can. Revoke a
machine you no longer have from that page, from any browser. `fleet devices revoke` does not
revoke there either: it points at the same page and exits 1, because nothing was revoked.

(A hub old enough to issue its own tokens signs you in through its own browser page instead,
and there `fleet devices` and `fleet devices revoke` list and revoke at the hub.)

Then:

```sh
fleet whoami            # who the stored token says you are
fleet whoami --json     # the same, for scripts
fleet nodes             # the fleet's nodes
fleet agents            # the agents you may dispatch
fleet stats             # fleet totals
fleet activity          # recent fleet activity
```

Set `$AGENTPOD_HUB` to talk to a hub other than the default, and `$AGENTPOD_DEVICE_NAME` to name
this machine in the device list.

### What `fleet agents` actually answers

Not "every agent in the fleet" — **the agents this token may dispatch**. That answer is
read from a claim the hub signed into the token itself. It is not a query parameter, not a
header, and not derived from anything sent alongside the token, so there is nothing in the
request to tamper with.

An agent's token is refused here outright, whatever it may dispatch. Enumerating your
siblings is reconnaissance, and the authority to *ask an agent to work* was never the
authority to *find out what else exists*.

If you have been granted nothing, you get an empty list rather than an error. That is the
truth, and it is something you can act on.

## The rest of `fleet`

Everything the hub exposes should be reachable from here. If something is not, that is a gap rather
than a decision — with two deliberate exceptions: anything that acts as **this machine** rather
than as you (that is `apn`), and the interactive surfaces — a terminal, an ACP session — which are
a console's job rather than a script's.

### Nodes and stations

```sh
fleet nodes                                  # the fleet's nodes
fleet nodes update [--node <name>]           # roll the newest release to every node
fleet nodes telemetry [--endpoint <url>|--off]  # each node's OpenTelemetry export (admin)
fleet invite                                 # mint a token a machine presents to `apn enroll`

fleet stations detected --node <nodeId>      # what the node reports right now
fleet stations list     --node <nodeId>      # adopted stations, with their ids
fleet stations adopt    --node <nodeId> --key <key> [--key <key> …]
fleet stations unadopt  --station <stationId>
```

**A detected station is not an agent until it is adopted.** Adopting re-detects on the node first,
so a key that has gone away is not adopted from a stale list.

`fleet nodes update` rolls a release without needing the hub's root credential.

### One station

```sh
fleet station lifecycle --station <id> --action start|stop|restart
fleet station cleanup plan  --station <id>
fleet station cleanup apply --station <id> --path <p> [--path <p> …]
fleet station changeset status --station <id> [--base <ref>]
fleet station changeset diff   --station <id> --side uncommitted|committed [--path <p>]
fleet station fs write|mkdir|move|delete --station <id> …
```

The same operations as the console's panels, each gated on a capability the station declares. See
[What you can do to a station](/use/panels/).

### Git identity

```sh
fleet stations git-identity --station <stationId>   # what it can push to forge as
fleet stations grant-push   --station <stationId>   # give it a forge push key
fleet stations revoke-push  --station <stationId>   # take that key away
```

**Push access is granted per station and never by adopting one.** Most stations never touch git,
and a forge key for every station is an account nobody uses and a key nobody revokes.

The keypair is generated **on the node** and the private half never leaves it — `grant-push` asks
for the public half and registers that. The hub holds no secret.

### Staffing

```sh
fleet staff options
fleet staff create   --file <path>|-
fleet staff assign   --station <stationId> --file <path>|-
fleet staff unassign --station <stationId>
```

Putting an agent in a station, or taking it out.

### Skills

```sh
fleet skills …    # artifacts, releases, cohorts, canaries, native placement
```

Its own page: [Managed skills](/use/skills/).

<a id="plugins"></a>

### Plugins

```sh
fleet plugins inventory --station <stationId>
fleet plugins plan      --station <stationId> --action enable|disable
fleet plugins show      --station <stationId> --operation <opId>
fleet plugins inspect   --station <stationId> --operation <opId>
fleet plugins apply     --station <stationId> --operation <opId> --plan-digest <sha256>
fleet plugins history   --station <stationId>
```

The same plan → inspect → apply shape as skills: the node plans, you read the plan, and the apply
sends only the digest you reviewed. **Nothing here restarts a station.** These are the harness plugins behind
[voice replies](/use/voice/), live turn reporting, and [error reporting](/use/errors/).

### Authority

```sh
fleet principals list                    # who exists in this workspace
```

People, roles, bans, signup, grants and service principals are **managed by your workspace's
account service**. The `fleet users`, `fleet grants`, `fleet settings signup` and
`fleet principals suspend|restore|add-service|add-credential|revoke-credential` verbs remain for
hubs that predate it; a current hub answers them with `410` and the account service's URL. See
the [`fleet` reference](/reference/fleet/#fleet-principals) and
[Dispatch and grants](/use/grants/).

### The board bridge

```sh
fleet bridge list
fleet bridge add --key <key> …
fleet bridge set <key> …
fleet bridge rm  <key>
```

Which agent claims from which board, onto which station. See [Working a board](/use/boards/).

### Hub settings and substrate

```sh
fleet settings show
fleet settings signup|transcription|speech …
fleet runtimes list|providers|create|start|stop|rm
```

`settings` is hub-wide configuration: the [voice](/use/voice/) defaults for transcription and
speech. `runtimes` is the substrate nodes run on.

### Keeping it current

```sh
fleet update [--check]
fleet version
```

The binary a person invokes drifts more than the one a service runs, not less.

## Commands that need no enrolment

```sh
apn scan
apn acp --list
apn acp --station <id>
```

`apn scan` checks this machine's agent runtimes for exposure, and needs nothing at all — no
hub, no token, no network. It runs from a downloaded binary on a machine that has never been
near AgentPod. See [Checking for exposure](/use/scan/).

`apn acp` attaches a local ACP editor to a station on another machine. Like `fleet`, it takes
a hub token rather than this host's credential, so a laptop can use `apn`'s `acp` command
purely as a client without being enrolled. See [Attaching an editor](/use/acp/).

## Tokens on the command line

`fleet` takes its token from `$AGENTPOD_TOKEN` or from the file `fleet login` writes. There
is no `--token` flag on it.

`apn acp` does accept `--token`, and you should generally not use it: a token in an
argument lands in your shell history and in the process list. Prefer `$AGENTPOD_TOKEN`,
which is what the flag defaults to anyway.

(`apn enroll --token` is a different thing — that is a single-use *enrollment* token for
the machine, not a principal's hub token.)

## Getting help

```sh
apn help            # apn's commands, grouped
apn <command> -h    # one apn command in detail
fleet help          # fleet's commands
fleet -h            # the same text
```

`apn`'s help text is generated from a single table in the binary, so `apn help <cmd>` and
`apn <cmd> -h` cannot disagree with each other. `fleet`, `fleet help` and `fleet -h` all print
the same block, and `fleet <verb> -h` prints that verb's usage. Both binaries' verb lists come
from the same tables the [`apn`](/reference/apn/) and [`fleet`](/reference/fleet/) reference
pages are generated from, and a test fails when a command or flag has no entry.

Help flags are checked **before** anything happens: `apn stop -h` prints help and does not
stop the service, `apn service -h` cannot install or uninstall anything, and `fleet login -h`
prints help without opening a browser.
