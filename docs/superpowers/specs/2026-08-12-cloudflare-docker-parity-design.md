# Cloudflare ↔ Docker runtime parity — design

**Date:** 2026-08-12
**Status:** approved
**Branch:** `cloudflare-parity`

## The problem, and how it was found

A Cloudflare station verified as working on 2026-08-12 — health, logs, files, chat and
terminal all returned `ok` in `station_audit` — was reported by the operator as "file browser
and terminal not working". Investigation against the live hub found neither was broken:

```
04:44:58  container starts, enrols
04:45:02  station adopted
04:55:5x  chat, fs.write (README.md), term.open — all audited ok
04:59:58  runtime marked ASLEEP  ← exactly 15m after start
05:16:33  GET /api/nodes/<id>/detected → 502
```

Two facts combine into data loss:

1. **`sleepAfter` is fed only by incoming requests.** The worker's own comment records this:
   a node-agent dials *out* and generates no incoming activity, so the container idles out
   ~15 minutes after **start**, no matter how hard the station is being used.
2. **Cloudflare container disk is ephemeral.** Per Cloudflare's docs: *"All disk is ephemeral.
   When a Container instance goes to sleep, the next time it is started, it will have a fresh
   disk as defined by its container image."*

So the README.md written at 04:56:11 was destroyed at 04:59:58. Runtime identity persistence
(#245) makes this worse rather than better: the station returns with the *same* identity and an
empty workspace, so it looks like it survived.

**This is a correctness defect, not a missing feature.** As shipped, the Cloudflare provider
silently destroys user work every 15 minutes.

## Goals

Bring the Cloudflare runtime to parity with Docker on the two dimensions that make a station
usable for real work:

- A workspace survives sleep/wake and any restart.
- A station does not disappear while someone is using it.

Non-goal: making Cloudflare identical to Docker. Ephemeral disk is inherent to the substrate;
we compensate for it rather than pretend otherwise.

## Architecture

Three units, each independently testable.

### 1. Snapshot store — worker + R2

A new R2 bucket binding (`SNAPSHOTS`) and two routes on `cloudflare/worker-v2`:

| Route | Purpose |
|---|---|
| `PUT /sandbox/:id/snapshot` | body is a tar.gz stream → R2 key `snapshots/<id>.tar.gz` |
| `GET /sandbox/:id/snapshot` | returns the archive; 404 when absent |

**Authentication uses a per-sandbox snapshot token, never the worker admin token.** The token is
generated at create time, stored in DO storage beside `envVars`, and passed to the container as
`AGENTPOD_SNAPSHOT_TOKEN`. It is validated against that specific sandbox id.

Two properties this must have, both carrying tests:

- A container cannot create or destroy sandboxes. It holds no admin credential.
- A container cannot read another station's snapshot. Token check is per-id, not global.

`DELETE /sandbox/:id` also deletes the R2 object, so a destroyed runtime leaves no paid storage.

### 2. Container side — entrypoint

- **On start, before enrol:** GET the archive and restore it. Missing archive is normal (first
  boot) and is not an error.
- **On SIGTERM:** tar the snapshot set, PUT it, exit. Cloudflare allows **15 minutes** between
  SIGTERM and SIGKILL (documented), so this is comfortably safe.
- **Every 5 minutes:** the same upload, bounding loss when a container dies *without* a clean
  SIGTERM. One container did exactly that during the 2026-08-11 verification, cause unknown.

**Snapshot set:** `/workspace` and `~/.local/share/opencode`. The second is where OpenCode keeps
its own session state; without it a woken station has the files but no memory of the conversation.

**Known risk — the `exec` problem.** The entrypoint currently ends with
`exec /agentpod-node run`, which replaces the shell, leaving no process to trap SIGTERM. It must
instead run the node-agent as a child and `wait`. That changes the PID-1 semantics the script's
existing comments care about — specifically the zombie whose `comm` still matched the
descriptor's pgrep health check and froze Health at "running" (live-fleet finding 2026-08-09).
This is the riskiest edit in the design and gets a dedicated test.

### 3. Activity renewal — hub + worker

`POST /sandbox/:id/touch` calls `renewActivityTimeout()` (confirmed present on the SDK's
`Container` class).

The hub calls it when it routes a verb to a Cloudflare-backed node, **debounced to at most once
per 60s per runtime** so a chat firehose (measured at 1,051 ACP events for one Hermes prompt)
does not hammer the worker.

**Shutdown ordering is part of the contract:** snapshot → report `asleep` → stop. So `asleep` in
the console always means "state is safe", never "state is in flight".

## Error handling

- **Restore fails** → start anyway with an empty workspace and log loudly. Never a restart loop:
  the first deploy of this worker produced seven live instances in a silent restart loop, and a
  failed restore must not resurrect that failure mode.
- **Snapshot upload fails on SIGTERM** → log and exit. A sleep must never hang on the hub or R2
  being unreachable, for the same reason `notifyHub` already swallows its errors.
- **Touch fails** → log and continue. A renewal failure must never fail the user's verb.

## Testing

| Layer | Test |
|---|---|
| Worker | vitest + fake R2: round-trip, 404 on missing, **sandbox A cannot read B's snapshot**, delete-on-destroy |
| Entrypoint | existing byte-parity test stays green; new Docker test: a file written to `/workspace` survives stop → start |
| Hub | touch is debounced; touch fires only for Cloudflare-backed nodes; a touch failure does not fail the verb |
| Live | create → write a file → force sleep → wake → **file is still there**. The current implementation fails this. |

The live test is the acceptance criterion. Everything else is scaffolding for it.

## Resource tiers — separate, and deliberately smaller

Cloudflare fixes `instance_type` per container class (`standard-1` today), so honouring
small/medium/large needs three classes, three DO bindings, and the tier recorded so a wake lands
on the same class.

**v1 refuses a non-default tier loudly**, matching the honour-or-refuse rule the driver already
applies to `image`. Today the driver refuses a mismatched image and then silently drops
`resourceTier` — the exact inconsistency its own header comment criticises the dead driver for.
Three classes land only if small/large Cloudflare stations are actually wanted.

## What this does not fix

Harness choice remains one image per worker deployment. Deferred: lowest value of the gaps, and
unchanged by anything here.
