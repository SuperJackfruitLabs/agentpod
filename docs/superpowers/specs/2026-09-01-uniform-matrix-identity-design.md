# Uniform Matrix identity

**Goal:** a station's Matrix address derives from its principal's handle, whatever
mode it runs in. `matrix_identity_mode` decides **who holds the credential** — the
appservice, or the harness itself — and no longer what the address is.

**Prompted by:** the organization-plane deploy on 2026-08-31. The room migration
re-addressed every station to `@agent_<handle>`, but a harness-mode station
authenticates to Matrix as its own account, recorded in `stations.matrix_id`. The
migration removed that account from its own room for all 14 harness stations, and
they went mute until each was restored by hand. The migration was not wrong about
where rooms should end up; it was wrong that the hub could move them there alone.

**Charter:** `decisions/2026-08-30-an-agent-is-a-principal.md` (an address derives
from a handle) and `decisions/2026-08-15-granting-reach-is-changing-an-agent.md`
(issuing an agent its own credential is granting reach, and a human authorises it).
This design changes neither. It makes the first true for harness stations, and it
is built around the second rather than through it.

---

## 1. What "uniform" means, in the data

Two columns already hold a station's Matrix identity, and `db/schema/stations.ts`
says why they are distinct:

- `bridge_matrix_id` — what the appservice minted. *"Nobody on the host can report
  this one, so nothing on the host can erase it."*
- `matrix_id` — what the harness reports and the node agent owns.

For a bridge-mode station only the first matters. For a harness-mode station today
they disagree: the appservice minted `@agent_writer-quill` while the harness runs
as `@agent_guild_hermes-writer-quill`.

**Uniform means they converge.** The account `@agent_<handle>` is minted once, by
the appservice, exactly as now. Mode decides only who holds its credential.

That yields a checkable invariant, with no new column:

| state | meaning |
|---|---|
| `matrix_id IS NULL` | bridge mode — the appservice speaks for it |
| `matrix_id = bridge_matrix_id` | harness mode, converged |
| `matrix_id <> bridge_matrix_id` | harness mode, mid-move or on a retired identity |

Verified against infra on 2026-09-01: 18 bridge stations, every one with
`matrix_id` null; 14 harness stations, every one with it set; all 32 carrying a
`bridge_matrix_id`. The table describes the fleet rather than proposing a scheme
for it.

The third row is the fleet's condition today, for all 14 harness stations. The
invariant is therefore not only a design goal but the progress query — the one that
was missing on 2026-08-31, when nothing could answer "how far has this got".

### Two consequences

**One account, two possible holders.** The appservice can masquerade as any
`@agent_.*` user, so handing a harness its own token means one account with two
credentials. This is not new risk — the appservice could always act as it — but it
makes the existing "never both" guard load-bearing: `inbound.ts` returns early for
harness mode precisely so two things do not answer on one address. That guard needs
a test naming this reason, so it is not later removed as redundant.

**Handle quality stops being cosmetic.** `9247e5a88cfa-c52ddf65` exists because two
nodes shared a station key and the seed qualified the second. Under uniformity that
handle is a real account a harness logs into, not merely a bridge alias.

---

## 2. The pull, and what authorises it

A new endpoint, modelled on `routes/station-token.ts` and following it exactly:

    POST /api/nodes/:nodeId/stations/:stationId/matrix-credential

The node presents `<nodeId>:<nodeSecret>`, parsed and verified with the same
`verifyNodeCredential`. Every refusal is distinct and fails closed, for the reason
that file already gives: a credential issued for the wrong subject looks exactly
like success.

**The gap the station-token pattern does not have.** Issuing an agent its own
credential is granting reach, gated on `mayGrantReach` — a *human's* grant, checked
when a human calls today's `POST /stations/:id/matrix/credentials`. A node pulling
on its own initiative holds no such grant. A self-service pull would let any node
mint Matrix credentials for its own stations at will, bypassing the charter decision
by mechanism rather than repealing it by decision.

So authorisation and delivery are two halves of one act:

- **The operator authorises**, per station, in the console. `requireIssueCredentials`
  runs there, unchanged — same gate, same 403, same audit line.
- That records a **single-use, short-lived authorisation** for that station,
  following `mintEnrollmentToken`'s existing shape (TTL, redeemed once) rather than
  a nullable marker column, because an authorisation without expiry never goes stale.
- **The node redeems it once** and receives `{ userId, accessToken, deviceId }` —
  the `IssuedCredentials` type that already exists.

A node can only ever redeem what a human already approved. A compromised node gains
nothing it was not already granted.

**Two rules.** The hub never logs the token — today's endpoint audits the device and
deliberately not the credential, and this one copies that. And redemption is
genuinely single-use: a replay gets a distinct refusal, not a second working token
for the same account.

---

## 3. The writers, and the lie they can tell

Six harnesses hold profiles: `hermes`, `openclaw`, `opencode`, `pi`, `codex`,
`claudecode`. All six get adapters in this slice.

`MatrixIDFromProfile` reads `auth.json`, then `config.yaml`, then `.env`, taking the
first that yields an mxid. **That precedence is a discovery heuristic and a writer
must not reuse it.**

On the deployed fleet Hermes reads its identity from `.env` as `MATRIX_USER_ID`;
`auth.json` holds only `credential_pool`/`providers`, and `config.yaml` has no matrix
section. A writer that chose `auth.json` because it is first would produce a file the
harness never loads — and the reader would then find the new mxid there first and
report it. The hub would see `matrix_id = bridge_matrix_id`, conclude the station had
converged, and move the room. That is the 2026-08-31 outage reproduced with a green
signal in front of it.

**Each adapter names the authoritative location for its harness** — the file that
harness actually loads at startup — and writes there and only there. Reading stays a
heuristic; writing must not be one.

### Conformance suite

Every adapter passes the same suite:

- **Round trip.** Write a credential, read it back with the *existing* reader, get
  the value written.
- **Refusal.** An unrecognised profile shape returns an error and creates no file.
- **Adjacent config survives.** Hermes's `.env` carries other keys; `auth.json`
  carries provider credentials. Neither may be lost.
- **Permissions.** The token is written no wider than the harness needs.
- **Idempotence.** Writing the same credential twice leaves the same state.

### On five untested adapters

Only Hermes has live harness-mode stations, so five adapters ship without ever
running against a real agent — the shape that produced writers-with-no-caller in the
previous slice. Two things make that honest rather than hopeful: the conformance
suite is a shared contract every adapter must satisfy, and refusal is the default, so
the worst case for an unrecognised profile is a refusal an operator reads rather than
a silent mis-write. Each is verified against a real agent the first time a station of
that harness moves.

---

## 4. The move, ordered so nothing goes mute

The obvious order — switch the credential, wait for convergence, then move the room —
has a mute window: between the harness restarting as `@agent_<handle>` and the room
moving, the harness is logged in as a user the room does not contain.

The appservice owns the whole `@agent_.*` namespace and can put the new user in the
room while the old one is still there. So it goes in first:

1. **Operator authorises** one station. `requireIssueCredentials` runs.
2. **The appservice joins `@agent_<handle>` to the station's room**, old user still a
   member and still working. *Which room:* `matrix_rooms.station_id` stopped being
   unique when a room began following its principal, so a station may carry more than
   one row. The room to move is the one selected by the rule the rest of the hub
   already uses — oldest `created_at`, tie-broken by `room_id` — and if that choice is
   ever ambiguous the move refuses rather than guessing, exactly as `0062` does. Invite-then-join: these rooms are invite-only, and an
   uninvited join is refused with `403 M_FORBIDDEN ... cannot join a room that is not
   'public'` (agentpod#397).
3. **The node redeems** the authorisation, writes the profile, restarts the harness.
4. **The harness comes up as `@agent_<handle>` — already a member** — and works
   immediately.
5. **The node reports the new mxid** on its next detect; the hub observes
   `matrix_id = bridge_matrix_id`.
6. **Only then** the old user leaves, is recorded in `principal_identities`, and is
   deactivated on the homeserver.

This extends `migrate-agent-mxids`'s own principle — *"Join first. Leaving first
would leave the room with no agent in it"* — across the credential switch rather than
only within the room move.

### Every failure stops somewhere safe

| failure | result |
|---|---|
| authorisation expires unredeemed | nothing happened |
| credential written, harness will not start | no convergence; step 6 never runs; old user still in the room with its credential — **the station keeps working** |
| adapter wrote the wrong file | harness keeps its old identity; no convergence; no room move |
| step 2 fails | nothing has changed yet |

The only irreversible step is 6, and it runs only after the new identity has
demonstrably worked. Before that, every state is one restart away from where it
started.

### What this does to the migration script

Steps 2 and 6 are the two halves `migrate-agent-mxids` already performs, split by the
credential switch. The script is therefore **replaced for harness stations** by this
flow and keeps doing bridge stations unchanged. This also settles the open backlog
item that it must skip harness mode: it skips them because they are moved here.

---

## 5. Old identities

A retired account's messages remain in its room — Matrix keeps history from departed
members — but the account and its credential need not.

Step 6 records the old mxid in `principal_identities` against the same principal, so
a reader of the room's history can still resolve who `@agent_guild_hermes-writer-quill`
was, and then deactivates the account on the homeserver. History stays readable and
attributable; an unused credential on a node stops being a live login.

Note the fleet has exactly **one** `matrix` principal identity today — the operator's.
No harness station's mxid is recorded against its principal, so the plane cannot
currently resolve any of them. This step closes that for every station it moves.

---

## 6. What an operator sees

The trigger is a human act, so it needs a control. This programme has produced five
things defined with no caller — `matrix_rooms.principal_id`, `agents.external_id`,
`service_signing_keys.retiredAt`, `unassignStationAgent`, `setTenantExternalMapping`.
An authorisation endpoint with no button would be the sixth.

On a station's page in the console:

- A station whose `matrix_id <> bridge_matrix_id` shows that it is **running under a
  retired identity**, naming what it is now and what it will become. That is the 14,
  visible for the first time.
- One control, **Move to its own identity**, performing step 1 and surfacing the
  hub's own 403 verbatim when `mayGrantReach` refuses.
- Then **waiting for the node** until convergence. A station stuck there is the
  signal that a harness did not restart — the state that currently produces silence.

The fleet view is the §1 invariant, not a new report: a query over two existing
columns answers "how far has this got" at any moment.

**Observability.** The gate sweep counts non-`sent` outcomes as of 2026-08-31. A
station mid-move must not read as healthy, and `no-room` / `no-speaker` during a move
should be attributable to the move rather than looking like a fault.

---

## 7. How this is proven

Three layers, because the interesting failures live between them.

**Conformance, per adapter.** §3's suite.

**The sequence, against a real homeserver.** The ordering claims in §4 hold only if a
room genuinely contains both identities at step 2 and the harness genuinely sees it at
step 4. Fakes cannot establish this, and on 2026-08-31 three separate defects reached
production behind green fakes: a fake that accepted a bare join (`403 M_FORBIDDEN`
against every real room), and fakes that accepted any user id for `createSession`,
`promptSession` and `answerPermission` (`Station not found.`, then `Session not found
or not active.`). **Every assertion about Matrix membership or session identity is
checked against the real thing, or it does not count.**

**The failure cases, deliberately.** Harness refuses to restart; adapter writes the
wrong file; authorisation replayed; authorisation expired. Each lands in the safe
state §4 claims, and each has a test that fails when its guard is removed.

**The exit test.** Move one real Hermes station, **with no SQL and no hand-run curl at
any point**, and watch it answer in its room afterwards. That is the only claim that
matters, and it is what this design exists to make true.

---

## Out of scope

- **Bridge-mode stations.** They already satisfy the invariant; nothing changes.
- **Session attribution.** `acp_sessions.user_id` names the station's owner, so a
  transcript no longer records which principal asked. Real, tracked in the estate
  backlog, and needs its own column — not this slice.
- **Cross-org handle collisions.** `principals` is unique on `(org_id, handle)` while
  a Matrix address is `@agent_<handle>:domain` with no org component. Unreachable with
  one organization; reachable the day there are two. Tracked separately.
- **Retiring `matrix_identity_mode`.** After this slice it means only who holds the
  credential. Whether that distinction should survive at all is a later question.
