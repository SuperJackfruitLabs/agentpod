---
title: Declared harness settings
description: Declaring what a harness setting should be, the three policies that govern how it may be reconciled, and the states a station can report back.
---

A harness — Hermes, OpenClaw, Claude Code, Codex, OpenCode, Pi — keeps its own
configuration, in its own file, in its own shape. AgentPod does not own that file. What it
can do is let the fleet **declare** what a registered setting should be, and then tell you
where each station's actual value stands against that declaration.

## A declaration is not a write

```sh
fleet config set hermes.approvals.mode --value strict
```

**This records a declaration. It does not touch a station.** Nothing on disk changes when
this command returns — the hub remembers that the fleet *wants* `hermes.approvals.mode` to
be `strict`, at whichever level you declared it. Writing a harness's own config file,
restarting it, and confirming the write took effect is a separate, reviewed operation, and
it is not part of this release.

The gap between declaring and applying is deliberate, not a missing feature. A harness
persists an operator's own decisions into the same file a declaration targets — see
`additive-only` below — so nothing here should be moving a file unasked. A user who treats
`set` as something that changed a machine has been misled by it; treat it as writing a line
into a policy document, not into the harness.

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

### Why a station is not a config scope, except for Hermes

For five of the six harnesses, a station is a *project path*, while the harness's
configuration lives per *user*. Declaring a setting "for this station" would be declaring
it for a document the station doesn't actually own — the user's config file is shared
across every project that user opens, so a station-scoped declaration on, say, Claude Code
or Codex has no document to land in.

Hermes is the exception: there, a station **is** a profile, and a profile is exactly the
document Hermes's settings live in. That is the only harness where declaring a setting at
the station level corresponds to a real, single document, which is why `--station` is
accepted for Hermes settings and refused — `out-of-scope` — for a setting whose registered
`scope` says otherwise.

## The three policies

Every registered setting carries a `policy`, which says what this system is permitted to do
toward making a station's value match the declaration:

| Policy | Meaning |
|---|---|
| `reconcilable` | The value can be fully reconciled to the declaration — whatever is there can be replaced outright — once writing ships. |
| `additive-only` | The declaration is a floor, never the whole value. Items can be added; nothing already there is ever removed — once writing ships. |
| `report-only` | The value is only ever compared and reported. Nothing here would ever write it, even once writing ships. |

`additive-only` exists because a harness persists an operator's own decisions into the same
file a declaration targets. `hermes.approvals.command_allowlist` is the first example: an
operator can extend that allowlist from Hermes's own UI at any time, and that edit lands in
the same document a fleet-wide declaration points at. Reconciling the list down to exactly
what was declared — the `reconcilable` behaviour — would silently delete a grant the
operator made minutes earlier through a surface this system never watched. A declared
baseline must never be able to erase an operator's own decision; `additive-only` is the
policy that guarantees that, by only ever being allowed to add.

## Seeing what the fleet can declare

```sh
fleet config settings
```

lists every setting any reachable node currently manages — the live registry, read from the
node, never a copy held in the hub. A node that cannot currently be asked contributes
nothing to this list, and is named separately so its absence isn't silent.

## Seeing where things stand

```sh
fleet config show                     # every declaration in the fleet, compared
fleet config show --node nod_123      # one node's declarations
fleet config show --station st_abc    # one station: declared vs observed
fleet config drift                    # every station whose value differs from what's declared
```

Each comparison reports, per setting, a **state**:

| State | Meaning |
|---|---|
| `matches` | The observed value agrees with what's declared. |
| `drifted` | Declared and observed disagree. |
| `absent` | Declared, but the key isn't in the document at all. |
| `opted-out` | An operator explicitly opted this station out of the declaration — reachable only once writing ships. |
| `awaiting-restart` | A value was written but the harness hasn't picked it up yet — reachable only once writing ships. |
| `unreadable` | The document couldn't be read or parsed. Never reported as `matches` — an unreadable document is not evidence of agreement. |
| `out-of-scope` | A per-station declaration was made for a setting whose registered scope isn't the station's document (see above). |

`fleet config drift` only reports states other than `matches`, plus the list of stations it
could not reach at all — a station it couldn't ask is never silently left out of the total.

## A setting that can't be found

Declaring a setting the hub doesn't recognize is refused. The refusal's reason is read
verbatim from the hub — it may mean the setting genuinely doesn't exist in any reachable
harness's registry, or it may mean no node was reachable to confirm either way. Those are
two different problems with the same refusal code, and only the reason text tells you
which one you have.
