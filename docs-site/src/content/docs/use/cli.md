---
title: The apn command
description: Two modes — the machine and the principal — and why the credentials never mix.
---

`apn` is the node agent binary, and it runs in **two modes**.

## The two modes

**Node verbs** act on *this machine*: `status`, `start`, `stop`, `logs`, `enroll`, `run`,
`detect`, `scan`, `service`, `update`. They use the credential `apn enroll` stored on this
host, which says *"I am this host."*

**Fleet verbs** act on the fleet as *you*: `apn fleet <verb>`. They use a hub-issued token
held by a person or an agent — the one `apn fleet login` writes, or `$AGENTPOD_TOKEN`.

```sh
apn status          # how is this machine?
apn fleet whoami    # who am I?
```

A fleet command **never falls back to the node's credential.** A node secret asserts which
host you are; it is not an authority to operate a fleet, and treating it as one would mean
that rooting any laptop in the fleet hands over the whole fleet. The two credentials are
stored separately and are never substituted for one another.

## Signing in

```sh
apn fleet login
```

This opens a browser, you sign in to the hub, and the token is written to disk. After that:

```sh
apn fleet whoami            # who the stored token says you are
apn fleet whoami --json     # the same, for scripts
apn fleet nodes             # the fleet's nodes
apn fleet agents            # the agents you may dispatch
apn fleet stats             # fleet totals
apn fleet activity          # recent fleet activity
apn fleet logout            # forget the stored token
```

Set `$AGENTPOD_HUB` to talk to a hub other than the default.

### What `apn fleet agents` actually answers

Not "every agent in the fleet" — **the agents this token may dispatch**. That answer is
read from a claim the hub signed into the token itself. It is not a query parameter, not a
header, and not derived from anything sent alongside the token, so there is nothing in the
request to tamper with.

An agent's token is refused here outright, whatever it may dispatch. Enumerating your
siblings is reconnaissance, and the authority to *ask an agent to work* was never the
authority to *find out what else exists*.

If you have been granted nothing, you get an empty list rather than an error. That is the
truth, and it is something you can act on.

## The one command that needs no node

```sh
apn acp --list
apn acp --station <id>
```

`apn acp` attaches a local ACP editor to a station on another machine. It is the only
command that does not require this host to be enrolled — a laptop can install `apn` purely
as a client. See [Attaching an editor](/use/acp/).

## Tokens on the command line

The `fleet` verbs take their token from `$AGENTPOD_TOKEN` or from the file `apn fleet
login` writes. There is no `--token` flag on them.

`apn acp` does accept `--token`, and you should generally not use it: a token in an
argument lands in your shell history and in the process list. Prefer `$AGENTPOD_TOKEN`,
which is what the flag defaults to anyway.

(`apn enroll --token` is a different thing — that is a single-use *enrollment* token for
the machine, not a principal's hub token.)

## Getting help

```sh
apn help            # everything, grouped
apn help fleet      # one command in detail
apn fleet -h        # the same text, plus flag defaults
```

The help text is generated from a single table in the binary, so `apn help <cmd>` and
`apn <cmd> -h` cannot disagree with each other.

Help flags are checked **before** anything happens: `apn stop -h` prints help and does not
stop the service, and `apn service -h` cannot install or uninstall anything.
