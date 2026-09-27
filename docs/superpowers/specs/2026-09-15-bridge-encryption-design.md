# Encrypted appservice: letting agents into encrypted rooms

> **Amended 2026-09-15, after deployment.** The device acquisition described
> below — a fixed `AGENTPOD` device asserted through MSC4190 — was replaced.
> Enabling MSC4190 switches appservice login off for the whole appservice,
> which broke station provisioning and every per-agent credential mint and
> rotation ([#435](https://github.com/SuperJackfruitLabs/agentpod/issues/435)).
> The bridge now takes its device from an appservice login and keeps the id
> beside the store. Everything else here — the machine, the transport, the
> per-agent stores, cross-signing — stands. See `OPERATING.md` §7b-ter.


**Status:** spec. Nothing implemented.

supermessage creates every room unencrypted, and the reason is here rather
than there: **the agent bridge cannot read an encrypted room.** Encrypting
rooms today would make agents deaf in exactly the rooms the product exists to
put them in. Fixing that is this document; `supermessage#68` is the other
half and is blocked on it.

## 1. What is true today

`agentpod-hub.service` is Bun + Hono, serving `/_matrix/app/v1` by hand. It
holds **no Matrix library at all** — it speaks the client-server API over raw
HTTP and logs in as agents with the appservice token. There is no crypto
anywhere in it: no olm, no vodozemac, no matrix-bot-sdk.

```
/etc/tuwunel/appservices/agentpod.yaml
  id: ai-agents             →  @agent_.*
  url: http://127.0.0.1:3001
  receive_ephemeral: true
```

Nineteen agent definitions live in `packages/agents/src/library`.

## 2. The homeserver already supports this

**This was checked wrongly once and is worth stating precisely.** Reading
`unstable_features` from `/_matrix/client/versions` shows no MSC3202, MSC2409,
MSC4190 or MSC3983 — and that is not the answer. tuwunel does not advertise
them there. The release notes are explicit, and `id.agentpod.dev` runs 1.8.3:

| Release | Adds |
|---|---|
| v1.8.0 | appservice device management (MSC4190) |
| v1.8.2 | appservice transaction extensions — device-list changes, one-time-key counts, unused fallback key types (MSC3202) |

Both landed after real bugs: tuwunel#401 (hookshot crashing on a missing
`device_id` from `/whoami`) and tuwunel#327 (mautrix bridges failing to upload
keys via MSC4190). tuwunel now asserts the appservice-supplied `device_id`.

So the appservice-native path is open, and the alternative — nineteen
full client sessions with nineteen sync loops — is not needed.

## 3. The shape of the work

`matrix-bot-sdk` implements encrypted appservices against exactly these MSCs.

**Registration** gains one line:

```yaml
de.sorunome.msc2409.push_ephemeral: true
```

**The appservice** gains a crypto storage provider:

```ts
storage:       new SimpleFsStorageProvider(...),
cryptoStorage: new RustSdkAppserviceCryptoStorageProvider(...),
intentOptions: { encryption: true },
```

Per-agent crypto is handled through intents. The crypto itself is
`@matrix-org/matrix-sdk-crypto-nodejs`, the same Rust state machine Element
uses.

The open question is **how much of the hand-rolled `/_matrix/app/v1` handling
this replaces.** Encryption and transaction handling are coupled — to-device
messages and device-list changes arrive *in* the transaction — so the crypto
cannot be bolted on beside the existing routes without the SDK also seeing
those transactions. Deciding that is the first design task and is not settled
here.

## 4. What the spike established

Run on the target host, x86_64, against Bun 1.2.8 and Node 18.19.1.

**The crypto works, under both runtimes.** Real device keys, real requests:

```
curve25519: +eG90G3np3ZG0zieliMy…
ed25519:    zt2P6tn99o84j1Smmv25…
request types: KeysUploadRequest, KeysQueryRequest
```

The N-API binding loads under Bun. The worry that it would not — and that the
hub would have to move to Node — was unfounded.

**But shutdown differs, and the production path is the bad one.** systemd
stops the hub with SIGTERM:

| Runtime | SIGTERM exit code |
|---|---|
| Node | `0 0 0` |
| Bun | `134 134 134` |

Three runs each, consistent. Bun aborts with a core dump; Node exits cleanly.
On natural exit *both* abort, in napi-rs's tokio runtime teardown:

```
panicked at napi-2.16.17/src/tokio_runtime.rs:114
called `Option::unwrap()` on a `None` value
```

The work completes first — the script prints its result, *then* the process
aborts — so this is teardown rather than operation. It is nonetheless not
cosmetic on Bun: every `systemctl stop` or `restart` would record a failed
unit and drop a core dump, which buries real failures in noise.

Three ways out, and this is the second design decision:

1. Run the appservice under **Node** instead of Bun — the spike says it exits
   cleanly, and it is the runtime the library is built and tested for.
2. Split crypto into a small **Node sidecar**, leaving the hub on Bun.
3. Stay on Bun and accept `exit 134` on every stop, with
   `SuccessExitStatus=134` in the unit to stop systemd calling it a failure.
   This hides a real abort, and would hide the next one too.

(1) is the honest default. (3) is the one to argue against.

## 5. Deployment details the spike surfaced

- **Bun blocks the postinstall.** The native binary arrives via
  `node download-lib.js`, which Bun refuses until trusted. A fresh deploy
  installs a package that cannot load. Needs `trustedDependencies` in
  `package.json` or `bun pm trust`.
- **That postinstall shells out to `node`**, which happens to exist on the
  host. Relying on it by accident is worth replacing with something pinned.
- **The crypto store must be backed up** alongside `appservice.json`. Losing
  it loses every agent's keys, and with them every encrypted room they are in.
  The existing nightly backup covers tuwunel's database and not this.
- `intentOptions.encryption = true` enables encryption for **all** appservice
  users including `sender_localpart: ai-bridge`, not only `@agent_*`.

## 6. What this does not decide

- Whether supermessage should then encrypt by default, and for which rooms.
  That is `supermessage#68`.
- Whether existing plaintext rooms are migrated. They cannot be: Matrix has no
  un-encrypt, and enabling encryption on an existing room is irreversible.
- **Whether this is worth doing now.** `allow_federation = false` on this
  homeserver, and the operator and its only human user are the same person —
  so today E2EE defends against an attacker who has already taken the host,
  and that attacker also has the agents' crypto stores. The reasons to do it
  anyway are parity with what a Matrix client is expected to be, and hosting
  anyone else later. Both are real. Neither is urgent, and
  `supermessage#60` (block and report) blocks a production release on both
  stores today while this does not.
