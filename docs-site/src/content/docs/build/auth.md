---
title: Authentication
description: One issuer, offline verification, and the rules the authorize endpoint enforces.
---

The hub is **the issuer**. Everything else in the suite verifies its tokens offline against a
published key set, rather than calling back to ask whether a token is good.

## Getting a token

```sh
apn fleet login
```

This runs an **authorization code flow with PKCE**:

1. `apn` binds a loopback listener on an ephemeral port, *before* sending you anywhere. Asking
   for a port after the browser is already open is a race the browser wins.
2. It opens your browser to the hub's authorize endpoint. A top-level navigation is the point —
   you can see the hub's own domain in the address bar while you sign in.
3. The hub redirects back with a one-time code.
4. `apn` exchanges the code and its verifier for a token over HTTP from the process itself,
   never in the browser.

There is no client secret, which is exactly why PKCE exists: a CLI on your laptop cannot keep
one. The verifier proves that the client redeeming the code is the client that asked for it.

## Verifying a token

```
GET /api/auth/jwks
```

One URL, carrying every key a token of ours may be signed with. Verify against it offline.

Two properties worth knowing:

- **The algorithm is pinned to `EdDSA`** and is never read from the token's own header.
  Letting a token nominate the algorithm it should be checked with is the classic JWT
  confusion attack.
- **A token names a principal kind** — `human`, `agent` or `service` — and that kind is
  load-bearing. The operator API refuses non-human principals at the door. `/mcp` accepts
  agents, because serving agents is its whole purpose, and serves them a different tool set.

## Redirect URIs

Clients register exact redirect URIs. No wildcards — a registry that accepts one wildcard has
already lost the property that makes exact matching safe.

Native clients like `apn` register the marker `loopback` instead, which permits exactly this
shape:

| Clause | Rule |
|---|---|
| Scheme | `http` only |
| Host | `127.0.0.1` or `[::1]`, exactly |
| Port | Any — this is the whole reason the exception exists |
| Path | Exactly `/callback` |
| Query, fragment, userinfo | None |

**`localhost` is refused.** It is a name, not an address: it resolves through DNS and
`/etc/hosts`, so whoever can answer for it receives your code. This is the clause people skip.

A `redirect_uri` that fails any of these gets a `400` with **no `Location` header**. An
authorize endpoint that redirects somewhere it was not told to is a credential-minting open
redirector.

## Dispatch authority

```
GET /api/fleet/dispatchable
```

Returns the agents the token's holder may dispatch. The answer is read from a `mayDispatch`
claim the hub signed **into the token** — not from a query parameter, not from a header, and
not from anything else the caller sent. There is nothing in the request that can change the
answer.

A missing or non-array claim is read as *permitted nothing*, never as *permitted
everything*. An absent claim means the issuer does not speak that control; reading it as "all"
is the one mistake that cannot be walked back.

An agent's token is refused here regardless of what it may dispatch.

## Next

- [MCP tools](/build/mcp/) — what a token opens
- [The apn command](/use/cli/) — the two credentials, and why they never mix
