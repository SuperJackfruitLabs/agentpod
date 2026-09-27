# A device credential a human exchanges

**Date:** 2026-09-20.
**Implements:** `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
accepted 2026-09-20, option C.
**Touches:** agentpod (hub, fleet CLI, console), superpipeline (one refusal, shipped first).

## The problem, in one paragraph

A hub token lives five minutes. An agent re-mints by exchanging the long-lived
credential it already holds; a browser re-mints silently from its session
cookie. A human at a terminal holds neither, so the only way to get a new token
is the whole interactive browser flow — every five minutes. In one session on
2026-09-20 that cost four sign-ins, one board created with eleven seconds of
validity left, and one verification abandoned mid-flight.

The fix is not a new mechanism. It is the mechanism agents already use, applied
to the principal kind that was missed: **`login` writes a long-lived credential
bound to this device, and every command exchanges it for a five-minute token.**

## What is being built

### 1. The credential

`dev_<32 hex>` and a 43-character base64url secret, presented together as
`Authorization: Bearer <deviceId>:<secret>` — the same scheme
`POST /api/nodes/:nodeId/stations/:stationId/token` already uses for
`<nodeId>:<nodeSecret>`, parsed the same way.

The hub stores **only the SHA-256 of the secret**, as `nodes.secretHash` and
`enrollment_tokens.tokenHash` already do. The raw secret is returned once, at
creation, and never again. A lost secret is a new device, not a recovery.

`dev_` is a new prefix and is registered in
`fixtures/ecosystem-identity/id_grammar.json` in the same change, with its
accept and reject lists, because a prefix that no corpus pins is one a peer can
disagree about — which is the drift that corpus exists to catch.

**Stored in a 0600 file beside the token**, at
`~/.config/agentpod/device.json`. Deliberately not the OS keychain in this cut:
three platform backends is a project of its own, and the file matches where the
node's own credential already lives. A keypair binding is strictly better and
is left open by the accepted record; nothing here forecloses it.

### 2. The table

```
device_credentials
  id           text pk           dev_…
  user_id      text not null     → user.id, cascade
  tenant_id    text not null     → tenants.id, restrict
  name         text not null     the hostname, for a list a human reads
  secret_hash  text not null     sha256(secret)
  created_at   timestamptz not null default now()
  last_used_at timestamptz
  expires_at   timestamptz not null
  revoked_at   timestamptz
```

**No `principal_id`.** The principal is resolved at mint time from `user_id`,
through `buildTokenPayload`, which already refuses to mint for a suspended
principal. Storing the principal here would freeze a decision the hub re-makes
on every exchange, and a suspended principal whose device credential still
named it would be exactly the wrong thing to freeze.

`user_id` cascades and `tenant_id` restricts, matching `nodes`.

### 3. Lifetime — 90 days, sliding

A successful exchange sets `expires_at = now + 90 days` and `last_used_at =
now`. Sustained work never sees a browser. A machine that stops being used
stops holding a key, with nobody having to remember it.

**The secret is not rotated on renewal.** Rotation means the CLI must durably
write a new secret inside the same round trip, and a crash between the hub's
write and the file's write locks the machine out. That is a real improvement and
a separate change; extending the window achieves what the record asked for.

### 4. The endpoints

| route | credential | does |
|---|---|---|
| `POST /api/auth/devices` | a hub token or session | create; returns the secret **once** |
| `POST /api/auth/devices/token` | `dev_…:secret` | exchange for a 5-minute token; slides expiry |
| `GET /api/auth/devices` | a hub token or session | list this user's devices |
| `DELETE /api/auth/devices/:id` | a hub token or session | revoke |

Exchange refuses, fail-closed and distinctly, on: an unparseable credential, an
unknown id, a hash mismatch, `revoked_at` set, `expires_at` passed. A revoked
and an unknown device are **refused identically** — telling them apart lets a
holder of one id probe for others, the same reasoning `station-token.ts` gives
for collapsing 403 and 404.

**Claims come from `buildTokenPayload` and nowhere else.** Hand-assembling a
payload at a new mint site is how a caller ends up carrying authority its grant
does not give.

### 5. A device token may not become a browser session

The minted token carries **`amr: ["device"]`** — OIDC's authentication-methods
reference, which is exactly the question being answered: *how* did this subject
authenticate. Not `act`: RFC 8693's actor claim means a service spoke for
someone, and here the human's own device presented the human's own credential.
Borrowing `act` would have worked without touching superpipeline, and would have
left the next reader with a claim that says something false.

superpipeline refuses to mint its thirty-day session cookie from a token whose
`amr` contains `device` — the same refusal `signInFromHubToken` already makes on
`act`. The device token still authenticates ordinary API calls; it simply cannot
grow into a long-lived session in another plane, which is what keeps this
concession as narrow as the record claims.

**Ordering, and it is not optional.** superpipeline's refusal ships FIRST. It is a
no-op until device tokens exist, and shipping it second leaves a window in which
a device credential can be turned into a thirty-day cookie. This is the same
ordering error the suite sign-in plan made in the opposite direction on
2026-09-20, caught only by checking production; it is written down here so it is
not rediscovered.

### 6. The CLI

`fleet login` gains one step: after the PKCE exchange, it calls
`POST /api/auth/devices` with the token it just obtained and writes the result.
The browser trip is unchanged and still happens exactly once.

Every other command resolves its credential in this order, which is
`fleetcred.Load` extended rather than replaced:

1. `$AGENTPOD_TOKEN` — unchanged, for CI and agent harnesses.
2. A cached token in `token.json` that has not expired.
3. **The device credential, exchanged.** The new step, and the one that removes
   the browser from the loop. The fresh token is cached.
4. Otherwise `ErrNoCredential`, whose message says `fleet login` — unchanged.

`fleet devices` lists; `fleet devices revoke <id>` revokes. `fleet logout`
revokes this device before deleting the files, so signing out stops being a
local-only act that leaves a live credential in the hub's table.

**The node credential is still never read.** That rule is the reason the two
binaries are separate and nothing here touches it.

### 7. The console

`Settings → Devices`: each device's name, when it was last used, when it
expires, and a revoke button. The list is the same `GET /api/auth/devices`.

This is a real task in the plan, not an afterthought. On 2026-09-20 a change
that worked end to end on the server shipped with no way to reach it from the
product, because the spec described a callback and never asked how a person
would start one. The record's requirement — that a device be "a thing an
operator can see and name in a list" — is not met by a list only a CLI can
print, for the person whose laptop was stolen and who is not at that laptop.

## What this costs, restated from the record

**A second long-lived secret exists**, which is what `an-agent-is-a-principal`
§4 refused for agents. The honest answer is that the human path has no other
candidate, and a credential scoped and revocable per device is the narrowest
form of the concession.

**A stolen device credential is worse than a stolen token**, bounded by what the
exchange checks at exchange time rather than by five minutes. Mitigated by: the
90-day sliding window, revocation from two surfaces, and the refusal to let one
become a session in another plane. Not eliminated.

## Out of scope

- Secret rotation on renewal (see §3).
- Keypair or OS-keychain binding (left open by the record).
- `service` principals, which the record also left open.
- Any change to the agent or browser paths. Both keep working exactly as they do.
