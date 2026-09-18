# The fleet client becomes its own binary, because a worker is not an operator

**Date:** 2026-09-18
**Product:** AgentPod (`apps/node-agent`), release workflow, and a new installer
**Status:** Spec. Not built.
**Supersedes:** `docs/superpowers/specs/2026-09-04-apn-modes-design.md` — its
"Why one binary rather than two" section specifically. The rest of that spec, in
particular its credential rule, is adopted here unchanged.
**Follows:** `estate → docs/2026-09-17-guild-operating-model-draft.md` §5 (a
worker is a disposable session), §46 (operator connections are not worker
credentials) and §241 (host administration is a separate capability).

---

## What changed since 2026-09-04

The earlier spec asked how a laptop or CI job acts on the fleet when every `apn`
verb acts as *this machine*. It answered with two modes in one binary, split on
credential, and that shipped: `apn fleet` released in v0.1.33 on 2026-09-17.

Its reasoning against a second binary was sound for the question it had:

> every station carries the fleet verbs it cannot use. That is a larger `--help`,
> not a larger attack surface — an attacker with shell on a station can already
> `curl` every one of these endpoints, and the credential rule above means the
> binary's presence grants nothing.

**That remains true, and this spec does not dispute it.** Fleet verbs on a node
are harmless: they are HTTP calls to the hub, gated by a token the node does not
hold.

What arrived afterwards is the other direction. The Guild operating model, dated
2026-09-17, introduces a principal the 09-04 spec had no reason to consider: a
**disposable worker** that receives "one scope, one budget reservation, and an
expiry" and "cannot pass on broader privileges" (§116), running in an isolated
environment that is destroyed when its run ends (§239, §243).

Such a worker needs to *drive* the fleet. It has no business being able to *be* a
node. `apn` today carries `enroll`, `run` and `service install|uninstall`, which
are local operations against the host rather than calls to the hub — so the
credential rule that makes fleet verbs safe on a node does not make node verbs
safe on a worker. The rule is about tokens; these verbs need none.

**The honest limit of that argument**, stated here so no reader has to rediscover
it: a worker with shell access can already write a systemd user unit, and `apn
enroll` does nothing without a hub-issued enrollment token. The split is
therefore **not** a boundary that stops an attacker who already has the shell. It
is a smaller, single-purpose tool for the principal the model says should hold
the least — which is a real benefit and a weaker claim than "security boundary".
It is recorded as the weaker claim.

## The plainer reason, which is neither security nor size

The argument above is about what a worker should be able to do. There is a
simpler one that does not depend on threat models at all, and it is the one that
should be read first: **the two programs have different lifecycles, and nothing
in common except a repository.**

| | `agentpod-node` | `agentpod-fleet` |
|---|---|---|
| shape | a resident daemon | an interactive client |
| lifetime | enrolled once, runs continuously | invoked, does one thing, exits |
| audience | the host it is installed on | people and agents, many times a day |
| where | enrolled nodes | laptops, CI, worker sandboxes — machines that are *not* nodes |
| installed by | an enrolment that takes a hub URL and a token | placing a binary |
| updated | deliberately, per §295, because a node's version is operational state | whenever, because an exited process has no version to be at |

Packaging a service that must stay up together with a command someone runs
forty times a day gives two things one install path, one update cadence and one
release story, when they share none of those needs. That is the case for the
split even if every security consideration in this spec were struck out.

## The decision

**Two binaries from one Go module.** The fleet client becomes `agentpod-fleet`,
aliased `fleet`. `apn` keeps every verb it has except one, and `apn fleet` is
**removed outright** rather than deprecated.

The credential rule from 2026-09-04 is adopted verbatim and is now enforced by
construction rather than by discipline: neither binary can read the other's
credential, because neither links the other's code.

| binary | alias | acts as | credential |
|---|---|---|---|
| `agentpod-node` | `apn` | this machine | `<nodeId>:<nodeSecret>` in `<UserConfigDir>/agentpod-node/config.json` |
| `agentpod-fleet` | `fleet` | a principal, human or agent | a hub JWT from `AGENTPOD_TOKEN`, else `<UserConfigDir>/agentpod/token.json` |

`apn fleet login` becomes `fleet login`. The subcommand's name becomes the
command's name, so no vocabulary is invented.

## Layout

The seam is already clean. `fleet.go` and `fleet_login.go` import exactly one
internal package between them, `internal/fleetcred`, which nothing in the daemon
touches. The daemon's own commands pull in `acp`, `config`, `descriptor`,
`gateway`, `terminal`, `enroll`, `service`, `selfupdate`, `posture`, `host`,
`fsops` and `gitops`.

```
apps/node-agent/
  cmd/agentpod-node/     → apn      daemon and node verbs
  cmd/agentpod-fleet/    → fleet    fleet verbs only              [new]
  internal/fleetcred/              unchanged; already internal to the module
```

Moving to `cmd/agentpod-fleet/`: `fleet.go`, `fleet_login.go`, `fleet_test.go`,
`fleet_login_test.go`, the `fleet` entry in `help.go`, and the portion of
`help_test.go` that cross-checks fleet verbs against fleet help.

No package is rewritten. Files move; imports follow.

## Command surface

```
fleet login | whoami [--json] | logout
fleet nodes | agents | stats | activity
fleet version | help                        binary-level, as every command has
```

Seven fleet verbs, which are exactly the seven v0.1.33 shipped under `apn fleet`.
`version` and `help` are not fleet verbs; they belong to any binary and are
listed only so the surface is complete.

`apn` keeps `enroll`, `run`, `detect`, `scan`, `acp`, `update`, `version`,
`status`, `start`, `stop`, `restart`, `logs`, `service` and `help`, all
unchanged. `apn fleet` is gone: it falls through to the existing default branch
and exits non-zero with `unknown command: "fleet"`.

**Removed, not deprecated.** There is no shim, no warning and no alias. The
product has no users holding anything, so a compatibility path would be a path
that has never carried a caller — the same reasoning proposed for the
`kbn_` → `spa_` change in `charter → decisions/2026-09-18-a-credential-prefix-is-only-expensive-once-someone-holds-one.md`,
which is a draft in charter#8 and not merged at the time of writing. v0.1.33
becomes the only release that ever carried `apn fleet`, having carried it for one
day.

## Installing

`fleet` gets **its own installer**, `apps/node-agent/scripts/install-fleet.sh`,
modelled on superpipeline's `packages/cli/install.sh`: it places the binary and
alias, refuses to overwrite a file it did not create, checks both names before
writing either, reports what it did on stdout, says so when the target directory
is not on `PATH`, and supports `--uninstall`.

**`install.sh` is not extended.** The released node installer enrolls a host and
installs a service; teaching it to also place the fleet client would invite
putting both on a node, which is the coupling this spec exists to break. The two
installers stay separate and neither calls the other.

Unlike `install.sh`, the fleet installer downloads a released artifact rather
than enrolling anything, so it takes no `HUB_URL` and no `TOKEN`. Signing in is
`fleet login`, afterwards and separately.

## Release

The build matrix gains a second binary, from the same tag, so both carry the same
`-X main.version=${GITHUB_REF_NAME}`. Assets go from 7 to 12: four
`agentpod-node-*`, four `agentpod-fleet-*`, `agentpod-node.service`,
`install.sh`, `install-fleet.sh`, and `SHA256SUMS`.

**The trap this must not fall into.** The `fly-pin` job's *"Refuse to pin to an
incomplete release"* step checks a hardcoded list:

```
for want in agentpod-node-linux-amd64 agentpod-node-linux-arm64 SHA256SUMS
```

A release that built no fleet binaries would pass that check unchanged. The list
must gain `agentpod-fleet-linux-amd64` and `agentpod-fleet-linux-arm64`. That
guard exists because v0.1.7 shipped incomplete; adding artifacts without
extending it reintroduces exactly the failure it was written for.

## Self-update

`apn update` keeps updating `agentpod-node` and nothing else. `fleet` gets no
self-update in this change: it is not a node component, and letting a node's
update cycle reach a sibling binary re-couples what this separates. It is
installed and upgraded by re-running its installer.

## What this costs

**AgentPod#228 is open and this doubles part of it.** macOS node-agent releases
are unsigned, and the 2026-09-04 spec rejected a second binary precisely because
signing and notarisation are per-artifact. That cost is real and this spec does
not dissolve it.

What it does is deferred, not incurred: **neither binary is signed today**, so
the split regresses nothing that currently works. It adds one more artifact to
the eventual scope of #228 — two to sign instead of one — at a moment when the
product has no users for whom the re-prompt is a cost. If #228 is done before
this ships, it is done for two artifacts instead of one. If it is done after,
nothing changed except the count.

**A second release artifact is a second thing that can be missing**, which is
what the `fly-pin` guard above is for.

**Two installers rather than one**, which is more surface to document and keep
true. `docs/OPERATING.md` gains a fleet section and its node one stops mentioning
`apn fleet`.

## Testing

Tests first, each watched failing before the code that passes it.

- **`apn` does not dispatch `fleet`.** The removal, asserted rather than assumed.
- **The fleet binary carries no node verbs** — no `enroll`, `run`, or `service`.
  The split, asserted from the outside.
- **`help_test.go`'s existing property moves intact**: every verb dispatched in
  `fleet.go` appears in fleet help. It already reads the dispatch switch out of
  the source rather than restating it, so it keeps working after the move.
- **`fleet_test.go` and `fleet_login_test.go` move unchanged.** If they pass
  after relocation with no edits, the extraction was faithful; needing to change
  them is a signal the move was not clean.
- **The installer gets the suite it deserves**, matching what superpipeline#77
  established: links both names, refuses to clobber a stranger's file, uninstalls
  only its own links, reports a `PATH` that cannot see it.
- `go build ./...` and `go vet ./...` cover both commands.

## What this does not do

- **Nothing about how credentials are issued, stored or refreshed.** That is
  `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange`
  and `…-signing-in-is-not-a-products-verb`, both drafts, and the per-run worker
  credential record that does not yet exist. This spec moves verbs between
  binaries and changes no authority.
- **Nothing in superpipeline.** Its docs cite `apn fleet login`; correcting them
  belongs to whichever change lands its own `login`.
- **No signing.** #228 remains open and is not addressed here.
- **No fleet verbs are added or removed.** The seven that shipped in v0.1.33 are
  the seven that move.
