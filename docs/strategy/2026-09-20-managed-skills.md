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

## Managed packages and node protocol

The Go artifact reader now accepts a separately pinned library `tar.gz` stream
without writing it to a station. It verifies the archive SHA-256, the library's
canonical manifest digest, complete file set, file hashes/modes, declared skill
entrypoints and notice presence. The authenticated catalog/plan must supply the
archive pin; the archive's own claim is not a trust source.

Acquisition limits are 32 MiB compressed, 64 MiB expanded, 4,096 regular files,
8 MiB per file and 2 MiB for the manifest. Archive paths have at most 64 components
and 16,384 total file/directory names. Paths are relative ASCII names with bounded
components; content and metadata may contain Unicode. Links, special
files, overlapping paths, case aliases, duplicate JSON keys, multiple roots,
reserved installation receipts and archive tails are rejected. PAX path headers
from the library exporter are supported. The HTTP acquisition client adds a
60-second deadline, context cancellation and an independent 32 MiB stream bound.

The local Go installation engine now persists typed plans and receipts. Its
namespace under `.agentpod-skills` binds node, station, harness, selected library
profile, canonical workspace path and workspace device/inode identity. The exact
generation destination and payload diff are part of the persisted plan. Clients
apply by operation ID and reviewed plan digest, not editable plans or target paths.

Planning verifies the current generation and pins its head receipt. Application
uses an advisory filesystem lock, records staging intent, writes and verifies a
new generation, then atomically replaces the current-head receipt. The head
includes the operation ID so rolling between the same two generations does not
make an old plan current again. Package manifests appear in the review diff.
Generation directories are retained; applying or rolling back never overwrites
their contents. Rollback binds and verifies both the current and prior generation,
including user edits. Rolling back the initial installation restores managed
absence. It does not claim that no other skills exist in the workspace.

Individual files, metadata and initial namespace publication use temporary paths
and atomic renames with file/directory synchronization. A repeated operation ID
returns its historical receipt after completion; an interrupted application can
resume staging or reconcile a completed head switch. `Operation` is observational;
`Verify` re-reads current file hashes and modes. A timeout is not evidence of no
change. Tests cover actual process exits as well as injected failures; they do not
simulate hardware power loss or defend against a malicious process with the same
OS permissions as the node.

Interrupted temporary writes are preserved outside generations. The engine stops
at 16 retained partial writes, 256 operation records per binding (with one record
reserved from new installations for rollback), or 512 namespaces
per workspace instead of silently deleting evidence. Retention inspection and
cleanup must be exposed before broad managed rollout. Package materialization
does not register a plugin, update harness configuration or refresh a session.
Session loading remains unknown.

The console now exposes a read-only retained-state inspection for one managed
profile. It reports the node-owned operation, generation, staging, pending-write,
and native-placement counts without creating a namespace. It deliberately does
not prune anything: receipts and generations remain recovery evidence until a
separately reviewed maintenance policy can prove what is safe to remove. Broad
rollout therefore still requires that maintenance policy and its recovery tests.

The maintenance policy is now defined for implementation. A node first produces
a bounded, read-only plan and a digest of the managed and native heads it
observed. It refuses to plan if either namespace contains an incomplete or
conflicting receipt, an active native journal, malformed node-owned state, or a
changed workspace binding. A plan may include only completed records beyond a
fixed retained history floor and generations unreferenced by both managed and
native current/previous heads. It never includes staging, pending writes,
conflicts, active journals, current/previous generations, or the history floor.
Applying requires the exact reviewed digest under the installation lock and
rechecks every head and candidate immediately before removal. A mismatch or an
uncertain result leaves state intact and requires a new inspection. There is no
background cleanup and no recursive caller-supplied path.

The first implementation exposes that plan and its exact digest through the
station Skills panel. Apply receives only the reviewed digest; it writes a
node-owned maintenance journal before removal and updates that journal after
each candidate, so an interrupted cleanup resumes the original reviewed set
instead of creating a fresh plan. Source-level checks cover protected heads and
the retained history floor. CI, a released node binary, and a disposable
station recovery exercise remain required before this closes the broad-rollout
gate.

The node now implements `skills.plan`, `skills.apply`, `skills.verify`,
`skills.rollback` and `skills.operation` under the separate `skills.manage`
capability. Six descriptors opt into exact detected-workspace resolution. The
registry advertises management only when the handler and authenticated download
client are configured. A hub without the new capability schema safely filters it.
The shared hub reach classifier treats management mutations as granting reach;
observational calls do not create a namespace or repair missing lock state.

Requests accept station keys, library profiles and operation IDs. Plan additionally
requires the station database ID and pinned archive SHA-256; apply requires the
station ID and reviewed plan digest. Unknown fields, duplicate keys, caller paths,
commands and download URLs are rejected. Apply compares the reviewed digest again
under the installation lock. A completed apply returns its historical receipt
without downloading again; rollback uses retained local generations.

The node download client uses its existing enrolled identity to POST to its fixed
hub origin at `/api/nodes/:nodeId/stations/:stationId/skill-artifacts/:operationId`,
with `X-AgentPod-Station-Key` binding the detected key. TLS is mandatory outside
loopback development. Redirects are refused, response bodies never become errors,
and bytes must match the requested digest before the archive verifier runs.
The hub now implements that route with a short-lived operation authorization.
It checks the enrolled node secret, current station node/key/owner/tenant/harness,
the operation and artifact binding, the owner's ban state and current reach
permission. Downloads are available during an authorized plan/apply attempt;
recovery renews authorization through the same authenticated operator action.

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

## Native project placement primitive

The Go node now has a separate placement transaction for the grouped project
layouts tested on Codex 0.155.0, OpenCode 1.18.15, Pi 0.84.1's directory loader and
OpenClaw 2026.2.12. Claude's grouped layout is unsupported; Hermes has no local
runtime evidence. The primitive publishes a complete selected generation to
`.agents/skills/sjl-<profile>`, `.opencode/skills/sjl-<profile>`,
`.pi/skills/sjl-<profile>` or `skills/sjl-<profile>` respectively.

Placement has its own typed plan, head, operation receipt, journal and retained
copies. A plan pins both managed and native heads, the workspace/repository
identities, generation digest, native destination and file diff. A repository-wide
advisory lock coordinates nested workspaces. Bounded scans check declared names
in known project roots through the Git root. User, configured external and native
plugin roots remain unobserved; a future operator flow must expose that limitation.
Removal introduces no names and preserves unrelated unfinished user skills.

Only plain-skill exports are eligible for this adapter. Undeclared root components,
native hooks/tool-server configuration, Pi executable extensions/dependencies and
undeclared nested skill entrypoints are refused. Executable native integrations
need their own reviewed adapter; an artifact hash does not authorize activation.

Staging and backups stay under the managed namespace, outside discovery roots.
Publishing journals intent, verifies a complete staged copy, moves the owned prior
directory into backup, publishes the new directory, then records its native head.
There is a brief absence window between renames. Recovery recognizes publication
before head/receipt completion, preserves edits and refuses competing operations.
Rollback and deactivation affect native placement without changing the independently
selected managed generation. Repeated activation preserves useful rollback history.
Receipts are historical; fresh verification rereads current bytes. For a managed
Codex placement whose selected adapter/engine pair is covered by the isolated
probe and whose workspace is quiescent, it also starts an offline disposable ACP
session and compares the exact qualified command names in the placement receipt.
That produces a dated loaded yes/no observation. Every other harness, unmanaged
layout, unknown runtime, busy workspace and probe failure remains unknown with
its reason; this does not establish active-session refresh.

This primitive is deliberately **not advertised as a remote capability** yet.
It requires a quiescent workspace. Before broker/hub/console exposure, complete
external/lifecycle process coverage, verify actual runtime
version/mode and expose unsupported or externally busy cases. Advisory locks do
not control external harnesses or editors. No busy station is restarted and no
production workspace was changed by this work.

Tests cover actual process exits at ten publication stages, stale managed/native
state, changed review digests, nested-root collisions, symlinks, user edits and
safe deactivation. The optional native probe adds 44 checks using four real
harnesses and checked-in synthetic exporter fixtures. Pi uses its loader only;
none establishes model behavior, ACP, session trust or deployed operation. See
`apps/node-agent/internal/skills/testdata/README.md` for reproduction and evidence.

### Managed session coordination

ACP and terminal managers now share an in-process workspace coordinator in the
daemon. Activity reserves its resolved directory before process creation and
keeps that reservation until the direct child is reaped, including during close
or shutdown. Concurrent opens for the same instance share the pending start;
shutdown closes admission permanently and waits for admitted starts and closing
children. Terminal children are reaped on natural exit as well as explicit close,
and late output subscribers receive the retained output followed by closure.

Exclusive publication leases reject related activity and prevent new starts for
their duration. Canonical paths plus filesystem identities detect aliases,
nested paths and renamed repository roots; unrelated directories remain usable.
`ApplyPlacementWhenIdle` acquires that lease over the repository, rechecks its
identity and runs the existing reviewed transaction. Tests exercise actual ACP
and PTY children against synthetic placement, including attempts to start them
at the publication boundary. This is lifecycle coordination, not a native ACP
compatibility test: the test children are shell/cat fixtures.

The transaction durably publishes
`.agentpod-skills/admission/fence.json` at the repository root before its native
journal or discovery files change. It binds the station/workspace, repository
identity, operation ID and reviewed plan digest. A changed managed selection
cannot replace that operation's pinned generation during recovery. Competing
namespaces and unreviewed or mismatched operations cannot clear or replace it.
Completion persists the native head, receipt and journal cleanup before removing
the marker and syncing its directory. Receipt-only cleanup preserves later user
edits while fresh file verification still reports them.

Every managed session start reserves its cwd, then inspects the cwd and its
ancestors for the marker before spawning. This inspection creates no files,
reads no marker contents and rejects ambiguous paths. Recreated managers therefore
refuse new starts after a failed apply or node restart until exact-operation
recovery finishes. Recovery itself can still acquire the exclusive lease. A
preflight failure before any publication intent does not leave a recovery block.
Malformed or edited markers remain blocked for inspection instead of being
silently deleted. Ten separate-process exit tests include admission creation and
the interval after journal cleanup but before marker removal.

This guard covers cooperating managers in one node process only. It does not
discover external harness processes, lifecycle-managed daemons or detached
children. A terminal or ACP tool may also change directory after launch; its
reservation describes the admitted working directory, not every file it can
access. External directory moves or replacements during admission are also outside
this in-process guard. Marker inspection does not enumerate descendant repositories
from an ancestor cwd. The marker is not a cross-process active-session lock: an
already running child left behind by a terminated node needs external-process
inspection before recovery, as does activity managed by another node process.
Those gaps, actual version/mode gating and operator
visibility must be resolved before any remote activation capability is enabled.
The node now has strict `skills.native.*` request/result schemas and a separate
handler boundary for native planning, application, operation inspection and
verification. Mutation is off by default. An operator must set
`nativeSkillActivation` on the node, the descriptor must supply current runtime
readiness evidence, and the shared workspace coordinator must acquire the
repository lease. Only those descriptors advertise `skills.native`; today that
means Codex, and its readiness remains version- and process-specific. The Hub
and Console retain native plans, receipts and history separately from managed
installation, require reach permission, and never restart a station.

The supported operator workflow is `apn native-skills status|enable|disable`.
It changes only the local node gate, preserves the selection across re-enrollment,
and requires a node-service restart before the hub can observe the capability.
It deliberately does not activate a release, select a station, bypass readiness,
or restart a harness. Native canary evidence remains an operational gate after
the node release is deployed and the operator has explicitly enabled it.

## Hub, console and verification

Expose inventory at `POST /api/stations/:id/skills/inventory`. Authenticate, resolve
the owned station and gate its advertised capability before calling the node.
Validate node output against the contract; an invalid response is a failure, not
an empty inventory. The console shows scope, freshness, coverage and unknown
states, with plugins separate from skills. Management adds profile/artifact
selection, a reviewable diff, progress, conflicts, activation and rollback.

The management API and console artifact flow are now implemented. All operator
routes require the existing authenticated user, tenant,
station ownership and advertised capability. Planning and application additionally
require reach permission, including rollback planning because it persists state.

| Route (under `/api`) | Request / result |
|---|---|
| `POST /skills/artifacts?harness=…&profile=…` | Binary upload; immutable artifact ID, server-computed archive hash and declared metadata |
| `GET /skills/artifacts` | Owner/tenant metadata only; no content or inferred compatibility |
| `DELETE /skills/artifacts/:artifactId` | Deletes only an owned artifact not referenced by an operation |
| `POST /stations/:id/skills/plan` | `{requestId, artifactId}`; durable operation with node-validated plan |
| `POST /stations/:id/skills/rollback` | `{requestId, profile}`; a separate reviewable rollback plan |
| `GET /stations/:id/skills/operations` | Last 50 operation summaries, without large plan payloads |
| `GET /stations/:id/skills/operations/:operationId` | Recorded plan, receipt and coordination status |
| `POST /stations/:id/skills/operations/:operationId/inspect` | `{}`; reconcile with the node's durable receipt |
| `POST /stations/:id/skills/operations/:operationId/apply` | `{planDigest}`; apply the exact reviewed plan |
| `POST /stations/:id/skills/verify` | `{profile}`; fresh managed-file evidence, with loading independently unknown |

Artifacts use the existing Postgres database, scoped to owner and tenant. Upload
declarations remain unverified metadata until a node validates the actual package;
they never establish native compatibility. Each upload is bounded to 32 MiB and
30 seconds, with 128 MiB / 256-artifact retention per owner and tenant. Quota checks
serialize across hub processes. Composite foreign keys prevent cross-owner or
cross-tenant artifact and station references.

A client request UUID maps to one station-scoped operation ID. An operation cannot
be retargeted by replaying that UUID with different input. The hub atomically
records an audit intent and a 180-second coordination lease before dispatch;
downloads have a separate 90-second authorization window. Final writes match the
worker's lease token so a stale response cannot overwrite a newer observation.
Every retry inspects the node first. Timeout, invalid replies and expired worker
leases report `unknown`, never success or evidence of no change. A node-confirmed
receipt is required for completion. The station retains up to 256 operation
records, reserving one from new installs for rollback; broad rollout still needs
retention inspection/maintenance. No background scheduler is introduced.

Migration `0069_managed_skills` adds the two tables and ownership indexes. Referenced
unique indexes precede their composite foreign keys. Test it against the prior
schema, not only a database where the feature tables already exist.

The station Skills tab exposes management only when `skills.manage` is advertised.
An operator can upload an exported archive with its declared profile, select an
artifact for the station harness, review added/changed/removed paths and the bound
workspace, then apply the exact displayed plan digest. Rollback requires its own
review. Reach permissions disable mutation controls; the hub remains authoritative.
History, inspection and fresh file verification remain available for recovery.
A lost planning response retains its request UUID for retry. An uncertain apply
requires node inspection before the UI offers apply again. Navigation discards late
responses from the previous station. Conflict guidance preserves local edits;
there is no force-overwrite button. Loading evidence remains separate from applied
files. The UI now presents native activation, rollback and removal as separate
reviewed operations only when the node advertises `skills.native`. The trusted
catalog and immutable cohorts now exist at the API boundary; an operator UI,
archive-content admission and live canary evidence remain unfinished.

### Stable catalog intake boundary

The future catalog accepts an immutable library release record, never a claim
attached to a manually uploaded archive. Intake must require schema version one,
one canonical artifact for each of the six harnesses, the record digest over its
unsigned canonical JSON, and archive bytes matching every pinned SHA-256. Each
archive must then pass the node-equivalent bundle checks and match its declared
harness, profile and bundle digest. A duplicate record digest is idempotent;
the same version/profile with a different digest is refused. Catalog records are
owner/tenant scoped and retain their original release record and archive pins.
They do not prove a harness loaded a skill or that a release is safe to deploy.

A cohort is an operator-selected immutable list of station IDs plus one catalog
record digest. Planning rechecks every station owner, tenant, harness and reach
permission and creates reviewed per-station plans. The first station is named
explicitly in a canary request, which records an ordinary managed operation
bound to the cohort's release, digest and harness-specific archive. Its later
inspection and reviewed apply repeat that binding; applying it does not advance
another cohort member. Runtime observation and rollback remain required before
any later cohort is chosen. Empty, offline, mixed-owner or already-unknown
stations are visible refusals, never silently excluded.

Contract fixtures round-trip through Go so nullable evidence cannot silently become
false. Filesystem tests cover scope isolation, traversal/symlink rejection, bounds,
malformed entries and unchanged user files. Gateway/hub tests cover unavailable
capabilities, ownership, malformed replies and offline nodes. UI tests distinguish
present from loaded and preserve partial/error states.

The required hub CI job also runs a real Go-handler integration fixture over
loopback HTTP, an isolated database and a temporary workspace. It exercises
upload, enforced station grants, plan, authenticated download, reviewed apply, file verification, replay
and retained-generation rollback. The fixture authenticates a temporary node
identity and does not read live enrollment files or start a harness. Native/ACP
activation and deployed placement remain separate, unmet gates.

Release still requires native and ACP evidence for each declared harness target,
one actual canary per harness, rollback, then an operator-selected cohort. Test
persistent and ephemeral Modal, Fly images and local placement separately; source
pins do not establish deployed versions. Follow the current release runbook and
verify the real deployment before claiming completion.

### Node release evidence (2026-09-21)

`v0.1.43` packages the read-only retained-state inspection from merged change
`#499` (`3cdbeac4`). Its GitHub release workflow completed successfully and the
published manifest contains the four `agentpod-node` binaries, four
`agentpod-fleet` binaries, both installers, the service unit, and
`SHA256SUMS`. Downloading those public assets and verifying the manifest passed
for every listed asset. This establishes a reproducible node release; it does
not establish that any station has installed the version or that retained state
has been inspected on a live station.

`v0.1.44` packages merged change `#502` (`8fbedb25`): the reviewed retained
state cleanup flow. Its release workflow completed successfully, and all four
node binaries, four fleet binaries, installers, service unit and checksum
manifest were downloaded and verified against `SHA256SUMS`. The remaining
evidence is deliberately operational: install it only on a disposable station,
exercise preview, reviewed cleanup, an interrupted journal and recovery, then
inspect retained state. This release evidence does not establish that a station
has installed it or that cleanup has run safely outside fixtures.

### Runtime selection follow-up (2026-09-21)

Pi ACP now receives the absolute selected Pi executable through
`PI_ACP_PI_COMMAND`, in addition to its supporting PATH. Previously an inherited
adapter override could select a different engine, and a `PI_PATH` executable
with a custom basename was not honored by the adapter's default `pi` lookup.
The synthetic adapter regression reproduces both conditions and waits for its
child to exit. This aligns selection; it does not establish version identity,
external-process quiescence or eligibility for native activation.

Read-only inspection of codex-acp 1.1.14 also confirms that, without CODEX_PATH,
it launches its bundled @openai/codex entrypoint. The adapter's --version reports
the adapter version, even when passed after its cli subcommand. Future preflight
must resolve the actual engine and launch mode rather than use the host PATH
Codex version or the adapter version as engine evidence.

### Codex fresh-session ACP evidence

The bundled Codex 0.147.0 now passes the same eleven placement lifecycle checks
as the earlier host CLI. Codex ACP 1.1.14 also passes all eleven using fresh
sessions with a disposable home and offline provider. Both advertise the exported
qualified fixture name; installation alone remains undiscovered and sibling
workspaces remain isolated. No model prompt or client tool is used. These are
repeatable installed-runtime probes, not a production version gate or evidence
of active-session refresh, production authentication or AgentPod transport.

The node now reuses this same bounded probe for `skills.native.verify` on a
managed Codex placement. The verification receipt carries the command names
derived from its verified generation, so an unrelated skill cannot make the
placement appear loaded. The probe is read-only and leaves native publication
fail-closed until the operator activation workflow, lifecycle coverage and
cohort rollout gates are implemented.
