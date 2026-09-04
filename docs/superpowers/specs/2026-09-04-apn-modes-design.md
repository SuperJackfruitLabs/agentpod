# `apn` grows a second mode, because it is a node agent and we need a fleet client

**Date:** 2026-09-04
**Product:** AgentPod (`apps/node-agent`), with one hub-side addition
**Status:** Spec. Not built.
**Follows:** `charter → decisions/2026-08-15-granting-reach-is-changing-an-agent.md`
(what a write costs), and agentpod#406 (the door this reuses).

## The question

Every verb `apn` has today acts on **the machine it is running on**, and authenticates as
that machine:

```
Authorization: Bearer <nodeId>:<nodeSecret>
```

read from `<os.UserConfigDir()>/agentpod-node/config.json`, written by `enroll`.

The verbs are `enroll`, `run`, `detect`, `scan`, `acp`, `update`, `version`,
`start`/`stop`/`restart`/`status`/`logs`, and `service`. There is no notion of *ask the hub
about some other node*. On a laptop, in CI, or inside an agent's workspace, `apn` has
nothing to act as — and those are exactly the places a fleet client is wanted.

The binary is `agentpod-node`; its own help calls it "AgentPod fleet node agent". Adding
fleet verbs to it as top-level commands would make one binary mean two things without
saying which.

## The decision: two modes, split on **credential**, not on verbs

| mode | acts as | credential | where it comes from |
|---|---|---|---|
| `apn node …` | this machine | `<nodeId>:<nodeSecret>` | `<UserConfigDir>/agentpod-node/config.json`, written by `enroll` |
| `apn fleet …` | a principal — human **or** agent | a hub JWT | `AGENTPOD_TOKEN`, else `<UserConfigDir>/agentpod/token.json`, written by `apn fleet login` |

**Two modes, not three.** A human and an agent both use `fleet`; only the token differs, and
the hub decides authority from it. A separate `agent` mode would mean the CLI deciding what
its caller *is*, which is the judgement that belongs server-side —
`charter → 2026-08-13-ecosystem-identity` Decision 4 puts authority in the claim, not in the
client.

### The rule that makes this safe

**Neither mode may ever read the other's credential.** In particular:

- A `fleet` command with no token **fails**, naming `apn fleet login`. It must never fall
  back to `nodeId:nodeSecret`. A node secret is a *machine* identity; letting it act on the
  fleet would be the CLI inventing an escalation no hub guard asked for.
- A `node` command never reads the fleet token, and keeps working on a host with none.
- The two live in **different directories** — `agentpod-node/` and `agentpod/` — so neither
  can be reached by a path mistake, and an operator can delete one without disturbing the
  other.

This is the whole security argument for shipping fleet verbs in the binary that is installed
on every station: the verbs are present and **useless without a token the node does not
have**. Authority remains where it already is — `requireGrantReach`, `requireIssueCredentials`
and the `REACH_BEARING` map in `apps/hub/src/services/grant-reach.ts`.

## Command surface

`apn fleet` mirrors the hub's own API groups rather than inventing a vocabulary:

```
apn fleet login | logout | whoami

apn fleet nodes [ls|show <id>]              GET /api/nodes
apn fleet agents [ls]                        GET /api/fleet/agents
apn fleet stats                              GET /api/fleet/stats
apn fleet activity [--station <id>]          GET /api/activity, /api/stations/:id/activity
apn fleet runtimes [ls|show|create|delete]   /api/runtimes

apn fleet station show <id>
apn fleet station health <id>                capability: health
apn fleet station logs <id> [-f]             capability: logs
apn fleet station ls-files <id> <path>       capability: fs.read
apn fleet station lifecycle <id> <action>    capability: lifecycle
apn fleet station changeset <id> status|diff capability: changeset

  ── reach-bearing; the hub refuses without mayGrantReach ──
apn fleet station write <id> <path>          capability: fs.write
apn fleet station exec <id> -- <cmd…>        capability: terminal
apn fleet station cleanup <id> plan|apply    capability: cleanup
```

The three reach-bearing verbs are **grouped and labelled in `--help`**, matching
`REACH_BEARING`'s own classification. `cleanup plan` is a read and `cleanup apply` is not;
the hub already settles that with an `effect` argument and the CLI passes it through rather
than deciding.

**The CLI adds no authority of its own and performs no client-side permission check.** It
renders the hub's refusal. A client that pre-empts a server decision is a client that will
one day disagree with it.

## `apn fleet login` reuses the door agentpod#406 built

No new credential type and no new issuer. The CLI is an OAuth **public client** doing
authorization-code + PKCE against the endpoints kaambaan already walks through:

1. `apn` starts a loopback listener on an ephemeral port
2. opens the browser to
   `<hub>/api/auth/authorize?client_id=apn&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=…&state=…`
3. the hub reads its own first-party cookie, redirects back with a one-time code
4. `apn` POSTs code + verifier to `/api/auth/token/exchange`
5. the token is written `0600` inside a `0700` directory, as `config.Save` already does

The exchange refuses any request carrying `Origin`; a CLI sends none, so this works unchanged.

### The blocking finding: a hub token opens exactly one hub endpoint

**This was checked against the code rather than assumed, and it changes the shape of the
work.**

`/api/auth/token/exchange` returns a **hub-issued JWT** — `buildTokenPayload`, the control
pair, JWKS-verifiable. Exactly one route in the hub verifies such a token:
`/api/fleet/dispatchable`, built for #406, whose own refusal says so:

> This endpoint takes a hub-issued token in `Authorization: Bearer`. It does not read the
> hub's session cookie, which a browser on another registrable domain would not send anyway.

Every other `/api/*` route goes through `authMiddleware`, which accepts three things and
**none of them is that JWT**: a Better Auth session cookie, the static `API_TOKEN` (which
authenticates as `defaultUserId`), or a Better Auth *session token* passed as a bearer.

So a CLI that logs in through #406's door receives a credential that opens **one endpoint**.
`apn fleet nodes` would 401.

There is also an asymmetry worth naming plainly: the hub publishes a JWKS so that *other
planes* can verify its tokens offline, and does not verify its own. kaambaan can read a hub
token; the hub cannot.

### Three ways out, and the recommendation

**A — teach `authMiddleware` to verify the hub's own JWT (recommended).** A third bearer
form beside the two it already accepts. The verification code exists and can be lifted from
`fleet-dispatchable.ts`, including its care to *pin the algorithm rather than trust the
token header*. One credential then works for every client: browsers by cookie, CLI and
agents and other planes by JWT.

**This is not a free change, and the cost is the point.** Today a hub JWT reaches one
endpoint. Afterwards it reaches the API, which means an **agent-kind** token could reach
routes that have never had to consider one. `requireGrantReach` and `requireIssueCredentials`
already refuse the reach-bearing acts — but only on the routes that call them. So A must ship
**with an audit**: for every route under `authMiddleware`, does it gate on the control pair,
and is it correct for a non-human principal? That audit is the real work; the middleware
change is small.

**B — `apn fleet login` obtains a Better Auth session token instead.** Works today with no
hub change, because `authMiddleware` already accepts one. But it is a second credential type
for the same purpose, it carries no control pair, and it makes the CLI's authority differ in
kind from kaambaan's — two clients of one issuer holding two sorts of token. Cheapest now,
and it entrenches the asymmetry.

**C — use the static `API_TOKEN`.** Rejected. It is a shared secret that authenticates as
`defaultUserId`, so every operator and every agent would act as one principal, and the
control pair would mean nothing. It is also precisely *"give agents long-lived human
tokens"* from the layer reference's Do-not table.

**Recommendation: A, with the route audit treated as the deliverable rather than a
follow-up.** B is available if the CLI is wanted before the audit is affordable, but it
should then be labelled interim in the code, with A named as its end — the pattern
`a-grant-names-an-agent-per-plane` uses for a deliberate interim.

### The registry entry, either way

The client registry is **empty by default and opt-in** — a hub that has not registered `apn`
refuses every authorize, which is correct. Registering it needs a redirect rule a CLI can
satisfy, and a CLI cannot pin a port.

**Loopback only, any port, exact path.** `http://127.0.0.1:<any>/callback` and `[::1]`, never
a hostname, never `localhost` (which can resolve elsewhere), never a wildcard on the path.
This is RFC 8252 §7.3's native-app rule, and it is the *only* widening: #406's property that
**a bad `redirect_uri` renders 400 and sends no `Location`** must survive, because an
authorize endpoint that redirects where it was not told to is a credential-minting open
redirector. The existing test proves it by breaking it; that test must still fail the same
way afterwards.

### Expiry, and no refresh

Hub tokens carry `exp` and there is no refresh token in this suite. `apn fleet` therefore
fails an expired token with *"your session has expired — run `apn fleet login`"*, and never
silently retries. `apn fleet whoami` prints the principal, its kind, and the expiry, so an
operator can tell "not permitted" from "not signed in" — two failures that otherwise look
identical.

## Backwards compatibility

`apn enroll`, `apn update`, `apn run`, `apn scan` and the service verbs **keep working
unchanged** as aliases of their `apn node …` forms. `apn enroll` and `apn update` are named
in the estate's own documents (`2026-08-28-foundry.md`, `2026-08-17-the-estate.md`), and a
runbook that stops working is worse than a CLI with two spellings.

The aliases are not deprecated in this change. Nothing warns, nothing nags.

## Why one binary rather than two

AgentPod#228 is open: macOS node-agent releases are unsigned, and unsigned binaries
re-prompt for permissions on every update. Signing and notarisation is per-artifact, so a
second binary doubles that work before it is done once. One binary, two modes, one release
pipeline.

The honest cost: every station carries the fleet verbs it cannot use. That is a larger
`--help`, not a larger attack surface — an attacker with shell on a station can already
`curl` every one of these endpoints, and the credential rule above means the binary's
presence grants nothing.

## What this does not do

- **No MCP server.** That is a separate surface over the same verbs, and it should be built
  from the same catalogue rather than beside it.
- **No new hub *endpoints*.** Every verb above already exists. But this is **not** a
  client-only change: see the blocking finding above — the hub must learn to accept its own
  token, or the CLI must hold a different one.
- **No client-side authority.** Stated twice because it is the thing most likely to be
  "improved" later.
- **No config migration.** Node config stays exactly where it is.

## Open questions

- **Output format.** A CLI used by agents wants `--json` on everything; a CLI used by humans
  wants tables. Both, with `--json` machine-stable and the table free to change — but the
  stability promise needs stating before the first consumer depends on the table.
- **Whether `apn fleet` should refuse to run as root**, the way it might on a station where
  the node service is root-owned. Probably a warning, not a refusal.
- **Which routes are correct for an agent-kind principal.** Answered in part: today the
  question cannot arise, because a hub JWT reaches only `/api/fleet/dispatchable`, which
  refuses agent-kind tokens outright. Option A makes it arise everywhere at once, which is
  why the audit is the deliverable and not a follow-up.
