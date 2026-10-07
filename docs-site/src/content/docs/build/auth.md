---
title: Authentication
description: Where a token comes from, how to present it, what the hub checks, and what each refusal means.
---

The hub **issues nothing**. Tokens come from the organization plane, the account service at
`https://accounts.superjackfruit.com`, and every product, the hub included, verifies them offline
against the plane's published key set rather than calling back to ask whether a token is good.

A hub tells you which issuer it trusts:

```
GET /public/org-plane
```

```json
{
  "issuer": "https://accounts.superjackfruit.com",
  "url": "https://accounts.superjackfruit.com",
  "audience": "https://hub.agentpod.dev"
}
```

`issuer` is the exact `iss` the hub accepts, `url` is where the plane's endpoints live, and
`audience` is the value a token must carry in `aud` to be spent here. A self-hosted hub answers
with its own configuration; nothing below should be hard-coded except the claim names.

## The issuer

The issuer is the plane's **root URL**, and it publishes standard discovery documents there:

| Document | Path |
|---|---|
| OpenID configuration | `/.well-known/openid-configuration` |
| OAuth authorization server metadata | `/.well-known/oauth-authorization-server` |
| Key set (JWKS) | `/api/auth/jwks` |

Every token is a JWS signed with **`EdDSA`** (Ed25519), with a `kid` that names a key in that set.

## Getting a token

### At a terminal

```sh
fleet login
```

`fleet login` asks the hub which issuer it trusts and runs that plane's **device flow**: it prints
a page and a code, opens the page if it can, and waits while you confirm the code in any browser,
so it works over SSH too. Approval gives this machine a **device credential** for the `apn` client
(the CLI's registered client id). The credential lasts **90 days from its last use**, so a machine
in regular use stays signed in.

Every later command spends the device credential for a fresh access token without opening a
browser. The exchange underneath is:

```
POST /api/token/device        Authorization: Bearer dev_…:<secret>
{ "audience": "https://hub.agentpod.dev" }

→ { "access_token": "…", "token_type": "Bearer", "expires_in": 300 }
```

The plane lists and revokes device credentials on its Devices page; `fleet devices` prints where
that is. The full command surface is in the [fleet reference](/reference/fleet/).

### In a browser

Each first-party web app is a public OAuth client of the plane, signing in with the
**authorization code flow and PKCE (S256)**. The token request names the resource it wants with
`resource=<audience>`, and one token carries one audience, so a client that needs two products
makes two token requests. Endpoints are in the plane's discovery documents.

### On another principal's behalf

A service holding a plane credential (`svc_…`) exchanges it at the plane:

| Exchange | What it returns |
|---|---|
| `POST /api/token/service` | A token for the service itself |
| `POST /api/token/agent` | A token for an agent in the service's own workspace, if its grant has `token:agent` and the agent is not suspended |
| `POST /api/token/assertion` | A two-minute token for a person identified by a linked identity, such as a chat account, if its grant has `token:assert` |

The hub uses `/api/token/agent` itself: an agent holds no long-lived credential, so its node
exchanges the node credential it was enrolled with at the hub, and the hub asks the plane for a
token naming the station's agent. A suspended agent gets no token.

## Presenting a token

Send it as a bearer token:

```
Authorization: Bearer <access token>
```

The operator API also reads `?token=`, because a browser's WebSocket and EventSource cannot set a
header. `/mcp` and `/api/fleet/dispatchable` take the header only: a credential in a URL is a
credential in a log.

Access tokens last **five minutes**. Do not cache one past `exp`; get a fresh one.

## What the hub checks

Every door that takes a token verifies it the same way:

- **The algorithm is `EdDSA`**, fixed by the hub and never read from the token's own header.
  Letting a token nominate the algorithm it should be checked with is the classic JWT confusion
  attack.
- **The signature** against the plane's key set. The hub caches the set for at most ten minutes,
  refetches when it sees an unknown `kid`, and keeps verifying against the last good set while
  the plane is unreachable, so valid tokens keep working through a plane outage.
- **`iss`** equals the configured issuer exactly. Never a prefix match.
- **`aud`**, a string or an array, equals or contains this hub's audience.
- **`exp`**, which is five minutes after `iat`.
- **`ent`** includes `agentpod`: the product is enabled for the token's workspace.

The claims it then reads:

| Claim | Meaning |
|---|---|
| `sub` | The principal, a `prn_` id. |
| `principalKind` | `human`, `agent` or `service`. |
| `org` | The workspace, an `org_` id: the person's active workspace, or the one that owns the agent or service. The hub maps it to its own tenant, creating that tenant the first time it sees a valid token for an enabled workspace. |
| `ent` | The products enabled for that workspace. |
| `scope` | On an agent's or a service's exchange token, its grant scopes. On a person's browser token it is the OAuth scope string and is never read as a grant. |
| `amr` | How an exchange token was obtained: `device`, `exchange`, `service` or `assertion`. Absent on browser tokens; the hub never requires it. |
| `act` | `{ "sub": "prn_…" }` when a service minted the token for another principal. An agent's token names the hub's service here. |
| `mayDispatch` | The agents this principal may dispatch, as bare `prn_` ids. |
| `mayGrantReach` | Whether this principal may grant reach: act on a station's behalf, such as handing its agent a credential, for stations its `mayDispatch` covers. |
| `email`, `email_verified` | For people. |

**The principal kind is load-bearing.** The operator API takes people only. `/mcp` admits agents
and services too, because serving agents is its whole purpose, and offers each a different tool
set.

### Dispatch authority

```
GET /api/fleet/dispatchable
```

Returns the agents the token's holder may dispatch, with their handles. The answer is read from
the token's signed `mayDispatch` claim and from nothing else the caller sent, so there is nothing
in the request that can change it. A missing or non-array claim reads as *permitted nothing*,
never as *permitted everything*. An agent's token is refused here whatever it may dispatch.

## What the errors mean

| Status | Body | Meaning |
|---|---|---|
| `401` | `Unauthorized`, `invalid_token`, or JSON-RPC `-32001` on `/mcp` | No token, or one the hub will not accept: expired, unknown key, wrong issuer, or not issued for this hub. Get a fresh one. |
| `403` | `{ "error": "product_not_enabled", "org": "org_…" }` | The token is valid, but AgentPod is not enabled for that workspace. A person enables it on the plane. |
| `403` | `Forbidden` | A valid token for the wrong kind of principal: the operator API takes people only. Other `403`s say which permission the principal lacks. |
| `410` | `{ "error": "issuer_moved", "issuer": "…" }` | Any `/api/auth/*` route: sign-in, token exchange and the key set left the hub. Use the issuer named. |
| `410` | `{ "error": "managed_by_org_plane", "url": "…" }` | A record the plane now owns, such as the device inventory or user and grant administration. Manage it at `url`. |
| `503` | `{ "error": "org_plane_unavailable", … }` | The hub needed the plane to answer, for a read the token alone could not settle, and could not reach it. |

A token that is valid, fresh and correctly signed still gets a `401` from a product whose audience
it does not name. When a credential works on one product and not another, check `aud` first.

## Self-hosting

A hub also accepts one static API token from its own configuration. It is not an issuer: it acts
as the hub's default user in the bootstrap tenant, carries no claims, and is meant for setup and
automation on a hub you run.

## Next

- [fleet reference](/reference/fleet/): `fleet login`, `whoami`, `logout` and `devices`
- [MCP tools](/build/mcp/): what a token opens
- [apn and fleet](/use/cli/): the two credentials, and why they never mix
- [Dispatch and grants](/use/grants/): who may send an agent a message, and answer for it
