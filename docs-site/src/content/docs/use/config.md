---
title: Declared harness settings
description: Declaring what a harness setting should be, the three policies that govern how it may be reconciled, writing a declaration to a station through plan/inspect/apply, and the states a station can report back.
---

A harness — Hermes, OpenClaw, Claude Code, Codex, OpenCode, Pi — keeps its own
configuration, in its own file, in its own shape. AgentPod does not own that file. What it
can do is let the fleet **declare** what a registered setting should be, write that
declaration to a station through a reviewed operation, and tell you where each station's
actual value stands against what was declared.

## A declaration is not a write

```sh
fleet config set hermes.approvals.mode --value strict
```

**This records a declaration. It does not touch a station.** Nothing on disk changes when
this command returns — the hub remembers that the fleet *wants* `hermes.approvals.mode` to
be `strict`, at whichever level you declared it. Writing a harness's own config file is a
separate, reviewed operation — `plan`, then `apply` — described below in
[Writing a declaration](#writing-a-declaration-plan-inspect-apply).

The gap between declaring and applying is deliberate, not a missing feature. A harness
persists an operator's own decisions into the same file a declaration targets — see
`additive-only` below — so `set` itself should never move a file unasked, and nothing
reconciles on a timer either: a sweep running on a tick would race the harness or silently
undo what an operator just changed through it. A user who treats `set` as something that
changed a machine has been misled by it; treat it as writing a line into a policy document,
not into the harness. Only `apply`, naming the exact plan a human reviewed, writes anything.

```sh
fleet config unset hermes.approvals.mode
```

removes a declaration. Undeclaring a level that has nothing declared on it is a no-op, not
an error.

## Scopes and levels

A declaration targets exactly **one level**: a station, a node, or the whole fleet (both
null). Levels resolve with station the most specific and fleet the least — a station-level
declaration wins over a node-level one, which wins over a fleet-wide one, for the same
setting.

```sh
fleet config set hermes.approvals.mode --value strict                  # fleet-wide
fleet config set hermes.approvals.mode --value strict --node nod_123   # one node
fleet config set hermes.approvals.mode --value strict --station st_abc # one station
```

A setting also carries its own **scope** — `profile`, `project`, or `user` — which says
where it actually lives inside the harness's document, independent of which level you
declared it at.

### Declaring a value that is not a string

A single `--value` is declared as a **string**. The declaration is stored as JSON and the
node refuses a value whose shape its registry does not expect, so the shape has to be right
here rather than at write time. For a list-valued setting — every `additive-only` setting is
one — repeat `--value` once per entry, or use `--json` for the value exactly as JSON:

```sh
# a list, by repeating --value
fleet config set hermes.approvals.command_allowlist --value "git status" --value "ls"

# a ONE-entry list, a number, a boolean — the forms repeating cannot express
fleet config set hermes.approvals.command_allowlist --json '["git status"]'
fleet config set hermes.approvals.timeout --json 900
```

`--value` and `--json` are mutually exclusive, and `set` needs one of them. Declaring a
list-valued setting with a single `--value` stores the string it is, and every later `plan`
for that station is then refused `SHAPE_UNEXPECTED` — so if a plan says a declared value is
not a list of strings, this is why.

### Why a station is not a config scope, except for Hermes

For five of the six harnesses, a station is a *project path*, while the harness's
configuration lives per *user*. Declaring a setting "for this station" would be declaring
it for a document the station doesn't actually own — the user's config file is shared
across every project that user opens, so a station-scoped declaration on, say, Claude Code
or Codex has no document to land in.

Hermes is the exception: there, a station **is** a profile, and a profile is exactly the
document Hermes's settings live in. That is the only harness where declaring a setting at
the station level corresponds to a real, single document.

`--station` is **accepted for any setting**, including one whose registered `scope` is not
`profile`. The declaration is stored; nothing is refused at `set` time. The mismatch
surfaces later, when the declaration is **read back** — every comparison for that station
reports the setting as `out-of-scope`, with a reason naming the scope, instead of
`matches`, `drifted` or `absent`. So a `--station` declaration of a `user`- or
`project`-scoped setting is not an error you are told about when you make it; it is a state
you see the next time you ask where things stand.

## The three policies

Every registered setting carries a `policy`, which says what this system is permitted to do
toward making a station's value match the declaration:

| Policy | Meaning |
|---|---|
| `reconcilable` | The value can be fully reconciled to the declaration — whatever is there can be replaced outright. |
| `additive-only` | The declaration is a floor, never the whole value. Items can be added; nothing already there is ever removed. |
| `report-only` | The value is only ever compared and reported. Nothing here writes it. |

`additive-only` exists because a harness persists an operator's own decisions into the same
file a declaration targets. `hermes.approvals.command_allowlist` is the first example: an
operator can extend that allowlist from Hermes's own UI at any time, and that edit lands in
the same document a fleet-wide declaration points at. Reconciling the list down to exactly
what was declared — the `reconcilable` behaviour — would silently delete a grant the
operator made minutes earlier through a surface this system never watched. A declared
baseline must never be able to erase an operator's own decision; `additive-only` is the
policy that guarantees that, by only ever being allowed to add.

`apply` enforces exactly this at write time, not just at comparison time: a `reconcilable`
write replaces the key outright; an `additive-only` write only appends items that are not
already present, so re-applying the same declaration twice is always safe; and a
`report-only` setting is planned as a no-op and is never sent to a node to write — by
design, not because writing it hasn't shipped yet.

## Seeing what the fleet can declare

```sh
fleet config settings
```

lists every setting any reachable node currently manages — the live registry, read from the
node, never a copy held in the hub. A node that cannot currently be asked contributes
nothing to this list, and is named separately so its absence isn't silent.

This registry currently covers three Hermes settings — `hermes.approvals.timeout`,
`hermes.approvals.mode`, `hermes.approvals.command_allowlist` — plus whatever else is live
on the node you ask. The four settings the existing `apn hermes-live`, `apn hermes-skills`
and `apn openclaw-errors` verbs already manage are **not** folded into this registry yet;
those commands keep working exactly as they do today, unrelated to `fleet config`.

## Seeing where things stand

```sh
fleet config show                     # every declaration in the fleet, as stored
fleet config show --node nod_123      # one node's declarations, as stored
fleet config show --station st_abc    # one station: declared vs observed, compared
fleet config drift                    # every station whose value differs from what's declared
```

**Only `--station` compares anything.** With no flag, and with `--node`, `show` returns the
**declaration rows themselves** — what was declared, at which level, by whom — and no
station is contacted: there is no `observed` value and no state in that answer. That is not
a gap in the output, it is what the question means at those levels: a fleet-wide or
node-wide declaration is one row that may apply to many stations, and comparing it requires
naming which station you mean. `--station` names one, so that form asks its node for the
current values and reports a state per setting. `fleet config drift` is the other compared
form, across every station at once.

Each **comparison** — `show --station` and `drift` — reports, per setting, a **state**:

| State | Meaning |
|---|---|
| `matches` | The observed value agrees with what's declared. |
| `drifted` | Declared and observed disagree. |
| `absent` | Declared, but the key isn't in the document at all. |
| `opted-out` | An operator explicitly opted this station out of the declaration — see [Opting a station out](#opting-a-station-out). |
| `awaiting-restart` | A value was written but the harness hasn't picked it up yet — see [awaiting-restart](#awaiting-restart-written-but-not-yet-in-effect). |
| `unreadable` | The document couldn't be read, or the key is there but holds a shape this release can't read — a nested map (see below). Never reported as `matches` — an unreadable value is not evidence of agreement. |
| `out-of-scope` | A per-station declaration was made for a setting whose registered scope isn't the station's document (see above). |

`fleet config drift` only reports states other than `matches`, plus the list of stations it
could not reach at all — a station it couldn't ask is never silently left out of the total.

That list is narrower than "every station that is down", and deliberately so. It holds the
stations that **had something declared for them** and whose node could not be asked. A
station with **no** declaration resolving to it is never contacted in the first place, so
it appears neither in the observations nor in the unreachable list, however offline it is;
and a station that does not advertise `config.manage` at all is not a candidate for this
command. Read the list as "declarations I could not check", not as a fleet health report —
`fleet nodes` is where you see what is up.

### Nested-map settings read as `unreadable`

This release reads **scalar** and **list** values. A registered setting whose key holds a
nested map is reported `unreadable`, with a reason saying so — not `absent`, and not
`drifted`.

`hermes.approvals.command_allowlist` is a list in every real document, and reads normally:
a block list, an inline list, and an empty list all come back readable, with the list itself
as the observed value. It stays in the registry even on the shape it can't read — the
alternative was to report a key that is plainly in the document as "not in the document at
all", which is a false sentence, or to compare an inline list's raw text and report drift
forever. An honest `unreadable` with a reason is the state that tells you what is actually
true.

### Opting a station out

`opted-out` names an operator's explicit choice, and it outranks the ordinary comparison —
an opted-out setting is reported `opted-out` even when the observed value differs from the
declaration, never `drifted`, because `drifted` would invite the exact `apply` the opt-out
exists to prevent.

The opt-out lives in a **hub-side register** (`harness_config_opt_out`, keyed by the
station's stable key, not its row id, so the choice survives an unadopt and re-adopt) —
**not** as a key inside the harness's own config file. A harness like Hermes rewrites and
migrates its own config document on its own schedule; a key this system invented there
would be a key whose survival this system does not control, so the opt-out is kept
somewhere this system does control instead. Where a harness has its own native opt-out
key in its document (OpenClaw's `plugins.disabled`, for the settings it governs), that path
is separate and not yet wired into this comparison.

`compare()`, adopt-time reconcile, and `plan`/`apply` all honor a row in this register the
moment one exists — there is no path left that writes an opted-out setting silently. `plan`
excludes an opted-out setting from what it asks the node to plan and names it in a `refused`
list alongside whatever it *did* plan (a mixed request — some settings opted out, the rest
not — refuses only the opted-out ones, never the whole plan: `fleet config plan --station ID`
plans every setting currently declared for a station with no way to narrow it, so a
whole-plan refusal would let one opt-out block writing anything else to that station).
`apply` re-checks the register too, independently of `plan` — an operator can opt a station
out *after* a plan was reviewed and before someone applies it, and that window is exactly
where the check matters most. Because one `apply` call writes one journaled plan as a single
atomic operation, a setting opted out after its plan was made refuses the **whole** apply,
naming the setting; nothing in that plan is written, and a fresh plan (which will exclude the
now-opted-out setting) is the remedy. There is no `fleet config` verb or console control that
writes an opt-out row yet, so an opt-out today is set directly against the hub, not through
this CLI.

## Writing a declaration: plan, inspect, apply

```sh
fleet config plan    --station ID                 the edit that would be made, and its digest
fleet config inspect --station ID --operation ID  a plan already made, as it was reviewed
fleet config apply   --station ID --operation ID --plan-digest SHA256
```

`plan` asks the hub to derive the exact edit against the station's current document and
returns a `ConfigPlan`: the before/after diff, which action each setting takes
(`create`/`modify`/`append`/`noop`), whether a restart is needed, and a `planDigest` — a
SHA-256 over everything in the plan except the timestamp and operation id, so two plans of
an unchanged document always digest the same and a plan drawn against a changed document
never does. `inspect` reads back exactly the plan or receipt a station's own node journaled
for that operation — it never re-derives anything. `apply` is the only verb that writes, and
it refuses to run without `--plan-digest`: that digest must be the one `plan` printed for
this operation, so a human reviewed the exact edit being written rather than whatever the
current plan happens to be by the time `apply` runs.

`fleet config plan --station ID` plans **every** setting currently declared for that
station, at whatever level resolves to it — there is no flag to narrow the plan to one
setting. A setting the station is opted out of is left out of that plan and named in
`refused` instead (see [Opting a station out](#opting-a-station-out)) — the rest of the
declared settings still get planned.

A worked example, declaring and then writing `hermes.approvals.mode` for one station:

```sh
$ fleet config set hermes.approvals.mode --value strict --station st_abc

$ fleet config plan --station st_abc
{
  "schemaVersion": 1,
  "operationId": "cfgop_3f9a2c7b1e6d48a09c21",
  "stationKey": "st_abc",
  "entries": [
    {
      "settingId": "hermes.approvals.mode",
      "file": "/home/agentpod/.hermes/profiles/st_abc/config.yaml",
      "keyPath": "approvals.mode",
      "policy": "reconcilable",
      "current": "standard",
      "intended": "strict",
      "action": "modify",
      "restartToTakeEffect": true
    }
  ],
  "beforeSha256": "1b80374ee731c363440504e674caf2d26d72ee818a2482571e6beff6de397d5a",
  "diff": "-  mode: standard\n+  mode: strict\n",
  "diffTruncated": false,
  "noOp": false,
  "restartRequired": true,
  "createdAt": "2026-10-05T09:12:03Z",
  "planDigest": "c68e0c65d2a58aa481e8fdf83422dbb4712a8b97e41fb907bdb3109adc503077"
}

$ fleet config inspect --station st_abc --operation cfgop_3f9a2c7b1e6d48a09c21
{ "plan": { ... as above ... }, "phase": "planned", "updatedAt": "2026-10-05T09:12:03Z", "written": [] }

$ fleet config apply --station st_abc --operation cfgop_3f9a2c7b1e6d48a09c21 \
    --plan-digest c68e0c65d2a58aa481e8fdf83422dbb4712a8b97e41fb907bdb3109adc503077
{ "plan": { ... }, "phase": "applied", "written": [{"settingId": "hermes.approvals.mode", "action": "modify", "wrote": "strict"}],
  "afterSha256": "318e20b3a675cd8701af3cab0b019abbab63ca2e1183b77fa39a7e538ffb50ab", "updatedAt": "2026-10-05T09:12:41Z" }
```

(Operation ids and digests above are illustrative, not literal output.) On the node, the
plan and its receipt are journaled in `.agentpod/config-operations.json` — a sibling
directory next to the harness's own config, not inside it, because the harness rewrites and
migrates its own config document and a receipt that must survive that rewrite cannot live
anywhere under it.

Re-deriving the plan at `apply` time, rather than trusting the one `plan` printed earlier, is
what catches a document that changed in between — see [refusals](#every-refusal-and-what-distinguishes-it)
below for `PLAN_STALE` and `PLAN_DIGEST_MISMATCH`.

### `awaiting-restart`: written, but not yet in effect

A setting whose policy requires a restart to take effect (every Hermes `approvals.*` setting
today, by assumption — see below) is reported `awaiting-restart` right after `apply` writes
it, until the harness's gateway actually restarts. **AgentPod will not restart the harness
for you.** Nothing in this system issues a restart; an operator restarts the gateway, from
wherever they already do that, and the state changes on its own once observed.

The decision is made by comparing a gateway process id, not by a timer. Hermes multiplexes
one gateway across every profile on a host, so that process's pid is exactly the one that
re-reads config. `apply` reads the station's health right after a successful write and
records that pid. The next comparison reads the station's **current** gateway pid and
reports `awaiting-restart` whenever that pid is unchanged from the one recorded at write
time — or when either pid cannot be confirmed at all: the current one (health degraded,
harness stopped) or the one that was supposed to be recorded at write time, which is left
unset whenever that post-write health read timed out or came back in an unexpected shape.
An unconfirmable pid on either side deliberately stays `awaiting-restart` rather than
resolving to `matches`: claiming a restart is still needed when it already happened costs one needless
restart; claiming a restart already happened when it hasn't produces false agreement, which
is the worse mistake.

Whether `hermes.approvals.*` truly needs a restart to take effect is itself unverified —
Hermes's own documentation lists hot-reloadable settings and settings needing a restart, and
`approvals.*` is in neither list. The registry assumes `true` deliberately: an unnecessary
restart is cheaper than a running gateway that silently disagrees with its own config file.
See `docs/superpowers/notes/2026-10-05-hermes-approvals-restart.md` for what was checked and
why it stayed inconclusive.

## Adopting a station: one reconcile, not a sweep

When a station is adopted, every setting already declared for it — at station, node, or
fleet level — is reconciled exactly once, right after the station's row is written. A
setting is skipped, not written, when its policy is `report-only`, when it's opted out, or
when it already matches; otherwise it's planned and, if the plan isn't a no-op, applied with
that plan's own digest — the same `plan`-then-`apply` path described above, run on the
station's behalf.

**A write failure here never fails the adoption.** Every setting on every station is
isolated: a plan refusal, an apply refusal, an unreachable node, or an unreadable document
is recorded against that one station (visible as its config reason) and never thrown. A
station adopted with one setting unwritten is better than one not adopted at all.

**And it never holds the adoption open for long.** Stations are reconciled concurrently
rather than one after another, and the whole pass is capped: past the cap the adoption
answers, and the stations still in progress keep going and keep recording their own config
reason. That matters because a node can be *connected but wedged*, where every round trip
pays its full timeout instead of failing fast — adopting many stations onto such a node used
to leave the request running long after the rows were committed, so a client that gave up
reported a failed adoption of stations that were adopted.

This reconcile runs exactly once, at the moment of adoption — never on a timer and never
swept across already-adopted stations. A station that drifts afterward stays drifted until
someone asks for it (`fleet config drift`) or declares and applies again; running this on a
schedule would race the harness's own rewrites of the same file, or silently undo a change
an operator just made through it.

## Every refusal, and what distinguishes it

A refusal that cannot be told from a pass is the failure this whole area keeps hitting, so
every one of these is distinct and carries its own message. There are ten:

| Refusal | What distinguishes it |
|---|---|
| `UNKNOWN_SETTING` | The setting id isn't in any reachable registry — or no node could be asked to confirm either way; the message, not the code, tells you which. |
| `NOTHING_DECLARED` | The setting id IS in the station's live registry, but nothing is declared for that station at any level and no value was given to plan against. Remedy: `fleet config set`. Distinct from `UNKNOWN_SETTING` because the id is real and the remedy is a different command. |
| `NODE_UNREACHABLE` | The node could not be asked at all (offline, timed out, disconnected, or answered in an unexpected shape). Remedy: retry once it is back. Never used for a refusal the node itself named — a node that answers with a refusal is a node that was reached. |
| `OUT_OF_SCOPE` | The declaration's own target has no document to land in at all (for example, declaring against Hermes's composite root, which has no profile-scoped document of its own) — a plan-time refusal, distinct from the `out-of-scope` *comparison state* reported for a per-station declaration of a non-`profile`-scoped setting. |
| `SHAPE_UNEXPECTED` | The declared value doesn't fit the setting's registered shape (an `additive-only` value that isn't a list of strings, say), or the derived edit would change something outside the keys this plan claims to touch. |
| `PLAN_STALE` | The document changed after this plan was reviewed. Remedy: re-plan and re-review. |
| `PLAN_DIGEST_MISMATCH` | The digest `apply` was given does not match the one this station's journal recorded for that operation. Remedy: re-read the plan that was actually reviewed (`inspect`), not re-plan — the document itself hasn't necessarily changed. |
| `OPTED_OUT` | An explicit operator opt-out (see [Opting a station out](#opting-a-station-out)). `plan` produces it per setting — refusing just the opted-out entries of a mixed request, or the whole request when every setting named was opted out — before `config.plan` is ever dispatched for one of them. `apply` produces it for the whole operation when a setting the plan covers was opted out after the plan was made, before `config.apply` is ever dispatched; nothing in that plan is written. |
| `UNREADABLE` | The document could not be read or parsed at all; nothing about its contents is inferred. |
| `CREDENTIAL_PATH` | The setting's target resolves to a credential file (`auth.json`, `.env`, or a path under a `credentials` directory) and is refused before it is ever opened, let alone read or edited. |

`PLAN_DIGEST_MISMATCH` was added during implementation, after the seven above were
specified, because collapsing it into `PLAN_STALE` would make two conditions with different
remedies indistinguishable from their refusal code alone. `NOTHING_DECLARED` and
`NODE_UNREACHABLE` are the two the hub produces on its own: no node can produce them,
because only the hub knows what is declared and only the hub knows it could not get an
answer.

**A refused plan is a refusal, not a plan.** `fleet config plan` exits non-zero on one, and
the HTTP route answers 400 when re-sending the same request could never work
(`UNKNOWN_SETTING`, `NOTHING_DECLARED`, `OUT_OF_SCOPE`, `SHAPE_UNEXPECTED`, `OPTED_OUT`,
`CREDENTIAL_PATH` — the remedy is a different request, usually `fleet config set`) and 409
when the request was well-formed and lost to the state of the document or the station
(`UNREADABLE`, `PLAN_STALE`, `PLAN_DIGEST_MISMATCH` — the remedy is to re-read and
re-send) — never 200 with a refusal in the body, which no script could tell from a plan.
`SHAPE_UNEXPECTED` is a 400 because neither of its causes resolves itself: a declared value
that does not fit the setting has to be re-declared, and a derived edit that would disturb
the document never succeeds on a retry of the same request. `OPTED_OUT` is a 400 whether
the hub or the node is the one that noticed. The code and the sentence are the node's own
wherever the node is the one that refused, and at adopt time they are what gets recorded
against the station, so a recorded reason names the refusal rather than blaming the
connection.

## A setting that can't be found

Declaring a setting the hub doesn't recognize is refused with `UNKNOWN_SETTING`. The
refusal's reason is read verbatim from the hub — it may mean the setting genuinely doesn't
exist in any reachable harness's registry, or it may mean no node was reachable to confirm
either way. Those are two different problems with the same refusal code, and only the reason
text tells you which one you have.
