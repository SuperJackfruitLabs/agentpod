# Forge API Access — Design

**Date:** 2026-10-17
**Status:** draft for review, not yet implemented
**Issue:** #725
**Scope:** `packages/contract`, `apps/hub`, `apps/node-agent`, `apps/console`, `docs-site`.
Companion design in supertoolkit: `docs/forge-broker-design.md` (the broker half).

## Problem

AgentPod gives each station a Forge identity and SSH key (`grant-push`). That
carries `git push` and `git pull`. It does not carry the forge's issue,
pull-request, comment, review or release APIs, so an agent with a perfectly
good account and repository access still cannot file an issue. Super Chotu hit
exactly this.

The operator must not need to know an agent account's password, recover
credentials by hand, or put a token in agent configuration. The agent must be
able to act through the API without ever holding the token.

## Decisions (made with the operator, 2026-10-17)

1. **supertoolkit (`stk`) is the broker.** Every forge API call an agent makes
   passes through a broker that holds the credential. agentpod does not build a
   second broker.
2. **Git over SSH keeps carrying git operations.** Everything else (issues, PRs,
   reviews, releases, checks) goes through the API or an MCP server.
3. **The design is provider-neutral.** Forgejo and GitHub are the first
   adapters. Gitea and Bitbucket are specified here and built later.
4. **Three credential modes** (below): minted, app, supplied.
5. **Tokens travel sealed to the station's stk key.** The hub relays
   ciphertext it cannot open.
6. **Agents reach forges however their harness allows**: a CLI (`gh`, `tea`),
   an MCP server, or `curl`. One broker policy covers all three, so
   enforcement lives in the broker, not in any one client.
7. **Operators choose presets and may write custom rules.** Rules narrow a
   token and never widen it.
8. **stk runs as its own OS user** on a station. Same-user is a supported but
   labelled-degraded mode.

## Goals, non-goals, anti-goals

**Goals**
- An operator grants repository-restricted forge API access to a station, for
  any supported provider, without handling a password.
- The agent calls the API through whichever client it has. It never holds,
  reads or receives the token.
- Grants have a visible, honest lifecycle: authorised, provisioned, delivered,
  verified. Rotation and revocation are first-class.
- Reassigning a station never exposes the previous occupant's access.

**Non-goals**
- Building a general secrets manager. This is forge access only.
- Replacing the SSH grant. SSH and API stay separate, explicit grants.
- Brokering non-HTTP protocols.
- Gitea and Bitbucket adapters in the first build.

**Anti-goals** (a failure even if it technically works)
- A token in model context, a transcript, harness config, a log, the console, or
  hub storage at rest.
- An API grant created as a side effect of an SSH grant, or vice versa.
- A claim of isolation the deployment does not provide.
- An agent granting itself authority.

## Credential modes

The grant carries a mode. The mode decides how the token is made and kept
fresh. The agent sees no difference.

| Mode | Identity | Token source | Lifetime | Used by |
|---|---|---|---|---|
| **minted** | An existing agent account | The hub mints it with its admin token, limited to listed repositories | Long-lived | Forgejo, Gitea |
| **app** | A bot (GitHub App installation) | stk holds the App key, signs a JWT and exchanges it for an installation token | About an hour, self-expiring | GitHub |
| **supplied** | A machine account the operator created by hand | The operator supplies it | Long-lived | GitHub PAT, Bitbucket, anything else |

Lifecycle meaning by mode:

| State | minted | app | supplied |
|---|---|---|---|
| authorised | operator approves a grant | same | same |
| provisioned | hub minted a token | App key and installation registered | operator created the token |
| delivered | sealed token reached the station's stk | sealed App key reached stk | sealed token reached stk |
| verified | stk made a real read call as the right account | same, as the bot | same |

## The provider adapter

A provider adapter is a small hub-side module plus a service definition in stk.
Hub-side it implements:

```ts
interface ForgeProvider {
  kind: "forgejo" | "gitea" | "github" | "bitbucket";
  modes: ("minted" | "app" | "supplied")[];
  // minted only
  mint?(account: string, spec: TokenSpec): Promise<{ id: string; name: string; secret: string }>;
  revoke?(account: string, handle: { id?: string; name: string }): Promise<void>;
  // all modes: what a read-only whoami call must return for "verified"
  expectedIdentity(grant: Grant): { login: string };
  // scopes a preset requires, in the provider's own vocabulary
  scopesFor(preset: Preset): string[];
}
```

A `secret` returned by `mint` exists in hub memory for one call and is sealed
immediately (see Delivery). It is never logged, stored or returned.

**Forgejo (first adapter).**
- `mintAgentToken` and `revokeAgentToken` already exist in
  `apps/hub/src/services/forge.ts` (unit-tested, no production caller). Reuse
  them. Required changes: scopes come from the preset (today hardcoded
  `write:repository`), `repositories` is mandatory (omitted means every
  repository the account can reach), and the token name carries a generation
  (`agentpod-<grantId>-g<n>`, the grant id making it unique) because names are unique per user. Generation `n` only ever increases for a (station, provider, instance), including across a revoke and re-grant, so a leftover token can never collide with a new name.
- Mint calls `POST /api/v1/admin/users/{u}/tokens`. The secret is in `sha1`.
- Revocation is by token name (`DELETE …/tokens/{name}`); 404 counts as success.
- Verified against Forgejo 16.0.5, the deployed version.

**GitHub (first adapter).**
- *app mode:* the operator registers a GitHub App and installs it on the
  organisation or selected repositories. The hub stores only non-secret
  identifiers (app id, installation id). The App private key is sealed to stk,
  which already implements the sign-and-exchange operation as `github-app`.
  Repository limits come from the installation plus the repositories listed in
  the token request.
- *supplied mode:* a fine-grained PAT created by hand. GitHub offers no API to
  mint one for another user, so agentpod tracks state only.

**Gitea (specified, later).** Minted mode if the admin token endpoint exists in
the deployed version. **To verify against current Gitea docs before building.**

**Bitbucket (specified, later).** Supplied mode only. Bitbucket's credential
types are changing (app passwords are being replaced by API tokens). **Verify
current docs before building.**

Provider API behaviour must be read from current provider docs before each
adapter is built, not from this document.

## Policy: presets and custom rules

A grant has a policy: a list of repositories and a rule set. **A rule** is
`allow` or `deny`, a method, a path pattern, a repository, and an optional body
condition:

```yaml
- allow: POST   /repos/{owner}/{repo}/issues
- allow: POST   /repos/{owner}/{repo}/issues/*/comments
- allow: PATCH  /repos/{owner}/{repo}/issues/*
  when: { body.state: absent }        # edit, but not close or reopen
- deny:  DELETE /**
```

- Evaluation is deny-by-default. A matching `deny` wins over `allow`.
- A **preset** is a named bundle of rules plus the provider scopes it needs:
  `read`, `issues`, `pull-requests`, `maintain`. Operators start from a preset
  and may add or remove rules. The preset name is recorded with the grant.
- **Rules narrow, never widen.** The token's provider-side scopes and repository
  restriction are the hard ceiling. A rule that allows something the token
  cannot do has no effect, and the console says so.
- **Body conditions** require the broker to read small JSON bodies. A rule that
  cannot be checked from the request (an unparseable body, a body over the size
  limit, a GraphQL endpoint) is **refused when the operator writes it**, not
  silently ignored. See the stk design for matching semantics.
- Paths use the provider's API prefix, so one rule set is portable only within a
  provider. Presets exist per provider.

The hub holds the desired policy. It delivers the policy to the station as
non-secret configuration; stk enforces it. Policy changes need no new
credential.

### Presets (my call; paths and scopes to be verified against each provider's
current API description before building)

Presets are written per provider and live in stk's provider knowledge (see the
companion design). The Forgejo and GitHub REST shapes are close, so the
categories line up:

| Preset | Allows (beyond the previous row) | Forgejo token scopes |
|---|---|---|
| `read` | identity endpoint; read-only requests under the granted repositories | `read:repository` |
| `issues` | create and edit issues, comment, edit labels. No delete. Closing an issue is a `PATCH` with `state`, so it is allowed unless the operator adds a body rule forbidding it | `read:repository`, `write:issue` |
| `pull-requests` | create and edit pull requests, post reviews, request reviewers. No merge | `read:repository`, `write:issue`, `write:repository` |
| `maintain` | merge, create releases, create labels | `write:repository`, `write:issue` |

Every preset except `read` counts as a **write preset** for the same-user
acknowledgement. `DELETE` is denied in every preset. `write:repository` also
permits code writes at the provider, so `pull-requests` and above cannot be
made narrower by token scope alone; the broker rules are the only thing keeping
them to pull-request endpoints. Operator rules **extend** a preset, a `deny`
subtracts, and `preset: none` starts from an empty list.

## The stk interface agentpod depends on

stk is part of this plan, not another team's. The commands below are defined in
the companion design; hub and contract work can start against a stub of them.
Every command takes `--json` and exits non-zero on failure. No result contains
a secret.

| Command | Result |
|---|---|
| `stk handover key` | the station's public key (`stk-handover-v1:` prefix) |
| `stk handover open <service>` | `{ "service", "stored": true }` after an atomic write |
| `stk verify <service> [--expect-login L]` | `{ "ok", "login", "reason" }` |
| `stk reload` | `{ "ok", "error" }`; invalid policy keeps the old one |
| `stk doctor --json` | includes `isolation: "separate-user" \| "same-user"` and how it was checked |
| `stk revoke <service> --local` | removes the stored credential and cached token |
| `stk audit --json` | records carrying the `station`, `principal`, `grant` labels |

The node reaches these through the stk CLI as the stk user's helper, or its
control socket; the builder picks, provided results are structured as above.

## Delivery: sealed handover

Each station's stk has a handover public key. The node reports it to the hub.

1. The operator's `fleet` CLI (or the console) fetches the station's public key
   and seals the secret to it (NaCl anonymous box, the `stk-handover-v1`
   format stk already uses). For minted mode the hub does the same, in memory,
   straight after minting.
2. The hub stores nothing secret. It relays the sealed blob in a node frame.
3. The node passes it to `stk handover open` on the station.
4. stk acknowledges. The node reports the acknowledgement; the grant moves to
   `delivered`.
5. The node asks stk to **verify** (a real read call as the expected identity).
   The grant moves to `verified` or `failed`, with a reason that contains no
   secret.

A sealed blob can be re-sent, so a lost delivery is recoverable without
re-minting or re-authorising. (Contrast the Matrix credential flow, which is
single-use and loses the credential if the node fails after redemption.)

The hub keeps the sealed blob only until acknowledged, in a row with a short
expiry, then deletes it. If the hub must retry across a restart, ciphertext at
rest is acceptable because only the station's stk key can open it.

**What the hub still sees.** In minted mode the hub briefly holds the plaintext
token, because Forgejo returns it to whoever mints it. The repository's earlier
principle "the hub never holds the secret" is therefore not achievable for this
mode. The achievable and stated property is: *never stored, never logged, never
returned, sealed within the same call.* Docs and schema comments must say so.

## Station topology and isolation

- **One stk instance per station** (decided 2026-10-18; a node that hosts several
  stations runs several stk instances). Each has its own OS user
  (`stk-<station slug>-<hash>`), state directory, runtime directory, policy file,
  proxy port, proxy key, audit log and systemd unit (`stk install --unit-name`).
  A station's harness is given only its own instance's proxy URL and key, so one
  station's agent cannot use another station's brokered credential, and two
  stations may hold grants for the same forge host. Grants are per station and
  provider. The node creates an instance at its first deliver or status for a
  station (removal is manual, see below); it records name and proxy port in a
  node-owned registry so a restart finds the same instance. Proxy ports come from a configurable range (default
  8900-8999); an exhausted range is a refusal, not a reuse.
- **Isolation is judged on where the agents really run.** Agents that share a uid, or
  run as root, can read each other's `/proc/<pid>/environ`, the harness files and
  the loopback proxy key, and stk's control-socket allowlist is by uid, so a
  per-station stk protects nothing from them. The node starts ACP sessions and
  terminals with plain exec and no uid switch, so agents it spawns run **as the
  node's own uid** (root on any node that has instances) whatever
  `forgeApi.stationUids` says; only a long-lived per-profile unit (Hermes) can run
  as another user. A station is therefore `separate-user` only if its stk
  instance is AND every path its harness has runs as a distinct non-node uid
  (unknown counts as the node's uid), which is never true of a spawn path today.
  Every station reports `same-user` with detail `node-uid` or `shared-uid` and a
  reason naming every cause; a second station whose effective uid overlaps
  another's is refused (`station-uid-shared`) unless the operator sets
  `allowSharedAgentUid`; the first station is never refused. The contract's
  isolation enum stays `separate-user | same-user` (a new word would make replies
  unreadable to the hub). Spawning agents under per-station users is out of scope
  here. Per-station brokers separate **credentials**, not **agents**.
- **Instances are removed by hand.** The node never prunes on its own (it cannot
  tell which stations the hub still owns); `apn forge-api prune --station ID
  [--dry-run] --yes` removes one registered station's whole instance. A deliver is
  refused (`station-not-hosted`) for a key the node does not itself detect.
- **Two policy layers per station.** (a) A *shared base policy*: an
  operator-authored node-level file (default `/etc/agentpod/stk-shared.yaml`)
  of services every station needs. The node copies its entries into each
  station's policy when the instance is created and on every policy write, marks
  the copies (label `grant: shared:<service>`) so it can refresh or remove them,
  and never lets them replace or remove a station's own entries; the hub never
  edits them. The node delivers no credentials for shared services (the hub does
  not send them and the node invents no path); loading them is the operator's,
  per instance. (b) The *station layer*: the hub's forge grants, only in that
  station's instance.
- **Separate-user mode (supported).** Node setup creates a dedicated `stk` OS
  user, a socket reachable only by that user and the agent's user, and a service
  unit. The sealed-store passphrase comes from the service manager's credential
  store, not a file beside the ciphertext. The agent cannot read the store, the
  key, or approve its own actions.
- **Same-user mode (degraded).** For rootless or user-scope installs. stk's
  store and key are readable by the agent, so the guarantee is file permissions
  between same-user processes, which is weak. Allowed for read-only presets. A
  write preset in this mode needs an explicit operator acknowledgement.
- Each grant records `isolation: "separate-user" | "same-user"`. The console, the
  CLI and audit evidence show it. Verification reports it and claims no more.
- Neither mode claims protection from an agent with root on the host.

The node agent's systemd unit defaults to `User=root`, so it can perform the
setup. stk has no provisioning code today; it is added in the stk design.

## Authority and who may do what

- The forge account is derived from the station's occupying principal
  (`principalHandle(station.principalId)`), never accepted from a caller. A
  station with no occupant returns 409.
- Provision, expand permissions, rotate and revoke are **operator actions**.
  They require `requireIssueCredentials` (`mayGrantReach` plus a `mayDispatch`
  covering the occupant) and an admin or equivalent operator check. The
  existing `grant-push` route checks only station ownership; **do not copy
  it.**
- Agents may read their own grant status. **v1 has no agent-initiated request
  route** (my call): an agent that needs access asks an operator through its
  normal channel, and the operator grants. A request route would let an agent
  propose its own repository list and is better designed once the operator
  flow exists.
- The operator check is the existing admin check (`adminMiddleware` /
  `isUserAdmin`), in addition to `requireIssueCredentials`. No new role.
- Team membership is never changed as a side effect.

## Lifecycle and failure handling

States: `authorised → provisioned → delivered → verified`, plus `failed`,
`revoking` and `revoked`. Each transition is audited with actor, time and reason.

- **Mint succeeded, delivery failed:** the provider token exists but the station
  never received it. The grant stays `provisioned` with its token handle
  persisted *before* delivery is attempted, so a reconcile job can retry
  delivery or revoke the orphan. Nothing is left unaccounted for.
- **Retries reconcile:** a grant holds at most one live token generation. A retry
  finds the existing generation and re-delivers; it does not mint a duplicate.
- **Rotation (minted):** mint generation n+1, deliver, verify, then revoke
  generation n. If verification fails the old token stays live and the grant
  reports `rotation failed`.
- **Rotation (app):** the operator supplies a new App key (sealed), then
  verifies. The previous key is removed from stk only after the new one
  verifies. The operator removes the old key on GitHub.
- **Rotation (supplied):** the operator supplies a new sealed token.
- **Revocation:** the provider side goes first (minted: `DELETE` the token;
  app: nothing to revoke, the installation token expires; supplied:
  agentpod **cannot** revoke it at the provider, so the grant shows
  `revocation pending: operator must revoke at the provider`). Then the node
  wipes the stk entry, best effort.
- **Node offline:** provider revocation succeeds regardless and makes a stale
  node copy inert. The wipe is queued and applied on reconnect through
  `connectionManager.onNodeOnline`, which already drives reconciliation for git
  authors.
- **Reassignment (my call):** assigning, moving, evicting and unassigning a
  station **never block** on the forge. In one transaction the occupancy change
  commits and the station's grants move to `revoking`. The node's stk entry is
  wiped immediately (or queued if the node is offline), which cuts the station's
  access at once, since the agent's only route to the token was that stk entry.
  Provider revocation then runs and retries until it succeeds; a forge outage
  leaves an inert, unreachable provider token, not a usable one. A new
  occupant starts with nothing and must be granted afresh.
- **Station deletion and un-adopt (my call):** the grant row references the
  station without cascade. Deletion marks the grants `revoking` and keeps the
  row (with a snapshot of the station id) until the provider token is revoked,
  then the row becomes a `revoked` tombstone.
- **Sealed-blob expiry (my call):** a sealed blob that is not acknowledged
  within 24 hours is deleted. The hub no longer has the plaintext, so a minted
  grant in that state is revoked and re-minted (generation + 1), never re-sealed.
- **Reconcile (my call):** one sweep every 5 minutes plus `onNodeOnline`. It
  retries stuck `provisioned`, `failed` and `revoking` grants, and finds orphans
  by listing the account's tokens whose names start with `agentpod-` and
  comparing them to grant rows. Orphans and repeated failures are written to the
  audit log and surfaced in the operator digest, not paged.
- **Version skew:** a node that does not advertise the `forge.api` capability
  gets a clean error, never a silent no-op. Success requires a positive
  acknowledgement from stk, not the absence of an error.

## Hub

**Table** `station_forge_api_grants`, separate from `station_git_identities`
(that table's primary key is `station_id`, one identity per station, and SSH and
API must stay independent). Added to `TENANT_SCOPED_TABLES`. Migration 0100.

| Column | Notes |
|---|---|
| `id`, `tenant_id`, `station_id` | grant id; many per station |
| `provider`, `instance` | `forgejo` / `github` / …, and the forge's base URL, so one station can hold two instances of a provider. Unique on (`station_id`, `provider`, `instance`) among rows not `revoked`. |
| `mode` | `minted` / `app` / `supplied` |
| `principal_id`, `account`, `expected_login` | occupant at grant time, the provider login the credential acts as, and the login verification must see. For minted grants `account` is derived from the occupant and `expected_login` equals it. For app grants it is the bot slug (`<app>[bot]`); for supplied grants it is the machine-account login the operator declares. Operator-declared values are shown in the console and re-checked at every verify; a mismatch fails the grant. |
| `repositories` | `[{owner,name}]`, required, non-empty |
| `preset`, `rules` | the policy |
| `state`, `state_reason` | no secret in reasons |
| `token_handle`, `generation` | provider token id and name (minted), `null` otherwise |
| `isolation` | `separate-user` / `same-user` |
| `sealed_blob`, `sealed_expires_at` | ciphertext awaiting acknowledgement, else null |
| `created_by`, `created_at`, `delivered_at`, `verified_at`, `revoked_at` | |

**Routes** beside the git-identity ones: `GET|POST|DELETE
/api/stations/:id/forge-api[/:grantId]`, plus `…/rotate`, `…/verify`,
`…/policy`. Audit goes through `recordAudit`; add `provider`, `mode`, `preset`,
`generation` and `username` to `SAFE_PARAM_KEYS` deliberately (today `username`
is silently dropped, and audit rows carry no actor).

**Forge admin token.** The existing `FORGE_ADMIN_TOKEN` is the minting
credential, with its existing blast radius. A least-privilege token scoped to
`write:admin` token management is preferable to reuse; the builder decides and
documents the choice.

**Redaction.** Add a Forgejo/Gitea token shape rule (40 hex, no prefix) to
`redact-content.ts` as defence in depth. It cannot be the primary control,
since `acp_events` stores original text.

## Node

- New verbs in `packages/contract/src/protocol.ts`: `forge.api.deliver`,
  `forge.api.policy`, `forge.api.verify`, `forge.api.revoke`, and a
  `forge.api` capability the node advertises only when stk is installed and
  usable. Frames carry ids, mode, repositories and sealed blobs, never plaintext.
- A handler beside `NewGitIdentityHandler` in `run.go` that drives the local
  stk through its CLI or socket and reports structured results.
- Node setup provisions, per station, the `stk-<station>` user, state, socket
  and unit (separate-user mode), lazily at the first deliver or status for the
  station. Creating an instance needs a Linux node running as root with systemd;
  otherwise deliver and status answer `station-instance-unavailable` and the node
  never falls back to one shared broker. Every verb is routed by the frame's
  `stationId`; `status` returns the public key of that station's own stk, which
  the hub seals to.
- Harness wiring: harnesses are started with the broker's proxy and CA
  environment, or given the broker's MCP server, so CLI, MCP and `curl` all
  traverse stk. Harnesses that systemd starts do not inherit
  `gitidentity.WithSSHCommand`-style environment today and a running harness
  keeps its old environment; the builder must wire a harness-specific path and
  restart on first grant. **Per-harness behaviour toward proxy and CA settings
  is untested and must be established by test.**

## Console and CLI

- `fleet stations forge-api list|grant|verify|rotate|revoke|policy`, beside
  `grant-push`, with `reference.go`, the embedded skill and the docs-site pages
  updated.
- A station-page section, modelled on `McpProxyStatus.svelte`: provider, mode,
  account, repositories, preset, isolation, state, last verification. Never any
  token. (Note: the docs describe a git-identity panel that does not exist; this
  is new UI, not an extension.)
- Mockups of the section and its dialogs come before implementation.

## Verification and acceptance

Maps to the issue's criteria. All live checks run against the real deployment
before #725 closes.

1. **Grant without a password:** an operator provisions a repository-restricted
   Forgejo grant for an existing agent account.
2. **No token in agent context:** a test harness transcript, hub logs, node logs,
   harness config and console responses contain no token. Searched for the real
   token value, not a pattern.
3. **Real read through the connection** as the intended account.
4. **Approved issue creation** by the intended account, read back with title,
   body and author verified (Super Chotu and the approved Supertoolkit
   typed-argument bug; no human or other agent's credential as a fallback, and
   the issue is not filed while building).
5. **Disallowed operation refused by the declared layer:** a request outside the
   rules gets 403 from the broker and an audit entry, and a request inside the
   rules but outside the token's scopes is refused by the provider.
6. **Rotation, revocation, reassignment and delivery-failure recovery** are
   tested, including node offline during revoke.
7. **Leakage check** of logs, config and transcripts.
8. **Docs** explain provisioning, status, verification, rotation, revocation and
   the limits below.
9. **Bypass check:** for each supported harness, a client that ignores proxy
   settings is detected and reported, not left to fail silently. Needed because
   a bypassing client sends a worthless placeholder and gets a plausible 401.

Every guard added gets a revert-proof test: revert the fix and watch the test
go red.

## Limits to state in the docs

- No protection against an agent or user with root on the station.
- Same-user mode is weak by construction.
- The hub sees minted tokens for an instant.
- A supplied token cannot be revoked at the provider by agentpod.
- Clients that ignore proxy settings bypass the broker; detection is by test.
- Body-level rules cover JSON REST only.

## Existing defects found while researching (separate issues, not in scope)

These affect the SSH grant, not this feature. File them separately:

1. Reassigning a station does not revoke the previous occupant's SSH key
   (`agents-admin.ts` never touches `station_git_identities`).
2. `grant-push` performs no reach check; any user owning the station row can
   grant or revoke push.
3. Audit rows drop the `username` parameter and record no actor.
4. Station deletion cascades to `station_git_identities` without revoking the
   key on the forge.

This feature must not repeat them (see Authority, Reassignment, Hub above).

## Build order

1. **stk** (companion design): generic forge service, public seal command, fixed
   listener, method/path/body rules, verify, OS-user setup, JSON output.
   Nothing below works without it.
2. **Contract and hub** for Forgejo: table, service, routes, audit, reconcile.
3. **Node:** handler, setup, harness wiring, per-harness bypass checks.
4. **CLI and docs.**
5. **Live acceptance** with Super Chotu.
6. **GitHub app and supplied adapters.**
7. **Console section** (after mockups).
8. Gitea and Bitbucket adapters, later.

Each step ships as its own PR, and each needs a failing test first.

## Left to the builder

- Hub-side module structure and naming beyond what is listed.
- Rule-matching internals, if the stk design's semantics are honoured.
- The minting admin token's exact scope (document the choice).
- Wording of console copy.
- Whether delivery uses the existing node HTTPS redeem route or a frame (frames
  carry the sealed blob, which is not secret).
- Per-harness wiring mechanics.

## Open items (need the operator or a test, not a guess)

- Whether `gh` must work against GitHub. `gh` uses GraphQL heavily, and
  GraphQL cannot be rule-checked. The default is that `/graphql` is denied, so
  many `gh` commands fail; an operator can opt in to allowing it wholesale.

- Which harness Super Chotu runs, to prioritise the bypass check.
- Behaviour of each harness with proxy and CA environment (to be tested).
- Whether the GitHub App is created under the organisation or a separate owner.
- Current Gitea and Bitbucket credential APIs (verify when those adapters are
  scheduled).
