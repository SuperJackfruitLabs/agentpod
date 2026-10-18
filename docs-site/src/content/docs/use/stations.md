---
title: Stations
description: Detecting, adopting and organising the runtimes on your nodes.
---

A **station** is one runtime instance on a node — a single place where an agent works.

## Detection versus adoption

These are two different things, and the distinction is the point.

**Detection** is the node agent looking at the host and reporting what it finds. It happens
without you asking, and it changes nothing.

```sh
apn detect
```

Prints what this host has, as JSON. No hub connection, no account required.

**Adoption** is you deciding a station should be managed. Only an adopted station is in the
registry, and only an adopted station has panels.

The gap between them is deliberate. A machine may run agents that are none of AgentPod's
business, and detecting one is not consent to manage it.

## The tree

Stations nest. A harness that manages sub-runtimes appears as a parent with children
beneath it, which is why the console shows a tree under each node rather than a flat list:

```
node: workhorse
 └── hermes
      ├── coder-kai
      └── hanuman
```

Deleting a parent removes its children with it — a child station cannot outlive the station
it runs inside.

## Capabilities

Each station declares which operations it supports. A request for a capability a station
has not declared is refused **at the hub**, with no call to the machine at all.

That ordering matters for a reason worth stating: a refusal that never leaves the hub
cannot be turned into a way to probe what is on the host.

## Purpose

A station's **purpose** is what it is for — `personal`, `work`, or any label you pick. It
is not where it runs.

Set it on the station. A node's purpose is only the default applied at adoption to a
station that has none of its own; the station's is the one anything actually reads. A
station nobody has labelled is filed under no Matrix space at all.

## Matrix identity

A station can have a Matrix identity, so that talking to an agent is just messaging. Two
modes, and never both at once:

| Mode | Means |
|---|---|
| `bridge` | The Application Service speaks for the station |
| `harness` | The station runs its own Matrix client |

In `bridge` mode the identity is minted by the Application Service and stored separately
from whatever the harness reports about itself. Nothing on the host can report that
identity, so nothing on the host can erase it.

The station's room is created with it, and **created encrypted** — there is nothing extra to turn
on, and no window in which it existed in the clear. Rooms hang under a space named for the machine
they run on, so the roster groups itself in any client that reads the hierarchy.

An agent can be given an **avatar**: preview a workspace image and set it as the station's picture.
A roster of thirty identical default avatars is a roster you read by name only.

What else arrives in that room — voice notes, permission questions, a card when a turn fails, a
board's approval gates — is [Talking to an agent in a room](/use/rooms/).

## Git identity

A station can be given a key to push to a forge with:

```sh
fleet stations git-identity --station <stationId>
fleet stations grant-push   --station <stationId>
fleet stations revoke-push  --station <stationId>
```

**Granted per station, never by adopting one.** Most stations never touch git, and a forge key for
every station is an account nobody uses and a key nobody revokes.

The keypair is generated **on the node** and the private half never leaves it: `grant-push` asks
for the public half and registers that. The hub holds no secret, so a hub compromise does not hand
over commit access.

**Commits carry the agent, not the host.** With the key, the hub sends the station's commit author:
the agent's display name in readable form (a handle like `fixture-agent` — or a station key like `harness:fixture-agent` — becomes `Fixture Agent`;
without a display name, the forge account's full name minus its ` (agent)` suffix), and the forge
account's email exactly as forge stores it. That email is synthetic — an agent has no mailbox — and
it is what the forge links a commit to the account by, so the name carries no "(agent)" suffix: the
email's domain already says it. The node records the author beside the key and starts the station's
harness and terminal with `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
`GIT_COMMITTER_EMAIL` — environment, never git config, so nothing is written to any repository or
to the host. A station with no identity gets none of these and keeps the host's git config.
`git-identity` shows the author as `authorName`/`authorEmail`. An identity provisioned before
authors existed gets one the next time its node connects (a node update reconnects it), with no key
regenerated. A harness or terminal already running keeps the environment it started with.

## Forge API access

A station's agent can be given scoped access to a forge's **API** (issues, pull requests, comments,
reviews) for named repositories. This is separate from [git identity](#git-identity): SSH keeps
carrying git, and neither grant ever creates the other.

```sh
fleet stations forge-api list   --station <stationId>
fleet stations forge-api grant  --station <stationId> --provider forgejo \
    --instance https://forge.example --repo org/repo --preset issues
fleet stations forge-api verify --station <stationId> --grant <grantId>
fleet stations forge-api rotate --station <stationId> --grant <grantId>
fleet stations forge-api policy --station <stationId> --grant <grantId> --preset issues \
    --rule 'deny: DELETE /repos/**'
fleet stations forge-api revoke --station <stationId> --grant <grantId>
```

**The agent never holds the token.** The station's broker (`stk`) holds the credential and adds it
to the requests its policy allows, whichever client the agent uses (`tea`, `gh`, `curl`, an MCP
server). The hub delivers the credential **sealed** to the station's broker key. For a supplied or
app grant the hub relays ciphertext it cannot open; for a minted grant it holds the token briefly
between minting and sealing (see Limits).

**Operator only.** Every verb except `list` needs the hub operator seat **and** the control pair's
reach over the station's agent; owning the station is not enough (403). An agent must not, and
cannot, grant itself access. The forge account is never taken from the request: a minted grant is
for the station's occupying agent, a supplied or app grant for the `--expect-login` you declare.
A minted grant on a station with no occupant is refused (409); a supplied or app grant does not
need one.

**Three credential modes.**

| Mode | What it is | Where the credential comes from |
|---|---|---|
| `minted` (default) | The agent's own forge account | The hub mints a token, limited to the listed repositories, on its configured forge |
| `supplied` | A machine account you made by hand (a GitHub PAT, for instance) | You, on stdin |
| `app` | A GitHub App installation, acting as the bot | You, on stdin: `app_id=…`, `installation_id=…`, `private_key=…` lines |

Today the hub accepts Forgejo `minted` (only on its configured forge) and `supplied`, and GitHub
`app` and `supplied`. Gitea and Bitbucket are refused until their adapters exist.

A supplied or app credential is **never a flag** (there is no `--token`). It is read from stdin,
sealed on your machine to the station's broker key (fetched once from the hub, before anything is
created), and only the sealed envelope is sent:

```sh
pbpaste | fleet stations forge-api grant --station <stationId> --provider github \
    --instance https://github.com --repo org/repo --mode supplied --expect-login octo-bot
```

If the grant is created but the envelope does not arrive, the CLI names the grant: re-send with
`fleet stations forge-api secret --station <stationId> --grant <grantId>` (add `--mode app` for an
App's fields). A sealed credential the station does not acknowledge within 24 hours is discarded.

**Policy.** A grant names its repositories and a preset: `read`, `issues`, `pull-requests`
(no merge), `maintain`, or `none` (start from nothing). `--rule 'allow: METHOD /path'` and
`--rule 'deny: METHOD /path'` add to it, repeatable; a rule with a body condition goes in
`--rules-file`, a JSON array such as
`[{"allow": "PATCH /repos/org/repo/issues/*", "when": {"body.state": "absent"}}]`. Rules narrow the
token and never widen it; a `deny` wins; `DELETE` is denied by every preset. `policy` **replaces**
the preset, rules and GraphQL setting (GraphQL is off unless `--allow-graphql`, so omitting the flag
turns it off), and needs no new
credential. A minted token's provider-side scopes follow a changed preset only from the next
`rotate`; until then the broker's rules are what apply.

**Status.** `list` prints each grant's state, mode, account, isolation, provider, instance, preset
and repositories, and never a token. States run `authorised → provisioned → delivered → verified`,
plus `failed`, `revoking` and `revoked`. `verified` means the broker made a real read call as the
expected account **and** a node that reports bypass evidence showed the broker carries the
station's traffic. How `verify` reads that evidence:

- A client that **bypassed** the broker fails the grant (`failed`, reason `bypassed: <clients>`),
  even one that was `verified` before.
- **No path routed** through the broker (`not-wired: <paths>`) is inconclusive: the state is kept,
  so a first verify stays `delivered`; the reason is written only if it would not replace another
  lifecycle reason.
- The identity matched but the node could not show the traffic is brokered: the grant stays (or
  goes back to) `delivered` with `coverage-incomplete: <bypassed|failed|refused-ca|unwired|probe-failed>`.
- Brokered, but not every client was measured: `verified` with the note
  `coverage: partial (untested: <clients>)`. The harnesses' own clients have no safe probe today,
  so they report `untested` and **most grants verify with partial coverage**: the generic clients
  were seen going through the broker, the harness's own client was not checked.
- A node too old to send bypass evidence verifies as before (identity only).

A verify can take up to 90 seconds, because the node probes its clients first. Isolation is `separate-user` (the broker runs as its own OS user) or `same-user`
(degraded, see below).

**Rotation and revocation.** `rotate` (minted) mints a new token, delivers and verifies it, then
revokes the old one; if verification fails the old token stays live. For a supplied or app grant,
rotate by sending a new credential with `secret`. `revoke` first wipes the station's copy (best
effort; queued if the node is offline, which cuts the station's access at once), then revokes a
minted token at the forge, retrying until it succeeds. Reassigning, unassigning or deleting a
station (or removing its node) marks its grants `revoking` in the same change and never waits on
the forge; the reconcile sweep (every 5 minutes, and when a node reconnects) finishes the job. A
new occupant starts with nothing.

**Needs a node that supports it.** A station's node must advertise the `forge.api` capability;
an older node answers `capability-missing` rather than doing nothing.

**One broker per station.** Each station gets its own broker on the node, with its own OS user,
store, policy and proxy key, so one station's credential is never in another's store, and two
stations can hold grants for the same forge host. The node creates it the first time it is needed
and must run as root on Linux with systemd to do so; otherwise the node does not offer forge API
access at all.

**What that does not do.** The node starts agent sessions and terminals as itself, not as a user of
the station's own, so the agents it starts run as the node's user (root, on a node with brokers). An
agent that is root, or that shares a user with another station, can read what the broker protects, so
such a station's grants report isolation `same-user` (`isolationDetail`: `node-uid` or `shared-uid`)
and the node refuses a second station on a node (`station-uid-shared`) unless the operator
acknowledges that the stations are not isolated from each other. Separate brokers keep credentials
apart, not agents. An instance is never removed automatically: `apn forge-api prune --station
<stationId> --yes` does it, by hand. A grant's `present` in `list` means the node holds a policy entry
for it, not that the credential was delivered or works; `verify` says that. An operator can also list
services every station needs in a *shared base policy* file, which the node copies into each
station's own policy (`/etc/agentpod/stk-shared.yaml` by default; its credentials are not delivered
for you).
The proxy port range and the file locations are settings in the node config; the operating guide lists them.

### Limits

- **No protection against root.** An agent or user with root on the station can read the broker's
  store.
- **Same-user mode is weak, and today it is every station.** When the broker runs as the agent's
  own user, only file permissions separate them. Agents spawned by the node run as the node's uid,
  so every station currently reports isolation `same-user` (`isolationDetail` `node-uid`, or
  `shared-uid` when acknowledged on the node). The design calls for an operator acknowledgement
  before a write preset is granted in this mode, but **the hub does not implement it**: it records
  the isolation the node reports and does not refuse anything because of it, so grants (write
  presets included) succeed in `same-user` mode. Check `list` and grant write presets knowing that
  the agent can read the broker's store.
- **A node preparing its broker answers later, not never.** The first grant on a station can make
  the node install its broker instance; the hub waits up to 120 s for that (`forge.api.status`,
  `forge.api.deliver`). If an install is already running the grant answers 503 `station-preparing`
  with `Retry-After`, and nothing is created; a delivery that meets it is retried with the same
  sealed blob. A node that refuses the station answers 409 with its code: `station-not-hosted`,
  `station-key-changed`, `station-uid-shared` or `stk-unavailable`.
- **The hub sees a minted token for an instant**, between minting and sealing it. It stores only the
  sealed envelope.
- **Every forge-api route needs the hub's Forgejo admin configuration.** Without `FORGE_URL` and
  `FORGE_ADMIN_TOKEN` on the hub, every `forge-api` route answers 503, even for a GitHub-only
  (`app` or `supplied`) grant, and the reconcile sweep does not run.
- **agentpod cannot revoke a supplied token at its provider.** `revoke` removes it from the station;
  revoke it at the provider yourself, then run `fleet stations forge-api confirm-revoked`.
- **A client that ignores proxy settings bypasses the broker.** It sends a placeholder and gets a
  plausible 401; detection is by test, per harness, not by prevention. `verify` runs stk's probe
  through the station's own instance (curl, python3, node and a Go client against a local stand-in
  at a host that cannot resolve) and reports each as `honoured`, `bypassed`, `refused-ca`,
  `untested` or `failed` in the ack's `bypass.clients`. A `bypassed` client makes the verify
  `ok: false` with a reason starting `bypassed:`. The station's own harness client is `untested`
  unless a safe probe command is configured (none ships), and is never reported `honoured`
  without one. `bypass.paths` says which harness paths the node routed through the broker
  (`spawn`, and `gateway` for hermes/openclaw) and `bypass.wiringBlocked` why a path is not.
  `bypass.brokered` is wiring AND measurement: true only when every path is wired, the probe ran,
  and no client is `bypassed`, `failed` or `refused-ca`. `bypass.measured` is `complete` only when
  every client row (including the harness's own) is `honoured`, else `partial`; an untested client
  is never evidence. The probe takes up to 45 s, is skipped when stk's own verify already failed,
  and a clean result is reused for 60 s per station (never a failure; any deliver, policy, revoke
  or wiring change drops it). Harness probes are refused on a root node. A station with no wired path at all is
  `ok: false` with `not-wired:`. The hub reads all of this as described under **Status**:
  `bypassed` fails the grant (a verified one too), `not-wired` is inconclusive (state kept),
  `brokered: false` keeps or puts the grant at `delivered` with a `coverage-incomplete` note, and
  `brokered: true` with `measured: partial` verifies with a `coverage: partial` note. A rotation
  still finishes on a station that cannot show brokered traffic: once the node acknowledged the
  new token and its identity matched, the old token is revoked; the grant stays `delivered` with
  the coverage note. The reconcile sweep does not re-verify a not-brokered grant within 30 minutes;
  `fleet stations forge-api verify` always runs.
- **Body-level rules cover JSON REST only.** A rule that would have to read a GraphQL or non-JSON
  body cannot be enforced.
- **Forgejo's token listing and repository confinement are to be verified live** against the real
  forge before relying on them for orphan cleanup and repository restriction.

## Staffing

Putting an agent in a station, or taking it out:

```sh
fleet staff options
fleet staff assign   --station <stationId> --file <path>|-
fleet staff unassign --station <stationId>
```

## Cleaning up

Removing a station from the registry is not the same as deleting anything on the machine.
For reclaiming actual disk, see the cleanup panel in
[What you can do to a station](/use/panels/) — which plans first, shows you the plan, and
only then applies it.

## Next

- [What you can do to a station](/use/panels/)
- [Talking to an agent in a room](/use/rooms/)
- [Managed skills](/use/skills/)
- [Attaching an editor](/use/acp/)
