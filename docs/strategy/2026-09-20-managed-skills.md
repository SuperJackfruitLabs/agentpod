# Skill inventory and managed installation

Kind: dated decision. Date: 2026-09-20. Status: proposed, implementation in a
review branch. This does not authorize a production rollout or mark the skill
library's remaining behavioral/ACP gates complete.

## Context and decision

AgentPod discovers six harnesses but has no skill capability. Copying a package
onto a node cannot establish that an active session loaded it. Skills also do not
grant product permissions. Add optional descriptor interfaces and typed broker
verbs, using existing node/station identity and hub ownership checks.

The first capability is `skills.inventory`, with the same named broker verb.
The request contains only a station key: callers cannot supply a filesystem root,
another profile, a command, or an authentication path. The node resolves the exact
currently detected station before scanning descriptor-selected roots.

Each skill reports its name, observed path and scope, source/revision/artifact
digest when established, the digest of its entrypoint (explicitly distinct from
an artifact digest), declared dependencies, shadowing and compatibility evidence.
Catalogued, present, eligible, loaded and exercised are separate observations.
An unknown observation has a reason; a known observation has a timestamp. None
of these fields is computed from another. In particular, present does not imply
eligible or loaded, and an empty compatibility list proves nothing.

Native plugins have a separate list, including component kinds and activation
evidence. A package manifest is content evidence, not proof of registration or
execution. Inventory never imports code, executes hooks, starts a model, probes
credentials, refreshes a session or restarts a station.

Every response includes root coverage and limitations. The initial filesystem
reader is scoped to the station's workspace/profile; inherited, user, system,
configured external roots and session/plugin registries require subsequent native
adapters. They must be reported as unobserved, not silently treated as empty.
Duplicate names are reported without inventing a cross-harness precedence rule.
Unreadable roots, malformed entries and bounds reached remain visible. Reads are
bounded and confined to the resolved root; symlinks and special files are not
followed. Skill bodies, arbitrary metadata and credentials do not leave the node.

## Management protocol to follow

The Go artifact reader now accepts a separately pinned library `tar.gz` stream
without writing it to a station. It verifies the archive SHA-256, the library's
canonical manifest digest, complete file set, file hashes/modes, declared skill
entrypoints and notice presence. The authenticated catalog/plan must supply the
archive pin; the archive's own claim is not a trust source.

Acquisition limits are 32 MiB compressed, 64 MiB expanded, 4,096 regular files,
8 MiB per file and 2 MiB for the manifest. Paths are relative ASCII names with
bounded components; content and metadata may contain Unicode. Links, special
files, overlapping paths, case aliases, duplicate JSON keys, multiple roots,
reserved installation receipts and archive tails are rejected. PAX path headers
from the library exporter are supported. The eventual transport must enforce a
deadline as well: cancellation cannot interrupt an arbitrary blocked reader.
This reader is an offline primitive, not an advertised management capability.

Keep management separate as `skills.manage`; do not advertise it with inventory.
The planned verbs are `skills.plan`, `skills.apply`, `skills.verify`,
`skills.rollback` and `skills.operation`. Implement their contract alongside the
durable state machine rather than reserving nonfunctional endpoints.

A plan binds the exact node/station/profile/workspace, immutable artifact digest,
expected prior state, owned relative paths, operation ID, concrete diff and
activation requirement. The node derives paths, validates ownership and rejects
stale plans. Acquisition must be authenticated where required and bounded by size,
time and expansion; archives cannot escape through paths, links or special files.
Do not put private skills in public images or execute package-supplied commands.

Application journals intent before mutation, atomically switches a verified owned
generation, verifies it, and retains the prior generation. Repeated requests use
the same operation ID. The hub records coordination/audit state, while the node's
receipt describes the filesystem outcome. Timeout/disconnect means unknown:
inspect the operation before retrying. Recovery must distinguish interrupted
staging, completed activation and user changes; rollback cannot overwrite edits.

Activation is a harness/version/mode capability. A busy session stays on its
known revision until a supported refresh boundary. Unsupported refresh remains
pending; installation never automatically restarts it. Verify presence, native
eligibility/loading and an exercise separately.

## Hub, console and verification

Expose inventory at `POST /api/stations/:id/skills/inventory`. Authenticate, resolve
the owned station and gate its advertised capability before calling the node.
Validate node output against the contract; an invalid response is a failure, not
an empty inventory. The console shows scope, freshness, coverage and unknown
states, with plugins separate from skills. Management adds profile/artifact
selection, a reviewable diff, progress, conflicts, activation and rollback.

Contract fixtures round-trip through Go so nullable evidence cannot silently become
false. Filesystem tests cover scope isolation, traversal/symlink rejection, bounds,
malformed entries and unchanged user files. Gateway/hub tests cover unavailable
capabilities, ownership, malformed replies and offline nodes. UI tests distinguish
present from loaded and preserve partial/error states.

Release still requires native and ACP evidence for each declared harness target,
one actual canary per harness, rollback, then an operator-selected cohort. Test
persistent and ephemeral Modal, Fly images and local placement separately; source
pins do not establish deployed versions. Follow the current release runbook and
verify the real deployment before claiming completion.
