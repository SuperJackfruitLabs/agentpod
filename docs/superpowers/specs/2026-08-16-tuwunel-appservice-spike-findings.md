# Can an Apache-licensed homeserver carry the bridge? — spike findings

**Date:** 2026-08-16
**Question:** the conversable-fleet plan rests on Application Service features
Synapse implements completely. Does **tuwunel** (Apache-2.0) implement them too?
**Answer: yes — all of them, verified against a running server.**
**Status:** spike complete, environment torn down. Nothing here is kept code.

## Why this was asked

The operator requires an Apache- or MIT-licensed homeserver. Synapse is AGPLv3
since Element's 2023 relicense; Dendrite went with it *and* is in maintenance
mode. That leaves the Conduit lineage — tuwunel, continuwuity, Conduit — all
Apache-2.0.

Switching a homeserver while writing your first appservice is two unknowns at
once. This spike removes one of them **before** the plan is committed, because
if masquerading did not work, no Apache-licensed server could carry the design
and that is worth knowing on day zero rather than at task nine.

## Method

`ghcr.io/matrix-construct/tuwunel:latest` (**1.8.3**, RocksDB schema v17) in
Docker, with a registration file in `appservice_dir` and a throwaway receiver on
:29328 recording every push. Eleven assertions, each one a thing the plan does.

The registration used **the ordinary Synapse YAML shape** — `namespaces.users`,
`namespaces.aliases` — rather than the TOML-flavoured example in tuwunel's docs.
It loaded and worked, which matters: our existing `agents.yaml` transfers nearly
unchanged.

## Results

| # | Claim the plan makes | Result |
|---|---|---|
| 1 | a normal user can register (control) | **PASS** `@rakesh:spike.local` |
| 2 | exclusive namespace refuses a human taking `@agent_*` | **PASS** `M_EXCLUSIVE`, HTTP 400 |
| 3 | the appservice can register a virtual user | **PASS** `@agent_krishna:spike.local` |
| 4 | the appservice can create a room as that user | **PASS** with an `#agentpod_*` alias |
| 5 | **masquerading: `?user_id=` accepted on send** | **PASS** HTTP 200 |
| 6 | the message's sender really is the virtual user | **PASS** `sender=@agent_krishna:spike.local` |
| 7 | the virtual user can send a typing notice | **PASS** |
| 8 | the homeserver pushes transactions to the appservice | **PASS** 7 transactions, 11 events |
| 9 | a human's message arrives in a transaction | **PASS** |
| 10 | `receive_ephemeral` delivers typing to the appservice | **PASS** 2 ephemeral events |
| 11 | the room-alias query reaches the appservice | **PASS** `GET /_matrix/app/v1/rooms/#agentpod_unknown_station:…`, and the 404 was honoured |

Zero errors or panics in the server log across the run.

**#5 and #6 are the ones that mattered.** tuwunel's documentation never states
that `?user_id=` masquerading is supported — it is alluded to once, in a sentence
about rate limits. The entire bridge is built on that parameter, so it was
tested first and directly rather than inferred from a claim of spec compliance.

**#2 corrected an error in the test, not the server.** The assertion expected
HTTP 403; the spec prescribes **400 with `M_EXCLUSIVE`**, which is exactly what
tuwunel returned. Recorded because a future reader will otherwise re-litigate it.

## What this changes, beyond the licence

**The Postgres migration (#329) becomes unnecessary.** tuwunel is RocksDB —
embedded, concurrent, no separate database process. Every reason #329 existed
(SQLite's single writer, no safe hot backup, a migration that only gets harder)
is answered by not running SQLite. That plan should be closed, not executed.

**Backups change shape**: a data directory, not `pg_dump` and a collation trap.

**There is no migration path from Synapse.** Conduit-family servers migrate
between each other in place; from Synapse you start clean. For this fleet that
is affordable and was accepted deliberately:

- **the addresses survive** — an mxid is localpart + domain, and both are ours to
  recreate, so `@analyst-echo:id.agentpod.dev` comes back as itself;
- **Matrix is not the source of truth here** — `acp_events` is, per
  `charter/decisions` and kaambaan#34's "Matrix carries projections, never truth";
- the bridge recreates every room anyway;
- there is no federation, so nothing remote is lost.

What is genuinely lost: ~19,400 events of history, the room ids, and any media.
The cost only grows with time, which is an argument for now rather than later.

**One casualty worth naming:** the hermes onboarding tooling creates agent
accounts through the *Synapse admin API*, which tuwunel does not implement. That
work converges with the bridge — which registers identities itself — but it is
real work, and it is not in the old plan.

## What was NOT tested, and why

- **E2EE appservices** (MSC3202/MSC4203, which tuwunel advertises). The plan
  explicitly ships unencrypted rooms; supermessage renders a placeholder for
  encrypted ones today.
- **Federation.** Disabled by policy on both the old and new server.
- **Scale.** Eleven events, not eleven thousand. This spike answers *can it*, not
  *how fast*.
- **continuwuity.** Not tested: tuwunel answered yes, and the two migrate between
  each other in place, so the fallback is a data-directory move rather than a
  decision to re-make now.

## Recommendation

**Adopt tuwunel.** Rewrite Phase A of the conversable-fleet plan from "migrate
Synapse to Postgres" to "stand up tuwunel and recreate identities", close #329,
and keep the rest of the design as it stands — every assumption it makes about
the Application Service API held.
