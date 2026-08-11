# `changeset` capability — design

**Status:** approved 2026-08-11
**Horizon:** 1 (`docs/strategy/2026-08-10-suite-strategy.md`)
**Precedes:** the change artifact store and delivery adapters (Horizon 2)

## Problem

A change made on one of thirty-nine stations can only be seen by walking to that
machine. The fleet runs five harnesses across Linux and macOS boxes, several
behind CGNAT, and there is no way to answer "what has this agent actually done
to the workspace" without an SSH session.

This is the same theme as Doors: make the fleet useful to someone who is not
sitting at it.

## Scope

**Observe only.** The console asks a station what has changed in its workspace
right now; the node answers; the console renders it. Nothing is stored.

Capture — content-addressing the diff, writing a `Change` row, comparing
candidate diffs across stations — stays in Horizon 2, which the strategy names
"the bridge and the change artifact". The comparison wedge described in §7
("twelve candidate diffs from four harnesses on three substrates, and no way to
compare them") only pays off once dispatch is putting twelve attempts in flight.
Building the store before anything produces that volume means guessing at its
shape.

The accepted cost: a diff you can only see live is a diff you can lose. If the
agent commits, resets, or moves on, the observation is gone. That is tolerable
for one horizon; it is the thing Horizon 2 fixes.

### Explicitly out of scope

- No fleet-wide "which stations are dirty" roll-up. That is N node calls and
  wants the Horizon 2 store. `changeset.status` is shaped so the roll-up can be
  added later without redesigning the verb.
- No `apn changeset` CLI subcommand.
- No delivery, no push, no branch creation, no persistence.
- No Windows support. See "Known limits".

## What counts as a change

An agent leaves work in three places, and all three matter:

1. **Uncommitted edits** to tracked files.
2. **Untracked new files.** Invisible to `git diff` entirely. Agents create
   files constantly, so a view that silently omitted these would be actively
   misleading.
3. **Commits not yet on the base.** Some harnesses commit as they go; some
   never do.

The result keeps *uncommitted* (with untracked folded in) and
*committed-not-on-base* visibly separate rather than merging them into one
patch. They are different operator situations: one means the agent is
mid-flight, the other means finished work is sitting on a machine.

### Base selection

First rule that fires wins, and the result always reports which one did:

| Reason | Rule |
|---|---|
| `explicit` | The caller passed `base`. |
| `upstream` | `@{upstream}` resolves — the branch tracks something. |
| `default-branch` | `origin/HEAD` resolves; base is `merge-base(HEAD, origin/HEAD)`. |
| `head` | Nothing else resolved. Base is `HEAD`; the committed side is empty. |

Reporting the reason is not decoration. A surprising diff on a machine you are
not sitting at is otherwise unexplainable, and the difference between "diffed
against your upstream" and "no upstream, so you are seeing uncommitted work
only" changes what the operator concludes.

## Capability advertisement

`changeset` is advertised **conditionally**: a descriptor includes it only when
the station's workspace resolves to a git repository and `git` is on `PATH`.
Stations without it show no tab, exactly as `acp` gates the Chat tab today.

### The refresh problem this creates

`stations.capabilities` is written in exactly one place —
`adoptStations` (`apps/hub/src/services/station-registry.ts:56,69`). Nothing
else in the hub updates that column. Not on node reconnect; not when the console
fetches the detected list, which calls `detect` but only renders it, leaving
already-adopted rows untouched.

So without a fix, every existing station keeps a capability list that predates
`changeset`. The node would report the capability correctly on every `detect`
and the hub would keep serving the stale list forever. The tab would appear on
stations adopted *after* the update and on no others — working perfectly in
testing and invisible in production.

This is not a `changeset` bug. It is latent for any new capability, and
`posture` in this same horizon would hit it identically. It is therefore fixed
here.

**Fix:** a `refreshAdoptedCapabilities(nodeId)` service, called on node connect
alongside the existing auto-adopt block at `apps/hub/src/routes/gateway.ts:63`.
One `detect`, then update `capabilities`, `displayName` and `workspacePath` for
stations already adopted on that node.

It matches existing `(nodeId, stationKey)` rows only and **never inserts**.
Adoption stays an explicit act; this must not become a back door that
auto-adopts everything a node can see.

## Verbs

Two verbs rather than one. Diffs are unbounded — one bad agent run touching 400
files, or a committed `node_modules`, and a single-response design falls over on
the exact station most worth looking at. Splitting also matches how a diff is
read: scan the file list, open the two files that matter. And `status` alone
answers "does this station have uncommitted work" without fetching any patch.

No streaming. Truncation with a flag, exactly as `fs.read` does today, rather
than stream machinery for multi-megabyte diffs nobody reads.

### `changeset.status`

Params: `{ key, base? }`

Result:

- `repo` — `branch` (null when detached), `head` sha, `detached`
- `base` — `ref`, resolved `sha`, and `reason` (`explicit` · `upstream` ·
  `default-branch` · `head`)
- `uncommitted` — `files[]`, `insertions`, `deletions`
- `committed` — `files[]`, `insertions`, `deletions`, and `commits[]`
  (`sha`, `shortSha`, `subject`, `author`, `committedAt`)
- `truncatedFiles` — the file list hit its cap

A file carries `path`, `oldPath` (renames and copies only, else null), `status`
(`added` · `modified` · `deleted` · `renamed` · `copied` · `type-changed` ·
`untracked`), `insertions`, `deletions`, and `binary`.

`insertions`/`deletions` are null for binary files and for untracked files —
see the no-mutation invariant below for why untracked files are not counted.

**The base affects only the committed side.** `uncommitted` is always the
working tree against `HEAD`, whatever base was selected or passed. Changing the
base changes which commits count as "not yet on the base"; it cannot change what
is currently unsaved on disk.

### `changeset.diff`

Params: `{ key, base?, path?, side, maxBytes? }` where `side` is `uncommitted`
or `committed`.

Result: `{ content, truncated, binary }` — the same contract as `fs.read`.

Omitting `path` returns the whole patch for that side, subject to `maxBytes`.

## Invariants

These are properties of the implementation, not preferences, and each has a test.

**It never writes to the repository.** Read-only plumbing commands only. No
config writes, and specifically **no `git add -N`**, even though intent-to-add
is the conventional way to get untracked files into `git diff` output. That
mutates the index of a workspace an agent may be actively using. The cost is
that untracked files are reported with null line counts; their content is
fetched on demand per path via `git diff --no-index`, which is bounded and only
runs when someone actually opens the file.

**`GIT_OPTIONAL_LOCKS=0` on every invocation.** Without it, `git status` takes
the index lock in order to refresh it — on stations where an agent is actively
editing files. Our read would intermittently contend with the agent's own git
operations, producing a rare and baffling failure a long way from its cause.

**Every git call is an argv exec with a timeout.** No shell strings. No
unbounded hang on a huge repository or a stalled network mount blocking a
gateway handler goroutine.

**Caps.** The file list and the diff byte count are both capped, and both report
truncation rather than silently shortening.

## Structure

### `packages/contract`

- `src/station.ts` — add `changeset` to the `Capability` enum.
- `src/changeset.ts` — new; the shapes above.
- `src/protocol.ts` — two entries each in `VERB_PARAMS` and `VERB_RESULTS`.
- `src/index.ts` — export.
- Go golden fixtures regenerate via `scripts/emit-go-fixtures.ts`; the
  `contractfix` roundtrip test keeps drift caught in CI.

### `apps/node-agent`

- `internal/gitops` — new package, split so porcelain parsing is pure functions
  testable with fixture strings and no git binary, behind a thin exec layer.
- `internal/gateway/changeset.go` — verb handler wrapping the inner handler, the
  same shape as `terminalHandler`.
- `internal/descriptor` — a shared helper adding `changeset` to a capability
  list when the workspace is a repo and git is present.

### `apps/hub`

- `src/routes/station-changeset.ts` — mirrors `station-cleanup.ts`:
  authenticate → ownership via `getStation` → `gateCapability("changeset")` →
  broker → respond. Node offline is 409; other broker errors are 502.
- `src/services/station-registry.ts` — `refreshAdoptedCapabilities`.
- `src/routes/gateway.ts` — call it on node connect.

**Audit `changeset.diff`, not `changeset.status`.** `cleanup.plan` is read-only
and audited, but it is a deliberate click; status is fetched every time a panel
opens and on every refresh, and auditing it would bury the log in noise. The
diff is where source code actually leaves the machine, and that is the event
worth a record.

### `apps/console`

- `lib/components/stations/ChangesetPanel.svelte` — new.
- Station detail page — a tab gated on `capabilities.includes("changeset")`,
  using the existing lazy `visitedHeavyTabs` pattern so nothing is fetched until
  the tab is opened.

The panel leads with the base and the reason it was chosen, then the two
sections; clicking a file fetches that file's patch. Diff rendering reuses
`code-block.svelte` — Shiki already highlights `diff`, so no new dependency.

## Testing

- **Parsers** — fixture-string unit tests, no git binary: porcelain v2 including
  renames, copies and untracked entries; `--numstat` including the `-` markers
  binary files produce.
- **Real git** — temp repositories built with `git init`, covering all four
  base-selection rules, skipping cleanly where git is absent.
- **Invariants** — a test asserting the repository is byte-identical after a
  status and a diff (no index mutation), and one asserting
  `GIT_OPTIONAL_LOCKS=0` is set on invocations.
- **Gateway** — handler dispatch tests.
- **Descriptor** — conditional advertisement, both directions.
- **Hub routes** — the 401/404/403/409/502 ladder, mirroring
  `station-cleanup.test.ts`.
- **Capability refresh (regression)** — adopt a station with an old capability
  list, run a detect returning a new one, assert the row refreshed *and* that no
  new station row was created. This is the bug found by reading rather than by
  running; it should not be able to come back silently.
- **Console** — panel test.

Per repo convention, every one of these is written failing first.

## Known limits

**Windows.** `internal/gitops` will assume POSIX paths. Windows stations are a
separate item in this horizon, and path handling here will need revisiting when
that lands. Recorded now so it is not a discovery then.

**Submodules.** Changes inside a submodule are reported as the submodule pointer
moving, which is what `git` itself reports. No recursion.

**Worktrees.** A station whose workspace is a linked worktree works normally;
no special handling is needed or added.
