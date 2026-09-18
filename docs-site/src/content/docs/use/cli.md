---
title: apn and fleet
description: Two binaries — the resident node daemon and the client that acts as you — and why their credentials never mix.
---

AgentPod ships two command-line binaries. `apn` (`agentpod-node`) is the resident daemon
installed on an enrolled host. `fleet` (`agentpod-fleet`) is a separate client you run
anywhere that is **not** an enrolled node — a laptop, CI, an agent's own workspace.

## Two binaries, not two modes

`apn` acts on **this machine**: `status`, `start`, `stop`, `logs`, `enroll`, `run`, `detect`,
`scan`, `service`, `acp`, `update`. Those that talk to the hub use the credential `apn enroll`
stored on this host, which says *"I am this host."*

`fleet` acts on the fleet **as you**: `login`, `whoami`, `logout`, `nodes`, `agents`, `stats`,
`activity`. It uses a hub-issued token held by a person or an agent — the one `fleet login`
writes, or `$AGENTPOD_TOKEN`.

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

This opens a browser, you sign in to the hub, and the token is written to disk. After that:

```sh
fleet whoami            # who the stored token says you are
fleet whoami --json     # the same, for scripts
fleet nodes             # the fleet's nodes
fleet agents            # the agents you may dispatch
fleet stats             # fleet totals
fleet activity          # recent fleet activity
fleet logout            # forget the stored token
```

Set `$AGENTPOD_HUB` to talk to a hub other than the default.

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
`apn <cmd> -h` cannot disagree with each other. `fleet` has one command group — everything it
does acts as a principal — so `fleet`, `fleet help` and `fleet -h` all print the same block.

Help flags are checked **before** anything happens: `apn stop -h` prints help and does not
stop the service, `apn service -h` cannot install or uninstall anything, and `fleet login -h`
prints help without opening a browser.
