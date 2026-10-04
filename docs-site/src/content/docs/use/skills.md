---
title: Managed skills
description: Knowing what skills a station actually has, installing one under review, and proving a session loaded it.
---

A skill is a package an agent can use. Copying one onto a machine is easy; **establishing that a
running session loaded it** is the hard part, and it is the part that matters — an agent with a
skill it did not load behaves exactly like an agent without it.

AgentPod treats that as the whole problem. Nothing here grants a product permission: a skill is a
capability of an agent's environment, not an authority.

## Inventory: what is actually there

```sh
fleet skills station verify --station <id> --profile <profile>
```

Inventory asks a station what skills it has and reports each one's name, where it was observed, its
scope, the digest of its entrypoint, its declared dependencies, and whether anything shadows it.

The design rule is that **nothing is inferred from anything else**. These are separate
observations:

| observation | means |
|---|---|
| catalogued | the catalog knows about it |
| present | it is on disk where it should be |
| eligible | the harness would consider loading it |
| loaded | a session has it |
| exercised | it has actually run |

Present does not imply eligible. Eligible does not imply loaded. An empty compatibility list proves
nothing. A known observation carries a timestamp; an **unknown observation carries a reason** —
never a silent `false`.

The same applies to coverage. Every response says which roots it read and which it could not, so an
unread root is reported as unobserved rather than treated as empty. Unreadable roots, malformed
entries and bounds reached all stay visible.

**Inventory never imports code**, executes hooks, starts a model, probes credentials, refreshes a
session or restarts a station. Skill bodies and credentials never leave the node.

A request carries only a station key. A caller cannot supply a filesystem root, another profile, a
command, or an authentication path — the node resolves the station it has actually detected and
scans only the roots that station's descriptor selects.

## Plan, inspect, apply

Every change is a reviewed change, in three steps:

```sh
fleet skills station plan    --station <id> --artifact <artifactId>
fleet skills station inspect --station <id> --operation <opId>
fleet skills station apply   --station <id> --operation <opId> --plan-digest <sha256>
```

The apply names the **digest of the plan it is applying**. If the plan changed between your reading
it and your applying it, the apply does not match and does not proceed. This CLI never turns a plan
into an implicit apply: every mutation returns the hub's reviewed record, and you are expected to
read it.

Rolling back is a plan of its own:

```sh
fleet skills station rollback-plan --station <id> --profile <profile>
```

## Artifacts and releases

```sh
fleet skills upload --harness <h> --profile <p> archive.tgz
fleet skills artifacts
fleet skills artifact delete --id <artifactId>
fleet skills release import release.json
fleet skills releases
```

An uploaded archive is **validated at admission** rather than at install time, and an artifact is
immutable once admitted. A release names a set of artifacts, and a release is a record you import
rather than a thing you edit — so what a cohort was given stays answerable after the fact.

## Cohorts and canaries

A release reaches a fleet gradually:

```sh
fleet skills cohort create --release <id> --digest <sha256> --station <id>
fleet skills cohorts
fleet skills canary plan    --cohort <id> --release <id> --digest <sha256> --station <id>
fleet skills canary inspect --cohort <id> --release <id> --digest <sha256> --station <id> --operation <opId>
fleet skills canary apply   --cohort <id> --release <id> --digest <sha256> --station <id> --operation <opId> --plan-digest <sha256>
```

A cohort is **immutable and bound to a release**: you cannot quietly change which stations got
what. A canary applies that release to one station and verifies the result, so a bad skill is found
on a station you chose rather than across the fleet.

## Native placement

Some harnesses load skills as native plugins at a discovery root rather than as files in a
workspace. Those have their own verbs, because activating one is a different act from copying it:

```sh
fleet skills native plan   --station <id> --profile <p> --action activate|deactivate|rollback
fleet skills native verify --station <id> --profile <p>
fleet skills native apply  --station <id> --operation <opId> --plan-digest <sha256>
```

Native placement is **fail-closed** and gated on an operator setting: a station does not start
loading native skills because a package arrived. Verification opens a fresh session and checks the
skill is loaded there, because a package manifest is content evidence and not proof of
registration or execution.

Duplicate names across harnesses are **reported, not resolved**. AgentPod does not invent a
cross-harness precedence rule it would then have to defend.

## From the console

The console carries the same surface: a station's skill inventory, the review screen for an
installation, which harness an upload is for, trusted releases, and canary controls. The CLI exists
so the same operations can be scripted and so a release can be rolled without a browser.

## Next

- [What you can do to a station](/use/panels/) — the rest of a station's surface
- [apn and fleet](/use/cli/) — the two binaries, and which one acts as you
