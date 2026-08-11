# `changeset` Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator see what an agent has changed in a station's workspace — uncommitted edits, untracked files, and commits not yet on a base — from the console, without SSHing to the machine.

**Architecture:** The node-agent shells out to the station's own `git` (read-only, argv exec, timeout) and answers two new verbs, `changeset.status` and `changeset.diff`. The hub passes them through with the standard auth → ownership → capability-gate ladder. The capability is advertised only when the workspace is a git repo, which requires fixing a latent hub bug where `stations.capabilities` is never refreshed after adoption.

**Tech Stack:** Go 1.26 (node-agent), zod 4 (`packages/contract`), Bun + Hono + Drizzle (hub), Svelte 5 runes + bits-ui (console).

**Spec:** `docs/superpowers/specs/2026-08-11-changeset-capability-design.md`

## Global Constraints

- **Never mutate the repository.** Read-only plumbing only. No `git add`, no `git add -N`, no config writes. This is checked by a test.
- **`GIT_OPTIONAL_LOCKS=0` on every git invocation.** Agents are actively editing these workspaces; `git status` otherwise takes the index lock.
- **Every git call is `exec.CommandContext` with an argv slice and a timeout.** No shell strings.
- **Observe only.** No persistence, no `Change` rows, no delivery, no push, no branch creation.
- **Out of scope:** fleet-wide dirty roll-up, `apn changeset` CLI, Windows support.
- Constants: `MaxFiles = 1000`, `DefaultMaxDiffBytes = 2 << 20`, `MaxDiffBytes = 8 << 20`, `GitTimeout = 20 * time.Second`.
- TDD: every task writes its failing test first. Every bug fix gets a regression test.
- Branch: `changeset-capability` off `main`. Single PR.

## File Structure

**`packages/contract`**
- `src/changeset.ts` *(create)* — the wire shapes. Nothing else.
- `src/changeset.test.ts` *(create)* — schema round-trips.
- `src/station.ts` *(modify)* — add `changeset` to `Capability`.
- `src/protocol.ts` *(modify)* — two `VERB_PARAMS`, two `VERB_RESULTS` entries.
- `src/index.ts` *(modify)* — re-export.
- `scripts/emit-go-fixtures.ts` *(modify)* — a `changeset_status` fixture so Go struct drift fails CI.

**`apps/node-agent`**
- `internal/gitops/parse.go` *(create)* — pure parsers for git's machine-readable output. No exec, no filesystem.
- `internal/gitops/git.go` *(create)* — the exec layer. Owns all three invariants.
- `internal/gitops/base.go` *(create)* — base selection.
- `internal/gitops/status.go` *(create)* — composes parse + git + base into `Status()`.
- `internal/gitops/diff.go` *(create)* — `Diff()`.
- `internal/gateway/changeset.go` *(create)* — verb handler, same shape as `terminalHandler`.
- `internal/descriptor/gitcap.go` *(create)* — `AppendChangesetCap` helper.
- `internal/descriptor/{hermes,openclaw,codex,claudecode,opencode}.go` *(modify)* — use it.
- `cmd/agentpod-node/run.go:105` *(modify)* — wire the handler into the chain.

**`apps/hub`**
- `src/services/station-registry.ts` *(modify)* — `refreshAdoptedCapabilities`.
- `src/routes/gateway.ts:62` *(modify)* — call it on node connect.
- `src/routes/station-changeset.ts` *(create)* — the two routes.
- `src/index.ts` *(modify)* — mount.

**`apps/console`**
- `src/lib/api/client.ts` *(modify)* — two typed fetchers.
- `src/lib/components/stations/ChangesetPanel.svelte` *(create)* — the panel.
- `src/routes/nodes/[id]/stations/[stationId]/+page.svelte` *(modify)* — the gated tab.

---

## Task 1: Contract shapes and verbs

**Files:**
- Create: `packages/contract/src/changeset.ts`
- Create: `packages/contract/src/changeset.test.ts`
- Modify: `packages/contract/src/station.ts:2`
- Modify: `packages/contract/src/protocol.ts:25-73`
- Modify: `packages/contract/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChangesetFileStatus`, `ChangesetFile`, `ChangesetSide`, `ChangesetCommit`, `ChangesetCommittedSide`, `ChangesetBaseReason`, `ChangesetStatus`, `ChangesetDiff`, `ChangesetDiffSide`; `VERB_PARAMS["changeset.status"|"changeset.diff"]`; `VERB_RESULTS["changeset.status"|"changeset.diff"]`; `Capability` now includes `"changeset"`.

- [ ] **Step 1: Write the failing test**

Create `packages/contract/src/changeset.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Capability } from "./station";
import {
  ChangesetStatus,
  ChangesetDiff,
  ChangesetFile,
} from "./changeset";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

test("changeset is a known capability", () => {
  expect(Capability.parse("changeset")).toBe("changeset");
});

test("a renamed file carries its old path", () => {
  const f = ChangesetFile.parse({
    path: "src/new.ts",
    oldPath: "src/old.ts",
    status: "renamed",
    insertions: 3,
    deletions: 1,
    binary: false,
  });
  expect(f.oldPath).toBe("src/old.ts");
});

test("untracked and binary files report null line counts", () => {
  // Untracked files are NOT counted, because counting them would require
  // `git add -N`, which mutates the index of a workspace an agent is using.
  const untracked = ChangesetFile.parse({
    path: "notes.md",
    oldPath: null,
    status: "untracked",
    insertions: null,
    deletions: null,
    binary: false,
  });
  expect(untracked.insertions).toBeNull();

  const binary = ChangesetFile.parse({
    path: "logo.png",
    oldPath: null,
    status: "modified",
    insertions: null,
    deletions: null,
    binary: true,
  });
  expect(binary.binary).toBe(true);
});

test("status keeps uncommitted and committed work separate", () => {
  const s = ChangesetStatus.parse({
    repo: { branch: "feat/x", head: "abc123", detached: false },
    base: { ref: "origin/main", sha: "def456", reason: "upstream" },
    uncommitted: { files: [], insertions: 0, deletions: 0 },
    committed: { files: [], insertions: 0, deletions: 0, commits: [] },
    truncatedFiles: false,
  });
  expect(s.base.reason).toBe("upstream");
  expect(s.committed.commits).toEqual([]);
});

test("a detached head has no branch", () => {
  const s = ChangesetStatus.parse({
    repo: { branch: null, head: "abc123", detached: true },
    base: { ref: "HEAD", sha: "abc123", reason: "head" },
    uncommitted: { files: [], insertions: 0, deletions: 0 },
    committed: { files: [], insertions: 0, deletions: 0, commits: [] },
    truncatedFiles: false,
  });
  expect(s.repo.branch).toBeNull();
});

test("every base reason the node can report is accepted", () => {
  for (const reason of ["explicit", "upstream", "default-branch", "head"]) {
    const s = ChangesetStatus.parse({
      repo: { branch: "main", head: "a", detached: false },
      base: { ref: "x", sha: "y", reason },
      uncommitted: { files: [], insertions: 0, deletions: 0 },
      committed: { files: [], insertions: 0, deletions: 0, commits: [] },
      truncatedFiles: false,
    });
    expect(s.base.reason).toBe(reason as never);
  }
});

test("diff mirrors the fs.read truncation contract", () => {
  const d = ChangesetDiff.parse({ content: "@@ -1 +1 @@", truncated: true, binary: false });
  expect(d.truncated).toBe(true);
});

test("both verbs are registered with params and results", () => {
  expect(VERB_PARAMS["changeset.status"]).toBeDefined();
  expect(VERB_PARAMS["changeset.diff"]).toBeDefined();
  expect(VERB_RESULTS["changeset.status"]).toBeDefined();
  expect(VERB_RESULTS["changeset.diff"]).toBeDefined();

  const p = VERB_PARAMS["changeset.diff"].parse({
    key: "codex:abc",
    side: "uncommitted",
    path: "src/a.ts",
    maxBytes: 4096,
  });
  expect(p.side).toBe("uncommitted");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/contract && bun test src/changeset.test.ts
```

Expected: FAIL — `Cannot find module './changeset'`.

- [ ] **Step 3: Create the schemas**

Create `packages/contract/src/changeset.ts`:

```ts
import { z } from "zod";

/**
 * Wire shapes for the `changeset` capability — an observe-only view of what an
 * agent has changed in a station's workspace.
 *
 * Deliberately not persisted anywhere. The content-addressed change artifact is
 * Horizon 2; this horizon only answers "what does this machine look like right
 * now", which is the question you cannot answer today without an SSH session.
 */

export const ChangesetFileStatus = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "untracked",
]);
export type ChangesetFileStatus = z.infer<typeof ChangesetFileStatus>;

/**
 * One changed path.
 *
 * `insertions`/`deletions` are null in two cases: binary files, which have no
 * meaningful line count, and untracked files, which git will not count without
 * `git add -N` — and that would mutate the index of a workspace an agent may be
 * actively writing to. Their content is still fetchable via `changeset.diff`.
 */
export const ChangesetFile = z.object({
  path: z.string().min(1),
  /** Set for renames and copies only. */
  oldPath: z.string().min(1).nullable(),
  status: ChangesetFileStatus,
  insertions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  binary: z.boolean(),
});
export type ChangesetFile = z.infer<typeof ChangesetFile>;

export const ChangesetSide = z.object({
  files: z.array(ChangesetFile),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type ChangesetSide = z.infer<typeof ChangesetSide>;

export const ChangesetCommit = z.object({
  sha: z.string().min(1),
  shortSha: z.string().min(1),
  subject: z.string(),
  author: z.string(),
  /** ISO-8601 committer date. */
  committedAt: z.string(),
});
export type ChangesetCommit = z.infer<typeof ChangesetCommit>;

export const ChangesetCommittedSide = ChangesetSide.extend({
  commits: z.array(ChangesetCommit),
});
export type ChangesetCommittedSide = z.infer<typeof ChangesetCommittedSide>;

/**
 * Which rule picked the base. Reported rather than inferred: a surprising diff
 * on a machine you are not sitting at is otherwise unexplainable, and "no
 * upstream, so you are seeing uncommitted work only" is a different situation
 * from "diffed against your upstream".
 */
export const ChangesetBaseReason = z.enum([
  "explicit",
  "upstream",
  "default-branch",
  "head",
]);
export type ChangesetBaseReason = z.infer<typeof ChangesetBaseReason>;

/**
 * The base affects only the committed side. `uncommitted` is always the working
 * tree against HEAD, whatever base was selected — changing the base changes
 * which commits count as "not yet on the base"; it cannot change what is
 * currently unsaved on disk.
 */
export const ChangesetStatus = z.object({
  repo: z.object({
    branch: z.string().nullable(),
    head: z.string().nullable(),
    detached: z.boolean(),
  }),
  base: z.object({
    ref: z.string().min(1),
    sha: z.string().min(1),
    reason: ChangesetBaseReason,
  }),
  uncommitted: ChangesetSide,
  committed: ChangesetCommittedSide,
  /** The file list hit its cap. */
  truncatedFiles: z.boolean(),
});
export type ChangesetStatus = z.infer<typeof ChangesetStatus>;

export const ChangesetDiffSide = z.enum(["uncommitted", "committed"]);
export type ChangesetDiffSide = z.infer<typeof ChangesetDiffSide>;

/** Same truncation contract as `fs.read`. */
export const ChangesetDiff = z.object({
  content: z.string(),
  truncated: z.boolean(),
  binary: z.boolean(),
});
export type ChangesetDiff = z.infer<typeof ChangesetDiff>;
```

- [ ] **Step 4: Add the capability**

In `packages/contract/src/station.ts`, change line 2 to:

```ts
export const Capability = z.enum(["inventory","health","logs","fs.read","fs.write","terminal","lifecycle","cleanup","acp","changeset"]);
```

- [ ] **Step 5: Register the verbs**

In `packages/contract/src/protocol.ts`, add to the imports at the top:

```ts
import { ChangesetStatus, ChangesetDiff, ChangesetDiffSide } from "./changeset";
```

Add to `VERB_PARAMS`, after the `acp.close` entry:

```ts
  // base affects the COMMITTED side only; uncommitted is always vs HEAD.
  "changeset.status": z.object({ key: z.string(), base: z.string().optional() }),
  "changeset.diff": z.object({
    key: z.string(),
    base: z.string().optional(),
    /** Omitted means the whole side's patch, subject to maxBytes. */
    path: z.string().optional(),
    side: ChangesetDiffSide,
    maxBytes: z.number().int().positive().optional(),
  }),
```

Add to `VERB_RESULTS`, after the `acp.close` entry:

```ts
  "changeset.status": ChangesetStatus,
  "changeset.diff": ChangesetDiff,
```

- [ ] **Step 6: Re-export**

In `packages/contract/src/index.ts`, add after the `./run` line:

```ts
export * from "./changeset";
```

- [ ] **Step 7: Run the tests**

```bash
cd packages/contract && bun test
```

Expected: PASS, including the pre-existing suites.

- [ ] **Step 8: Add a Go drift fixture**

In `packages/contract/scripts/emit-go-fixtures.ts`, extend the import on line 21 to include `ChangesetStatus`, then append to the `FIXTURES` array:

```ts
  // Exercises every nullable and both sides — catches a Go struct that cannot
  // represent a detached head, a rename, or an uncounted untracked file.
  ["changeset_status", ChangesetStatus, {
    repo: { branch: "feat/agent-work", head: "9f1c2ab", detached: false },
    base: { ref: "origin/main", sha: "3d4e5f6", reason: "upstream" },
    uncommitted: {
      files: [
        { path: "src/a.ts", oldPath: null, status: "modified", insertions: 12, deletions: 3, binary: false },
        { path: "notes.md", oldPath: null, status: "untracked", insertions: null, deletions: null, binary: false },
        { path: "logo.png", oldPath: null, status: "modified", insertions: null, deletions: null, binary: true },
      ],
      insertions: 12,
      deletions: 3,
    },
    committed: {
      files: [
        { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", insertions: 1, deletions: 1, binary: false },
      ],
      insertions: 1,
      deletions: 1,
      commits: [
        { sha: "9f1c2ab0000000000000000000000000000000aa", shortSha: "9f1c2ab", subject: "wire the thing up", author: "codex", committedAt: "2026-08-11T09:15:00Z" },
      ],
    },
    truncatedFiles: false,
  }],
```

- [ ] **Step 9: Emit and verify**

```bash
cd packages/contract && bun run scripts/emit-go-fixtures.ts && bun run scripts/emit-go-fixtures.ts --check
```

Expected: the write succeeds, then `--check` passes (no diff). A new file appears at `apps/node-agent/internal/contractfix/testdata/changeset_status.json`.

Note: the Go round-trip test for this fixture is written in Task 6, once the Go structs exist. `contractfix` iterates only over fixtures it has a struct for, so the suite stays green in between.

- [ ] **Step 10: Commit**

```bash
git add packages/contract apps/node-agent/internal/contractfix/testdata
git commit -m "feat(contract): changeset shapes, verbs and capability"
```

---

## Task 2: Refresh capabilities of adopted stations

This is the latent bug found by reading the code: `stations.capabilities` is written **only** by `adoptStations`. Without this task, `changeset` is advertised correctly by every node and shown by zero existing stations — a failure that looks fine in testing and is invisible in production. `posture`, later this horizon, would hit it identically.

**Files:**
- Modify: `apps/hub/src/services/station-registry.ts`
- Modify: `apps/hub/src/services/station-registry.test.ts`
- Modify: `apps/hub/src/routes/gateway.ts:62-73`

**Interfaces:**
- Consumes: `VERB_RESULTS.detect` from `@agentpod/contract`; `broker.request`.
- Produces: `refreshAdoptedCapabilities(nodeId: string): Promise<number>` — returns the number of station rows updated.

- [ ] **Step 1: Write the failing regression test**

Append to `apps/hub/src/services/station-registry.test.ts`. Match the file's existing setup helpers for creating a user and node — read the top of the file first and reuse them rather than inventing new ones.

```ts
import { refreshAdoptedCapabilities } from "./station-registry";
import * as broker from "./broker";

test("refresh updates capabilities on an already-adopted station", async () => {
  // The bug this guards: capabilities were written only at adoption, so a
  // station adopted before a capability existed never gained it, however many
  // times the node reported it.
  const { userId, nodeId } = await seedUserAndNode();
  await adoptStations(userId, nodeId, ["codex:x"], [
    {
      key: "codex:x", harness: "codex", kind: "leaf", displayName: "old name",
      parentKey: null, workspacePath: "/old", capabilities: ["health"], adopted: false,
    },
  ]);

  const spy = spyOn(broker, "request").mockResolvedValue({
    ok: true,
    data: [
      {
        key: "codex:x", harness: "codex", kind: "leaf", displayName: "new name",
        parentKey: null, workspacePath: "/new", capabilities: ["health", "changeset"],
      },
    ],
  });

  const updated = await refreshAdoptedCapabilities(nodeId);
  expect(updated).toBe(1);

  const row = await db.query.stations.findFirst({
    where: (s, { eq, and }) => and(eq(s.nodeId, nodeId), eq(s.stationKey, "codex:x")),
  });
  expect(row?.capabilities).toEqual(["health", "changeset"]);
  expect(row?.displayName).toBe("new name");
  expect(row?.workspacePath).toBe("/new");
  spy.mockRestore();
});

test("refresh never adopts a station on its own", async () => {
  // Adoption stays an explicit act. If this ever inserts, every station a node
  // can see silently joins the fleet.
  const { userId, nodeId } = await seedUserAndNode();
  await adoptStations(userId, nodeId, ["codex:x"], [
    {
      key: "codex:x", harness: "codex", kind: "leaf", displayName: "kept",
      parentKey: null, workspacePath: null, capabilities: ["health"], adopted: false,
    },
  ]);

  const spy = spyOn(broker, "request").mockResolvedValue({
    ok: true,
    data: [
      { key: "codex:x", harness: "codex", kind: "leaf", displayName: "kept", parentKey: null, workspacePath: null, capabilities: ["health"] },
      { key: "hermes:never-adopted", harness: "hermes", kind: "leaf", displayName: "nope", parentKey: null, workspacePath: null, capabilities: ["health", "changeset"] },
    ],
  });

  await refreshAdoptedCapabilities(nodeId);

  const rows = await db.query.stations.findMany({ where: (s, { eq }) => eq(s.nodeId, nodeId) });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.stationKey).toBe("codex:x");
  spy.mockRestore();
});

test("refresh is quiet when the node cannot answer", async () => {
  // Runs on every node connect. A node that fails detect must not throw into
  // the gateway's connect path.
  const { nodeId } = await seedUserAndNode();
  const spy = spyOn(broker, "request").mockResolvedValue({ ok: false, error: "node offline" });
  await expect(refreshAdoptedCapabilities(nodeId)).resolves.toBe(0);
  spy.mockRestore();
});

test("refresh ignores a detect response that does not match the contract", async () => {
  const { nodeId } = await seedUserAndNode();
  const spy = spyOn(broker, "request").mockResolvedValue({ ok: true, data: { not: "an array" } });
  await expect(refreshAdoptedCapabilities(nodeId)).resolves.toBe(0);
  spy.mockRestore();
});
```

Add `spyOn` to the `bun:test` import at the top of the file if it is not already there.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/station-registry.test.ts
```

Expected: FAIL — `refreshAdoptedCapabilities` is not exported.

If the run errors on connection instead, the test database is not up. Start it:

```bash
docker run -d --name agentpod-test-postgres -e POSTGRES_USER=agentpod -e POSTGRES_PASSWORD=agentpod-dev-password -e POSTGRES_DB=agentpod -p 5434:5432 pgvector/pgvector:pg16
```

- [ ] **Step 3: Implement it**

Append to `apps/hub/src/services/station-registry.ts` (add `and`/`eq` to the existing `drizzle-orm` import and `VERB_RESULTS` to the contract import if absent):

```ts
/**
 * Re-read a node's capabilities into the stations already adopted from it.
 *
 * `adoptStations` was the only writer of `stations.capabilities`, so a station
 * adopted before a capability existed could never gain it — the node reported
 * it on every detect and the hub kept serving the row it stored at adoption.
 * Any new capability hits this, which is why the fix lives here rather than in
 * the feature that found it.
 *
 * Updates existing (nodeId, stationKey) rows ONLY. It must never insert:
 * adoption is an explicit act, and an auto-inserting refresh would quietly
 * adopt everything a node can see.
 *
 * Returns the number of rows updated. Never throws — it runs on node connect.
 */
export async function refreshAdoptedCapabilities(nodeId: string): Promise<number> {
  let detected: unknown;
  try {
    const r = await broker.request(nodeId, "detect", {}, { timeoutMs: 10_000 });
    if (!r.ok) return 0;
    detected = r.data;
  } catch {
    return 0;
  }

  const parsed = VERB_RESULTS.detect.safeParse(detected);
  if (!parsed.success) return 0;

  const existing = await db
    .select({ stationKey: stations.stationKey })
    .from(stations)
    .where(eq(stations.nodeId, nodeId));
  const adopted = new Set(existing.map((r) => r.stationKey));

  let updated = 0;
  for (const s of parsed.data) {
    if (!adopted.has(s.key)) continue; // never insert
    await db
      .update(stations)
      .set({
        capabilities: s.capabilities as string[],
        displayName: s.displayName,
        workspacePath: s.workspacePath ?? null,
      })
      .where(and(eq(stations.nodeId, nodeId), eq(stations.stationKey, s.key)));
    updated++;
  }
  return updated;
}
```

Add the import for the broker at the top of the file if it is not already present:

```ts
import * as broker from "./broker";
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/services/station-registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Call it on node connect**

In `apps/hub/src/routes/gateway.ts`, add to the imports:

```ts
import { refreshAdoptedCapabilities } from "../services/station-registry";
```

Then, immediately after the existing `void (async () => { ... })()` auto-adopt block that ends around line 73, add:

```ts
        // Re-read capabilities into already-adopted stations. A node that has
        // just updated may advertise capabilities its stored rows predate, and
        // nothing else in the hub ever refreshes that column.
        // Fire-and-forget: it must never block or throw into the gateway.
        void (async () => {
          await new Promise((res) => setTimeout(res, 2000));
          try {
            await refreshAdoptedCapabilities(nodeId);
          } catch {
            // refreshAdoptedCapabilities never throws, but guard anyway.
          }
        })();
```

- [ ] **Step 6: Run the whole hub suite**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/services/station-registry.ts apps/hub/src/services/station-registry.test.ts apps/hub/src/routes/gateway.ts
git commit -m "fix(hub): refresh adopted stations' capabilities on node connect"
```

---

## Task 3: Pure parsers for git's machine-readable output

All parsing is separated from all exec so it can be tested exhaustively against fixture strings with no git binary and no repository. This is where the fiddly format handling lives.

**Files:**
- Create: `apps/node-agent/internal/gitops/parse.go`
- Create: `apps/node-agent/internal/gitops/parse_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FileStatus string` with constants `StatusAdded`, `StatusModified`, `StatusDeleted`, `StatusRenamed`, `StatusCopied`, `StatusTypeChanged`, `StatusUntracked`
  - `type File struct { Path string; OldPath *string; Status FileStatus; Insertions *int; Deletions *int; Binary bool }`
  - `type Commit struct { SHA, ShortSHA, Subject, Author, CommittedAt string }`
  - `type PorcelainStatus struct { Branch, Head, Upstream string; Detached bool; Files []File }`
  - `type NumStat struct { Insertions, Deletions int; Binary bool }`
  - `func ParsePorcelainV2(data []byte) (PorcelainStatus, error)`
  - `func ParseNumstatZ(data []byte) (map[string]NumStat, error)`
  - `func ParseNameStatusZ(data []byte) ([]File, error)`
  - `func ParseCommitsZ(data []byte) ([]Commit, error)`

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gitops/parse_test.go`:

```go
package gitops

import "testing"

// Real `git status --porcelain=v2 --branch -z --untracked-files=all` output,
// with NULs written explicitly. Records are NUL-terminated; a type-2 (rename)
// record is followed by a SECOND NUL-terminated field holding the old path,
// which is the trap in this format.
const porcelainZ = "# branch.oid 9f1c2ab\x00" +
	"# branch.head feat/agent-work\x00" +
	"# branch.upstream origin/feat/agent-work\x00" +
	"# branch.ab +2 -0\x00" +
	"1 .M N... 100644 100644 100644 aaa bbb src/a.ts\x00" +
	"1 A. N... 000000 100644 100644 000 ccc src/added.ts\x00" +
	"1 .D N... 100644 100644 000000 ddd ddd src/gone.ts\x00" +
	"2 R. N... 100644 100644 100644 eee eee R100 src/new.ts\x00src/old.ts\x00" +
	"? notes with spaces.md\x00" +
	"? build/out.bin\x00"

func TestParsePorcelainReadsTheBranch(t *testing.T) {
	got, err := ParsePorcelainV2([]byte(porcelainZ))
	if err != nil {
		t.Fatalf("ParsePorcelainV2: %v", err)
	}
	if got.Branch != "feat/agent-work" {
		t.Errorf("Branch = %q, want feat/agent-work", got.Branch)
	}
	if got.Head != "9f1c2ab" {
		t.Errorf("Head = %q, want 9f1c2ab", got.Head)
	}
	if got.Upstream != "origin/feat/agent-work" {
		t.Errorf("Upstream = %q", got.Upstream)
	}
	if got.Detached {
		t.Error("Detached should be false on a named branch")
	}
}

func TestParsePorcelainDetachedHead(t *testing.T) {
	// git reports the literal "(detached)" as branch.head.
	in := "# branch.oid 9f1c2ab\x00# branch.head (detached)\x00"
	got, err := ParsePorcelainV2([]byte(in))
	if err != nil {
		t.Fatalf("ParsePorcelainV2: %v", err)
	}
	if !got.Detached {
		t.Error("Detached should be true")
	}
	if got.Branch != "" {
		t.Errorf("Branch = %q, want empty on a detached head", got.Branch)
	}
}

func TestParsePorcelainMapsEachStatusCode(t *testing.T) {
	got, _ := ParsePorcelainV2([]byte(porcelainZ))
	want := map[string]FileStatus{
		"src/a.ts":              StatusModified,
		"src/added.ts":          StatusAdded,
		"src/gone.ts":           StatusDeleted,
		"src/new.ts":            StatusRenamed,
		"notes with spaces.md":  StatusUntracked,
		"build/out.bin":         StatusUntracked,
	}
	if len(got.Files) != len(want) {
		t.Fatalf("parsed %d files, want %d: %+v", len(got.Files), len(want), got.Files)
	}
	for _, f := range got.Files {
		w, ok := want[f.Path]
		if !ok {
			t.Errorf("unexpected path %q", f.Path)
			continue
		}
		if f.Status != w {
			t.Errorf("%s status = %q, want %q", f.Path, f.Status, w)
		}
	}
}

func TestParsePorcelainKeepsTheOldPathOfARename(t *testing.T) {
	// The rename record's second NUL-terminated field is the old path. Reading
	// it as the next record is the classic bug: it invents a phantom file and
	// loses the rename.
	got, _ := ParsePorcelainV2([]byte(porcelainZ))
	for _, f := range got.Files {
		if f.Path == "src/new.ts" {
			if f.OldPath == nil || *f.OldPath != "src/old.ts" {
				t.Fatalf("OldPath = %v, want src/old.ts", f.OldPath)
			}
			return
		}
	}
	t.Fatal("renamed file not found")
}

func TestParsePorcelainUntrackedFilesAreUncounted(t *testing.T) {
	// Counting them needs `git add -N`, which writes to the index of a
	// workspace an agent may be using. Null is the honest answer.
	got, _ := ParsePorcelainV2([]byte(porcelainZ))
	for _, f := range got.Files {
		if f.Status == StatusUntracked && (f.Insertions != nil || f.Deletions != nil) {
			t.Errorf("%s carries line counts; untracked files must not", f.Path)
		}
	}
}

func TestParsePorcelainSkipsIgnoredEntries(t *testing.T) {
	in := "! node_modules/\x00? real.ts\x00"
	got, _ := ParsePorcelainV2([]byte(in))
	if len(got.Files) != 1 || got.Files[0].Path != "real.ts" {
		t.Errorf("ignored entries leaked into the file list: %+v", got.Files)
	}
}

func TestParsePorcelainEmptyInput(t *testing.T) {
	got, err := ParsePorcelainV2(nil)
	if err != nil {
		t.Fatalf("empty input should not error: %v", err)
	}
	if len(got.Files) != 0 {
		t.Errorf("want no files, got %+v", got.Files)
	}
}

func TestParseNumstatCountsLines(t *testing.T) {
	in := "12\t3\tsrc/a.ts\x00"
	got, err := ParseNumstatZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseNumstatZ: %v", err)
	}
	if got["src/a.ts"].Insertions != 12 || got["src/a.ts"].Deletions != 3 {
		t.Errorf("got %+v", got["src/a.ts"])
	}
}

func TestParseNumstatMarksBinary(t *testing.T) {
	// git writes "-" for both counts on a binary file.
	in := "-\t-\tlogo.png\x00"
	got, _ := ParseNumstatZ([]byte(in))
	if !got["logo.png"].Binary {
		t.Error("logo.png should be marked binary")
	}
}

func TestParseNumstatRenameUsesTwoExtraFields(t *testing.T) {
	// For a rename with -z, the path field is EMPTY and the old and new paths
	// follow as two separate NUL-terminated fields, in that order.
	in := "1\t1\t\x00src/old.ts\x00src/new.ts\x00"
	got, err := ParseNumstatZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseNumstatZ: %v", err)
	}
	if _, ok := got["src/new.ts"]; !ok {
		t.Fatalf("rename should be keyed by the NEW path, got %+v", got)
	}
	if got["src/new.ts"].Insertions != 1 {
		t.Errorf("got %+v", got["src/new.ts"])
	}
}

func TestParseNameStatusZ(t *testing.T) {
	// `git diff --name-status -z`: status field, then path(s), each NUL-terminated.
	in := "M\x00src/a.ts\x00A\x00src/b.ts\x00D\x00src/c.ts\x00R100\x00src/old.ts\x00src/new.ts\x00T\x00src/link\x00"
	got, err := ParseNameStatusZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseNameStatusZ: %v", err)
	}
	if len(got) != 5 {
		t.Fatalf("parsed %d files, want 5: %+v", len(got), got)
	}
	want := []struct {
		path   string
		status FileStatus
	}{
		{"src/a.ts", StatusModified},
		{"src/b.ts", StatusAdded},
		{"src/c.ts", StatusDeleted},
		{"src/new.ts", StatusRenamed},
		{"src/link", StatusTypeChanged},
	}
	for i, w := range want {
		if got[i].Path != w.path || got[i].Status != w.status {
			t.Errorf("[%d] = %s/%s, want %s/%s", i, got[i].Path, got[i].Status, w.path, w.status)
		}
	}
	if got[3].OldPath == nil || *got[3].OldPath != "src/old.ts" {
		t.Errorf("rename OldPath = %v", got[3].OldPath)
	}
}

func TestParseCommitsZ(t *testing.T) {
	// --format uses %x1f between fields; -z puts a NUL between commits.
	in := "9f1c2ab0000000000000000000000000000000aa\x1f9f1c2ab\x1fwire the thing up\x1fcodex\x1f2026-08-11T09:15:00Z\x00" +
		"1111111000000000000000000000000000000bb\x1f1111111\x1ffix: subject with, punctuation\x1fRakesh\x1f2026-08-10T22:01:00Z\x00"
	got, err := ParseCommitsZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseCommitsZ: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("parsed %d commits, want 2", len(got))
	}
	if got[0].ShortSHA != "9f1c2ab" || got[0].Subject != "wire the thing up" || got[0].Author != "codex" {
		t.Errorf("got %+v", got[0])
	}
	if got[1].Subject != "fix: subject with, punctuation" {
		t.Errorf("subject mangled: %q", got[1].Subject)
	}
}

func TestParseCommitsZEmpty(t *testing.T) {
	got, err := ParseCommitsZ(nil)
	if err != nil {
		t.Fatalf("empty input should not error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("want none, got %+v", got)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gitops/
```

Expected: build failure — the package does not exist.

- [ ] **Step 3: Write the parsers**

Create `apps/node-agent/internal/gitops/parse.go`:

```go
// Package gitops answers "what has changed in this workspace" by shelling out
// to the station's own git.
//
// The station's git is used rather than a Go reimplementation so the answer
// matches exactly what someone would see if they SSH'd in — same .gitattributes,
// same filters, same submodule config. The whole value of the capability is
// trusting what you are shown about a machine you are not on.
//
// This file is pure: parsing only, no exec and no filesystem, so every format
// edge can be tested against a fixture string.
package gitops

import (
	"fmt"
	"strconv"
	"strings"
)

type FileStatus string

const (
	StatusAdded       FileStatus = "added"
	StatusModified    FileStatus = "modified"
	StatusDeleted     FileStatus = "deleted"
	StatusRenamed     FileStatus = "renamed"
	StatusCopied      FileStatus = "copied"
	StatusTypeChanged FileStatus = "type-changed"
	StatusUntracked   FileStatus = "untracked"
)

// File is one changed path. Insertions/Deletions are nil for binary files and
// for untracked files (see ParsePorcelainV2).
type File struct {
	Path       string     `json:"path"`
	OldPath    *string    `json:"oldPath"`
	Status     FileStatus `json:"status"`
	Insertions *int       `json:"insertions"`
	Deletions  *int       `json:"deletions"`
	Binary     bool       `json:"binary"`
}

type Commit struct {
	SHA         string `json:"sha"`
	ShortSHA    string `json:"shortSha"`
	Subject     string `json:"subject"`
	Author      string `json:"author"`
	CommittedAt string `json:"committedAt"`
}

type PorcelainStatus struct {
	Branch   string // empty when detached
	Head     string
	Upstream string // empty when the branch tracks nothing
	Detached bool
	Files    []File
}

type NumStat struct {
	Insertions int
	Deletions  int
	Binary     bool
}

// splitZ splits NUL-terminated fields, dropping the empty tail.
func splitZ(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	parts := strings.Split(string(data), "\x00")
	if n := len(parts); n > 0 && parts[n-1] == "" {
		parts = parts[:n-1]
	}
	return parts
}

// statusFromXY maps porcelain v2's two-character staged/worktree code.
//
// The staged column is consulted first: for "AM" (added then modified) the
// change relative to HEAD is an addition, and calling it a modification would
// be wrong.
func statusFromXY(xy string) FileStatus {
	if len(xy) < 2 {
		return StatusModified
	}
	for _, c := range []byte{xy[0], xy[1]} {
		switch c {
		case 'A':
			return StatusAdded
		case 'D':
			return StatusDeleted
		case 'R':
			return StatusRenamed
		case 'C':
			return StatusCopied
		case 'T':
			return StatusTypeChanged
		case 'M':
			return StatusModified
		}
	}
	return StatusModified
}

// ParsePorcelainV2 parses `git status --porcelain=v2 --branch -z
// --untracked-files=all`.
//
// Untracked files are returned with nil line counts. Counting them would
// require `git add -N`, which writes to the index of a workspace an agent may
// be actively using; this capability never mutates the repository.
//
// The format trap: a type-2 (rename/copy) record is followed by a SECOND
// NUL-terminated field holding the old path. Treating it as the next record
// invents a phantom file and loses the rename.
func ParsePorcelainV2(data []byte) (PorcelainStatus, error) {
	var st PorcelainStatus
	fields := splitZ(data)

	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		if rec == "" {
			continue
		}
		switch {
		case strings.HasPrefix(rec, "# branch.oid "):
			st.Head = strings.TrimPrefix(rec, "# branch.oid ")

		case strings.HasPrefix(rec, "# branch.head "):
			h := strings.TrimPrefix(rec, "# branch.head ")
			if h == "(detached)" {
				st.Detached = true
			} else {
				st.Branch = h
			}

		case strings.HasPrefix(rec, "# branch.upstream "):
			st.Upstream = strings.TrimPrefix(rec, "# branch.upstream ")

		case strings.HasPrefix(rec, "#"):
			// Other headers (branch.ab, stash) carry nothing we need.

		case strings.HasPrefix(rec, "1 "):
			parts := strings.SplitN(rec, " ", 9)
			if len(parts) < 9 {
				continue
			}
			st.Files = append(st.Files, File{
				Path:   parts[8],
				Status: statusFromXY(parts[1]),
			})

		case strings.HasPrefix(rec, "2 "):
			// "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>", then the
			// old path as the next NUL-terminated field.
			parts := strings.SplitN(rec, " ", 10)
			if len(parts) < 10 {
				continue
			}
			f := File{Path: parts[9], Status: statusFromXY(parts[1])}
			if i+1 < len(fields) {
				old := fields[i+1]
				f.OldPath = &old
				i++ // consume it — this is the trap
			}
			st.Files = append(st.Files, f)

		case strings.HasPrefix(rec, "u "):
			parts := strings.SplitN(rec, " ", 11)
			if len(parts) < 11 {
				continue
			}
			st.Files = append(st.Files, File{Path: parts[10], Status: StatusModified})

		case strings.HasPrefix(rec, "? "):
			st.Files = append(st.Files, File{
				Path:   strings.TrimPrefix(rec, "? "),
				Status: StatusUntracked,
			})

		case strings.HasPrefix(rec, "! "):
			// Ignored. Never shown — it is noise, not change.
		}
	}
	return st, nil
}

// ParseNumstatZ parses `git diff --numstat -z`, keyed by path (the NEW path for
// renames).
//
// Two format quirks: binary files carry "-" for both counts, and a rename
// leaves the path field EMPTY and follows the record with the old and new paths
// as two separate NUL-terminated fields, in that order.
func ParseNumstatZ(data []byte) (map[string]NumStat, error) {
	out := make(map[string]NumStat)
	fields := splitZ(data)

	for i := 0; i < len(fields); i++ {
		rec := fields[i]
		if rec == "" {
			continue
		}
		cols := strings.SplitN(rec, "\t", 3)
		if len(cols) < 3 {
			continue
		}

		var ns NumStat
		if cols[0] == "-" || cols[1] == "-" {
			ns.Binary = true
		} else {
			ins, err := strconv.Atoi(cols[0])
			if err != nil {
				return nil, fmt.Errorf("numstat: bad insertion count %q", cols[0])
			}
			del, err := strconv.Atoi(cols[1])
			if err != nil {
				return nil, fmt.Errorf("numstat: bad deletion count %q", cols[1])
			}
			ns.Insertions, ns.Deletions = ins, del
		}

		path := cols[2]
		if path == "" {
			// Rename: old path, then new path, as the next two fields.
			if i+2 < len(fields) {
				path = fields[i+2]
				i += 2
			} else {
				continue
			}
		}
		out[path] = ns
	}
	return out, nil
}

// statusFromNameStatus maps a --name-status letter, which may carry a similarity
// score ("R100").
func statusFromNameStatus(code string) FileStatus {
	if code == "" {
		return StatusModified
	}
	switch code[0] {
	case 'A':
		return StatusAdded
	case 'D':
		return StatusDeleted
	case 'R':
		return StatusRenamed
	case 'C':
		return StatusCopied
	case 'T':
		return StatusTypeChanged
	default:
		return StatusModified
	}
}

// ParseNameStatusZ parses `git diff --name-status -z`: a status field, then one
// path — or two, old then new, for renames and copies.
func ParseNameStatusZ(data []byte) ([]File, error) {
	var out []File
	fields := splitZ(data)

	for i := 0; i < len(fields); i++ {
		code := fields[i]
		if code == "" {
			continue
		}
		status := statusFromNameStatus(code)

		if status == StatusRenamed || status == StatusCopied {
			if i+2 >= len(fields) {
				break
			}
			old := fields[i+1]
			out = append(out, File{Path: fields[i+2], OldPath: &old, Status: status})
			i += 2
			continue
		}

		if i+1 >= len(fields) {
			break
		}
		out = append(out, File{Path: fields[i+1], Status: status})
		i++
	}
	return out, nil
}

// ParseCommitsZ parses `git log -z --format=%H%x1f%h%x1f%s%x1f%an%x1f%cI`.
//
// %x1f (unit separator) delimits fields because a commit subject can contain
// anything except NUL — including tabs, commas and newlines.
func ParseCommitsZ(data []byte) ([]Commit, error) {
	var out []Commit
	for _, rec := range splitZ(data) {
		rec = strings.Trim(rec, "\n")
		if rec == "" {
			continue
		}
		cols := strings.Split(rec, "\x1f")
		if len(cols) < 5 {
			continue
		}
		out = append(out, Commit{
			SHA:         cols[0],
			ShortSHA:    cols[1],
			Subject:     cols[2],
			Author:      cols[3],
			CommittedAt: cols[4],
		})
	}
	return out, nil
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/gitops/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/gitops
git commit -m "feat(node-agent): pure parsers for git porcelain, numstat and log"
```

---

## Task 4: The exec layer and its invariants

**Files:**
- Create: `apps/node-agent/internal/gitops/git.go`
- Create: `apps/node-agent/internal/gitops/git_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `const GitTimeout = 20 * time.Second`
  - `func gitEnv() []string`
  - `func run(ctx context.Context, dir string, args ...string) ([]byte, error)`
  - `func runAllowExit1(ctx context.Context, dir string, args ...string) ([]byte, error)`
  - `func IsRepo(ctx context.Context, dir string) bool`
  - `var ErrNotARepo = errors.New(...)`

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gitops/git_test.go`:

```go
package gitops

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

// gitRepo builds a throwaway repository and returns its path. Tests that need
// real git skip cleanly where it is absent — CI has it, a minimal container
// might not.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"config", "commit.gpgsign", "false"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

func gitDo(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGitEnvDisablesOptionalLocks(t *testing.T) {
	// Without this, `git status` takes the index lock to refresh it — on
	// workspaces where an agent is actively editing. The contention it causes
	// is rare and its cause is a long way from its symptom.
	if !slices.Contains(gitEnv(), "GIT_OPTIONAL_LOCKS=0") {
		t.Errorf("GIT_OPTIONAL_LOCKS=0 missing from %v", gitEnv())
	}
}

func TestGitEnvIsNonInteractive(t *testing.T) {
	// A git that can prompt is a git that can hang a gateway handler forever.
	env := gitEnv()
	if !slices.Contains(env, "GIT_TERMINAL_PROMPT=0") {
		t.Errorf("GIT_TERMINAL_PROMPT=0 missing from %v", env)
	}
}

func TestRunReturnsOutput(t *testing.T) {
	dir := gitRepo(t)
	out, err := run(t.Context(), dir, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if string(out) != "true\n" {
		t.Errorf("out = %q", out)
	}
}

func TestRunSurfacesGitStderr(t *testing.T) {
	dir := gitRepo(t)
	_, err := run(t.Context(), dir, "rev-parse", "--verify", "definitely-not-a-ref")
	if err == nil {
		t.Fatal("want an error for an unknown ref")
	}
}

func TestRunHonoursACancelledContext(t *testing.T) {
	dir := gitRepo(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := run(ctx, dir, "status"); err == nil {
		t.Fatal("want an error on a cancelled context")
	}
}

func TestRunAllowExit1TreatsOneAsSuccess(t *testing.T) {
	// `git diff --no-index` exits 1 when the files differ, which is the normal
	// case for showing an untracked file's content, not a failure.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "hello\n")
	out, err := runAllowExit1(t.Context(), dir, "diff", "--no-index", "--", os.DevNull, "a.txt")
	if err != nil {
		t.Fatalf("runAllowExit1: %v", err)
	}
	if len(out) == 0 {
		t.Error("want a patch for a new file")
	}
}

func TestIsRepo(t *testing.T) {
	dir := gitRepo(t)
	if !IsRepo(t.Context(), dir) {
		t.Error("a git repo should be recognised")
	}
	if IsRepo(t.Context(), t.TempDir()) {
		t.Error("a plain directory is not a repo")
	}
}

func TestIsRepoOnAMissingDirectory(t *testing.T) {
	if IsRepo(t.Context(), filepath.Join(t.TempDir(), "nope")) {
		t.Error("a missing directory is not a repo")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gitops/
```

Expected: FAIL — `undefined: gitEnv`, `undefined: run`, and so on.

- [ ] **Step 3: Write the exec layer**

Create `apps/node-agent/internal/gitops/git.go`:

```go
package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// GitTimeout bounds every git invocation. A huge repository or a stalled
// network mount must not pin a gateway handler goroutine forever.
const GitTimeout = 20 * time.Second

// ErrNotARepo is returned when a station's workspace is not a git repository.
var ErrNotARepo = errors.New("workspace is not a git repository")

// gitEnv builds the environment for every git call.
//
// GIT_OPTIONAL_LOCKS=0 is the important one: `git status` otherwise takes the
// index lock in order to refresh it, and these are workspaces with agents
// actively editing files. Our read would intermittently contend with the
// agent's own git operations.
//
// GIT_TERMINAL_PROMPT=0 and the askpass settings keep git from ever waiting on
// input we cannot supply.
func gitEnv() []string {
	return append(os.Environ(),
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"SSH_ASKPASS=",
		"GCM_INTERACTIVE=never",
		"LC_ALL=C",
	)
}

// run executes git in dir and returns stdout.
//
// argv only — never a shell string. Everything this package runs is read-only
// plumbing: no `git add`, no `git add -N`, no config writes. The repository is
// never mutated.
func run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, _, err := runCode(ctx, dir, args...)
	return out, err
}

// runAllowExit1 is run for commands where exit code 1 is a normal result rather
// than a failure — `git diff --no-index` exits 1 whenever the files differ.
func runAllowExit1(ctx context.Context, dir string, args ...string) ([]byte, error) {
	out, code, err := runCode(ctx, dir, args...)
	if err != nil && code == 1 {
		return out, nil
	}
	return out, err
}

func runCode(ctx context.Context, dir string, args ...string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, GitTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = gitEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	code := cmd.ProcessState.ExitCode()

	if err != nil {
		if ctx.Err() != nil {
			return stdout.Bytes(), code, fmt.Errorf("git %s: %w", args[0], ctx.Err())
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), code, fmt.Errorf("git %s: %s", args[0], msg)
	}
	return stdout.Bytes(), code, nil
}

// IsRepo reports whether dir sits inside a git work tree and git is usable.
//
// Used to decide whether a station advertises the changeset capability at all,
// so it answers false rather than erroring for every reason it might fail.
func IsRepo(ctx context.Context, dir string) bool {
	if dir == "" {
		return false
	}
	if _, err := exec.LookPath("git"); err != nil {
		return false
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return false
	}
	out, err := run(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(string(out)) == "true"
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/gitops/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/gitops
git commit -m "feat(node-agent): read-only git exec layer with locks disabled and a timeout"
```

---

## Task 5: Base selection

**Files:**
- Create: `apps/node-agent/internal/gitops/base.go`
- Create: `apps/node-agent/internal/gitops/base_test.go`

**Interfaces:**
- Consumes: `run`, `gitRepo`/`gitDo`/`write` test helpers from Task 4.
- Produces:
  - `type Base struct { Ref string; SHA string; Reason string }`
  - `func SelectBase(ctx context.Context, dir string, explicit string) (Base, error)`

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gitops/base_test.go`:

```go
package gitops

import (
	"os/exec"
	"strings"
	"testing"
)

func headSHA(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("rev-parse HEAD: %v", err)
	}
	return strings.TrimSpace(string(out))
}

func TestSelectBaseExplicitWins(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	first := headSHA(t, dir)
	write(t, dir, "a.txt", "two\n")
	gitDo(t, dir, "commit", "-qam", "second")

	got, err := SelectBase(t.Context(), dir, first)
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "explicit" {
		t.Errorf("Reason = %q, want explicit", got.Reason)
	}
	if got.SHA != first {
		t.Errorf("SHA = %q, want %q", got.SHA, first)
	}
}

func TestSelectBaseFallsBackToHead(t *testing.T) {
	// No upstream, no origin: the only honest base is HEAD, and the committed
	// side is then empty by construction.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "head" {
		t.Errorf("Reason = %q, want head", got.Reason)
	}
	if got.SHA != headSHA(t, dir) {
		t.Errorf("SHA = %q, want HEAD", got.SHA)
	}
}

func TestSelectBasePrefersTheUpstream(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)

	// A local "remote" is enough: an upstream is just a ref plus config.
	gitDo(t, dir, "update-ref", "refs/remotes/origin/main", base)
	gitDo(t, dir, "config", "branch.main.remote", "origin")
	gitDo(t, dir, "config", "branch.main.merge", "refs/heads/main")

	write(t, dir, "a.txt", "two\n")
	gitDo(t, dir, "commit", "-qam", "second")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "upstream" {
		t.Errorf("Reason = %q, want upstream", got.Reason)
	}
	if got.Ref != "origin/main" {
		t.Errorf("Ref = %q, want origin/main", got.Ref)
	}
	if got.SHA != base {
		t.Errorf("SHA = %q, want the first commit", got.SHA)
	}
}

func TestSelectBaseUsesTheDefaultBranchWhenThereIsNoUpstream(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)

	gitDo(t, dir, "update-ref", "refs/remotes/origin/main", base)
	gitDo(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	// A branch with NO tracking config.
	gitDo(t, dir, "checkout", "-q", "-b", "feat/x")
	write(t, dir, "b.txt", "new\n")
	gitDo(t, dir, "add", "b.txt")
	gitDo(t, dir, "commit", "-qm", "work")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.Reason != "default-branch" {
		t.Errorf("Reason = %q, want default-branch", got.Reason)
	}
	if got.SHA != base {
		t.Errorf("SHA = %q, want the merge base", got.SHA)
	}
}

func TestSelectBaseResolvesToTheMergeBase(t *testing.T) {
	// The base must be the fork point, not the tip. Otherwise commits made on
	// the base after the branch diverged appear as reversed changes on the
	// station's side — work it never did.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	fork := headSHA(t, dir)

	gitDo(t, dir, "checkout", "-q", "-b", "feat/x")
	write(t, dir, "b.txt", "branch work\n")
	gitDo(t, dir, "add", "b.txt")
	gitDo(t, dir, "commit", "-qm", "branch work")

	gitDo(t, dir, "checkout", "-q", "main")
	write(t, dir, "c.txt", "main moved on\n")
	gitDo(t, dir, "add", "c.txt")
	gitDo(t, dir, "commit", "-qm", "main moved on")
	gitDo(t, dir, "update-ref", "refs/remotes/origin/main", headSHA(t, dir))
	gitDo(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	gitDo(t, dir, "checkout", "-q", "feat/x")

	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("SelectBase: %v", err)
	}
	if got.SHA != fork {
		t.Errorf("SHA = %q, want the fork point %q", got.SHA, fork)
	}
}

func TestSelectBaseOnARepoWithNoCommits(t *testing.T) {
	// A freshly-initialised workspace is a normal state for a new station, not
	// an error. Everything in it is untracked, so uncommitted still works.
	dir := gitRepo(t)
	got, err := SelectBase(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("an empty repo must not error: %v", err)
	}
	if got.Reason != "head" {
		t.Errorf("Reason = %q, want head", got.Reason)
	}
	if got.SHA != "" {
		t.Errorf("SHA = %q, want empty on an unborn HEAD", got.SHA)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gitops/ -run TestSelectBase
```

Expected: FAIL — `undefined: SelectBase`.

- [ ] **Step 3: Implement base selection**

Create `apps/node-agent/internal/gitops/base.go`:

```go
package gitops

import (
	"context"
	"strings"
)

// Base is the commit the committed side is measured against.
type Base struct {
	Ref    string `json:"ref"`
	SHA    string `json:"sha"`
	Reason string `json:"reason"` // explicit | upstream | default-branch | head
}

// SelectBase picks the base, first rule wins:
//
//	explicit        the caller passed one
//	upstream        the branch tracks something
//	default-branch  origin/HEAD resolves
//	head            nothing else did; the committed side is then empty
//
// The chosen ref is always resolved to its MERGE BASE with HEAD. Using the tip
// would show commits made on the base after the branch diverged as reversed
// changes on the station's side — work it never did.
//
// The reason is returned, not just the ref. A surprising diff on a machine you
// are not sitting at is otherwise unexplainable.
func SelectBase(ctx context.Context, dir string, explicit string) (Base, error) {
	ref, reason := "", ""

	switch {
	case explicit != "":
		ref, reason = explicit, "explicit"

	default:
		if out, err := run(ctx, dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
			if u := strings.TrimSpace(string(out)); u != "" {
				ref, reason = u, "upstream"
			}
		}
		if ref == "" {
			if out, err := run(ctx, dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
				if d := strings.TrimSpace(string(out)); d != "" {
					ref, reason = d, "default-branch"
				}
			}
		}
		if ref == "" {
			ref, reason = "HEAD", "head"
		}
	}

	// An unborn HEAD (a repo with no commits) is a normal state for a new
	// station: everything is untracked and there is nothing to be based on.
	headOut, headErr := run(ctx, dir, "rev-parse", "--verify", "HEAD")
	if headErr != nil {
		return Base{Ref: ref, SHA: "", Reason: reason}, nil
	}
	head := strings.TrimSpace(string(headOut))

	if out, err := run(ctx, dir, "merge-base", ref, "HEAD"); err == nil {
		if mb := strings.TrimSpace(string(out)); mb != "" {
			return Base{Ref: ref, SHA: mb, Reason: reason}, nil
		}
	}

	// Unrelated histories, or a ref that resolves but shares no ancestor.
	if out, err := run(ctx, dir, "rev-parse", "--verify", ref+"^{commit}"); err == nil {
		return Base{Ref: ref, SHA: strings.TrimSpace(string(out)), Reason: reason}, nil
	}

	return Base{Ref: "HEAD", SHA: head, Reason: "head"}, nil
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/gitops/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/gitops
git commit -m "feat(node-agent): base selection with a reported reason"
```

---

## Task 6: `Status()` — composing it all

**Files:**
- Create: `apps/node-agent/internal/gitops/status.go`
- Create: `apps/node-agent/internal/gitops/status_test.go`
- Create: `apps/node-agent/internal/contractfix/changeset_test.go`

**Interfaces:**
- Consumes: `ParsePorcelainV2`, `ParseNumstatZ`, `ParseNameStatusZ`, `ParseCommitsZ`, `SelectBase`, `run`, `IsRepo`, `ErrNotARepo`.
- Produces:
  - `type Repo struct { Branch *string; Head *string; Detached bool }`
  - `type Side struct { Files []File; Insertions int; Deletions int }`
  - `type CommittedSide struct { Side; Commits []Commit }`
  - `type Status struct { Repo Repo; Base Base; Uncommitted Side; Committed CommittedSide; TruncatedFiles bool }`
  - `const MaxFiles = 1000`
  - `func GetStatus(ctx context.Context, dir string, explicitBase string) (Status, error)`

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gitops/status_test.go`:

```go
package gitops

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetStatusRejectsANonRepo(t *testing.T) {
	if _, err := GetStatus(t.Context(), t.TempDir(), ""); err == nil {
		t.Fatal("want an error for a directory that is not a repo")
	}
}

func TestGetStatusSeparatesUncommittedFromCommitted(t *testing.T) {
	// The whole point: "the agent is mid-flight" and "finished work is sitting
	// on this machine" are different situations and must not be merged.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)

	// Committed, not on the base.
	write(t, dir, "committed.txt", "done\n")
	gitDo(t, dir, "add", "committed.txt")
	gitDo(t, dir, "commit", "-qm", "agent finished this")

	// Uncommitted, tracked.
	write(t, dir, "a.txt", "one\ntwo\n")
	// Uncommitted, untracked.
	write(t, dir, "scratch.md", "notes\n")

	st, err := GetStatus(t.Context(), dir, base)
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}

	uncommitted := map[string]FileStatus{}
	for _, f := range st.Uncommitted.Files {
		uncommitted[f.Path] = f.Status
	}
	if uncommitted["a.txt"] != StatusModified {
		t.Errorf("a.txt should be uncommitted+modified, got %+v", st.Uncommitted.Files)
	}
	if uncommitted["scratch.md"] != StatusUntracked {
		t.Errorf("scratch.md should be uncommitted+untracked, got %+v", st.Uncommitted.Files)
	}
	if _, leaked := uncommitted["committed.txt"]; leaked {
		t.Error("a committed file leaked into the uncommitted side")
	}

	if len(st.Committed.Files) != 1 || st.Committed.Files[0].Path != "committed.txt" {
		t.Errorf("committed side = %+v, want just committed.txt", st.Committed.Files)
	}
	if len(st.Committed.Commits) != 1 || st.Committed.Commits[0].Subject != "agent finished this" {
		t.Errorf("commits = %+v", st.Committed.Commits)
	}
}

func TestGetStatusCountsLinesOnTrackedChanges(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\ntwo\nthree\n")

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if st.Uncommitted.Insertions != 2 {
		t.Errorf("Insertions = %d, want 2", st.Uncommitted.Insertions)
	}
	for _, f := range st.Uncommitted.Files {
		if f.Path == "a.txt" {
			if f.Insertions == nil || *f.Insertions != 2 {
				t.Errorf("a.txt insertions = %v, want 2", f.Insertions)
			}
		}
	}
}

func TestGetStatusLeavesUntrackedFilesUncounted(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "new.txt", "a\nb\nc\n")

	st, _ := GetStatus(t.Context(), dir, "")
	for _, f := range st.Uncommitted.Files {
		if f.Path == "new.txt" && f.Insertions != nil {
			t.Errorf("untracked file was counted (%v) — that needs `git add -N`, which mutates the index", f.Insertions)
		}
	}
}

func TestGetStatusReportsADetachedHead(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	gitDo(t, dir, "checkout", "-q", "--detach")

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if !st.Repo.Detached {
		t.Error("Detached should be true")
	}
	if st.Repo.Branch != nil {
		t.Errorf("Branch = %v, want nil", st.Repo.Branch)
	}
}

func TestGetStatusOnACleanRepo(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if len(st.Uncommitted.Files) != 0 || len(st.Committed.Files) != 0 {
		t.Errorf("a clean repo should report nothing: %+v", st)
	}
	if st.Committed.Commits == nil {
		t.Error("Commits must be an empty slice, not nil — null would break the contract")
	}
}

func TestGetStatusNeverMutatesTheRepository(t *testing.T) {
	// The invariant. If GIT_OPTIONAL_LOCKS slips, or someone adds `git add -N`
	// to count untracked files, the index is rewritten under a running agent.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\ntwo\n")
	write(t, dir, "untracked.txt", "x\n")

	idx := filepath.Join(dir, ".git", "index")
	before, err := os.ReadFile(idx)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}

	if _, err := GetStatus(t.Context(), dir, ""); err != nil {
		t.Fatalf("GetStatus: %v", err)
	}

	after, err := os.ReadFile(idx)
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	if string(before) != string(after) {
		t.Error(".git/index changed — this capability must never write to the repository")
	}
}

func TestGetStatusCapsTheFileList(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "seed.txt", "x\n")
	gitDo(t, dir, "add", "seed.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	for i := 0; i < MaxFiles+5; i++ {
		write(t, dir, filepath.Join("many", string(rune('a'+i%26))+itoa(i)+".txt"), "x\n")
	}

	st, err := GetStatus(t.Context(), dir, "")
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if len(st.Uncommitted.Files) > MaxFiles {
		t.Errorf("returned %d files, cap is %d", len(st.Uncommitted.Files), MaxFiles)
	}
	if !st.TruncatedFiles {
		t.Error("TruncatedFiles must be set when the cap bites — silently shortening reads as 'that is everything'")
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gitops/ -run TestGetStatus
```

Expected: FAIL — `undefined: GetStatus`.

- [ ] **Step 3: Implement `GetStatus`**

Create `apps/node-agent/internal/gitops/status.go`:

```go
package gitops

import (
	"context"
	"fmt"
)

// MaxFiles caps each side's file list. One bad agent run touching every file in
// a tree must not produce an unbounded response.
const MaxFiles = 1000

type Repo struct {
	Branch   *string `json:"branch"`
	Head     *string `json:"head"`
	Detached bool    `json:"detached"`
}

type Side struct {
	Files      []File `json:"files"`
	Insertions int    `json:"insertions"`
	Deletions  int    `json:"deletions"`
}

type CommittedSide struct {
	Side
	Commits []Commit `json:"commits"`
}

type Status struct {
	Repo           Repo          `json:"repo"`
	Base           Base          `json:"base"`
	Uncommitted    Side          `json:"uncommitted"`
	Committed      CommittedSide `json:"committed"`
	TruncatedFiles bool          `json:"truncatedFiles"`
}

// GetStatus answers "what has changed in this workspace".
//
// The base affects the COMMITTED side only. Uncommitted is always the working
// tree against HEAD: changing the base changes which commits count as not yet
// on it, and cannot change what is currently unsaved on disk.
func GetStatus(ctx context.Context, dir string, explicitBase string) (Status, error) {
	var st Status

	if !IsRepo(ctx, dir) {
		return st, ErrNotARepo
	}

	base, err := SelectBase(ctx, dir, explicitBase)
	if err != nil {
		return st, err
	}
	st.Base = base

	// ── Uncommitted ──────────────────────────────────────────────────────────
	porcelainOut, err := run(ctx, dir, "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all")
	if err != nil {
		return st, fmt.Errorf("status: %w", err)
	}
	p, err := ParsePorcelainV2(porcelainOut)
	if err != nil {
		return st, err
	}

	st.Repo.Detached = p.Detached
	if p.Branch != "" {
		b := p.Branch
		st.Repo.Branch = &b
	}
	if p.Head != "" {
		h := p.Head
		st.Repo.Head = &h
	}

	// Line counts for tracked changes only. Untracked files are deliberately
	// uncounted — counting them needs `git add -N`, which writes to the index.
	// An unborn HEAD has nothing to diff against, so an error here is not fatal.
	uncommittedStats := map[string]NumStat{}
	if out, nerr := run(ctx, dir, "diff", "--numstat", "-z", "HEAD"); nerr == nil {
		if m, perr := ParseNumstatZ(out); perr == nil {
			uncommittedStats = m
		}
	}
	st.Uncommitted = buildSide(p.Files, uncommittedStats)

	// ── Committed, not on the base ───────────────────────────────────────────
	st.Committed.Commits = []Commit{}
	if base.SHA != "" {
		nameStatusOut, cerr := run(ctx, dir, "diff", "--name-status", "-z", base.SHA, "HEAD")
		if cerr == nil {
			files, perr := ParseNameStatusZ(nameStatusOut)
			if perr != nil {
				return st, perr
			}
			stats := map[string]NumStat{}
			if out, nerr := run(ctx, dir, "diff", "--numstat", "-z", base.SHA, "HEAD"); nerr == nil {
				if m, merr := ParseNumstatZ(out); merr == nil {
					stats = m
				}
			}
			st.Committed.Side = buildSide(files, stats)
		}

		if out, lerr := run(ctx, dir, "log", "-z",
			"--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI",
			fmt.Sprintf("%s..HEAD", base.SHA)); lerr == nil {
			if commits, perr := ParseCommitsZ(out); perr == nil && commits != nil {
				st.Committed.Commits = commits
			}
		}
	}

	if st.Uncommitted.Files == nil {
		st.Uncommitted.Files = []File{}
	}
	if st.Committed.Files == nil {
		st.Committed.Files = []File{}
	}

	st.TruncatedFiles = truncate(&st.Uncommitted) || truncate(&st.Committed.Side)
	return st, nil
}

// buildSide attaches line counts to files and totals them.
//
// A file with no numstat entry keeps nil counts: untracked files and binaries
// have no honest number, and zero would read as "no change".
func buildSide(files []File, stats map[string]NumStat) Side {
	var side Side
	side.Files = make([]File, 0, len(files))

	for _, f := range files {
		if f.Status != StatusUntracked {
			if ns, ok := stats[f.Path]; ok {
				if ns.Binary {
					f.Binary = true
				} else {
					ins, del := ns.Insertions, ns.Deletions
					f.Insertions, f.Deletions = &ins, &del
					side.Insertions += ins
					side.Deletions += del
				}
			}
		}
		side.Files = append(side.Files, f)
	}
	return side
}

// truncate caps a side's file list, reporting whether it bit. Silently
// shortening would read as "that is everything".
func truncate(s *Side) bool {
	if len(s.Files) <= MaxFiles {
		return false
	}
	s.Files = s.Files[:MaxFiles]
	return true
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/gitops/
```

Expected: PASS.

- [ ] **Step 5: Write the contract drift test**

Create `apps/node-agent/internal/contractfix/changeset_test.go`. First read an existing test in that package to match its round-trip helper and its testdata loading convention, then write the equivalent for the `changeset_status.json` fixture emitted in Task 1:

```go
package contractfix

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitops"
)

// The Go structs mirror the contract by hand. This proves they still round-trip
// the canonical fixture losslessly — a field added in zod and forgotten in Go
// fails here instead of in production.
func TestChangesetStatusRoundTrips(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "changeset_status.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var st gitops.Status
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	out, err := json.Marshal(st)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var want, got any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}

	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if string(wantJSON) != string(gotJSON) {
		t.Errorf("round-trip lost or changed fields:\n want %s\n  got %s", wantJSON, gotJSON)
	}
}
```

- [ ] **Step 6: Run the full Go suite**

```bash
cd apps/node-agent && go test -race ./...
```

Expected: PASS. If the round-trip test fails, a Go json tag disagrees with the zod shape — fix the Go tag, not the fixture.

- [ ] **Step 7: Commit**

```bash
git add apps/node-agent/internal/gitops apps/node-agent/internal/contractfix
git commit -m "feat(node-agent): changeset status, with a no-mutation invariant test"
```

---

## Task 7: `Diff()`

**Files:**
- Create: `apps/node-agent/internal/gitops/diff.go`
- Create: `apps/node-agent/internal/gitops/diff_test.go`

**Interfaces:**
- Consumes: `run`, `runAllowExit1`, `IsRepo`, `ErrNotARepo`, `SelectBase`, `ParsePorcelainV2`.
- Produces:
  - `type DiffResult struct { Content string; Truncated bool; Binary bool }`
  - `const DefaultMaxDiffBytes = 2 << 20`, `const MaxDiffBytes = 8 << 20`
  - `func GetDiff(ctx context.Context, dir, side, path, explicitBase string, maxBytes int) (DiffResult, error)`

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gitops/diff_test.go`:

```go
package gitops

import (
	"strings"
	"testing"
)

func TestGetDiffOfATrackedChange(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\ntwo\n")

	got, err := GetDiff(t.Context(), dir, "uncommitted", "a.txt", "", 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "+two") {
		t.Errorf("patch missing the added line:\n%s", got.Content)
	}
}

func TestGetDiffShowsAnUntrackedFile(t *testing.T) {
	// The reason this matters: agents create files constantly, `git diff` shows
	// none of them, and we refuse to use `git add -N` to make them visible.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "brand-new.txt", "hello from the agent\n")

	got, err := GetDiff(t.Context(), dir, "uncommitted", "brand-new.txt", "", 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "hello from the agent") {
		t.Errorf("untracked file content missing:\n%s", got.Content)
	}
}

func TestGetDiffWholeUncommittedSideIncludesUntrackedFiles(t *testing.T) {
	// "Show me everything" must not quietly mean "everything git tracks".
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", "one\nmodified\n")
	write(t, dir, "brand-new.txt", "untracked content\n")

	got, err := GetDiff(t.Context(), dir, "uncommitted", "", "", 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "+modified") {
		t.Errorf("tracked change missing:\n%s", got.Content)
	}
	if !strings.Contains(got.Content, "untracked content") {
		t.Errorf("untracked file missing from the whole-side patch:\n%s", got.Content)
	}
}

func TestGetDiffOfTheCommittedSide(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	base := headSHA(t, dir)
	write(t, dir, "b.txt", "committed work\n")
	gitDo(t, dir, "add", "b.txt")
	gitDo(t, dir, "commit", "-qm", "second")

	got, err := GetDiff(t.Context(), dir, "committed", "", base, 0)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if !strings.Contains(got.Content, "committed work") {
		t.Errorf("committed change missing:\n%s", got.Content)
	}
}

func TestGetDiffTruncatesAndSaysSo(t *testing.T) {
	dir := gitRepo(t)
	write(t, dir, "a.txt", "seed\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", strings.Repeat("a long line of content\n", 5000))

	got, err := GetDiff(t.Context(), dir, "uncommitted", "a.txt", "", 512)
	if err != nil {
		t.Fatalf("GetDiff: %v", err)
	}
	if len(got.Content) > 512 {
		t.Errorf("content is %d bytes, cap was 512", len(got.Content))
	}
	if !got.Truncated {
		t.Error("Truncated must be set when the cap bites")
	}
}

func TestGetDiffTruncationLandsOnValidUTF8(t *testing.T) {
	// Cutting mid-rune produces replacement characters in the console.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "seed\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")
	write(t, dir, "a.txt", strings.Repeat("héllo wörld ünicode\n", 500))

	got, _ := GetDiff(t.Context(), dir, "uncommitted", "a.txt", "", 301)
	if !isValidUTF8(got.Content) {
		t.Error("truncated content is not valid UTF-8")
	}
}

func TestGetDiffRejectsAnUnknownSide(t *testing.T) {
	dir := gitRepo(t)
	if _, err := GetDiff(t.Context(), dir, "sideways", "", "", 0); err == nil {
		t.Fatal("want an error for an unknown side")
	}
}

func TestGetDiffRejectsANonRepo(t *testing.T) {
	if _, err := GetDiff(t.Context(), t.TempDir(), "uncommitted", "", "", 0); err == nil {
		t.Fatal("want an error for a directory that is not a repo")
	}
}

func TestGetDiffRefusesToEscapeTheWorkspace(t *testing.T) {
	// path comes from a hub request. A traversal must not read the host's files.
	dir := gitRepo(t)
	write(t, dir, "a.txt", "one\n")
	gitDo(t, dir, "add", "a.txt")
	gitDo(t, dir, "commit", "-qm", "first")

	for _, bad := range []string{"../../../etc/passwd", "/etc/passwd"} {
		if _, err := GetDiff(t.Context(), dir, "uncommitted", bad, "", 0); err == nil {
			t.Errorf("path %q was accepted; it must be rejected", bad)
		}
	}
}

func isValidUTF8(s string) bool {
	for _, r := range s {
		if r == '�' {
			return false
		}
	}
	return true
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gitops/ -run TestGetDiff
```

Expected: FAIL — `undefined: GetDiff`.

- [ ] **Step 3: Implement `GetDiff`**

Create `apps/node-agent/internal/gitops/diff.go`:

```go
package gitops

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
)

const (
	// DefaultMaxDiffBytes is what a caller gets when it asks for no cap.
	DefaultMaxDiffBytes = 2 << 20
	// MaxDiffBytes is the ceiling a caller cannot raise past.
	MaxDiffBytes = 8 << 20
)

type DiffResult struct {
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
}

// GetDiff returns a unified patch for one side of a changeset.
//
// side is "uncommitted" or "committed". An empty path means the whole side.
// The uncommitted whole-side patch includes untracked files, appended
// individually — "show me everything" must not quietly mean "everything git
// already tracks", which is what a bare `git diff` would give.
//
// Same truncation contract as fs.read: cap, then say so.
func GetDiff(ctx context.Context, dir, side, path, explicitBase string, maxBytes int) (DiffResult, error) {
	var res DiffResult

	if !IsRepo(ctx, dir) {
		return res, ErrNotARepo
	}
	if side != "uncommitted" && side != "committed" {
		return res, fmt.Errorf("unknown side %q", side)
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxDiffBytes
	}
	if maxBytes > MaxDiffBytes {
		maxBytes = MaxDiffBytes
	}

	// path arrives from a hub request; jail it before it reaches git.
	if path != "" {
		if _, err := fsops.Jail(dir, path); err != nil {
			return res, fmt.Errorf("diff: %w", err)
		}
	}

	var buf strings.Builder

	if side == "committed" {
		base, err := SelectBase(ctx, dir, explicitBase)
		if err != nil {
			return res, err
		}
		if base.SHA == "" {
			return DiffResult{Content: ""}, nil
		}
		args := []string{"diff", base.SHA, "HEAD"}
		if path != "" {
			args = append(args, "--", path)
		}
		out, err := run(ctx, dir, args...)
		if err != nil {
			return res, err
		}
		buf.Write(out)
		return capContent(buf.String(), maxBytes), nil
	}

	// ── uncommitted ──────────────────────────────────────────────────────────
	untracked, err := untrackedPaths(ctx, dir)
	if err != nil {
		return res, err
	}

	if path != "" {
		if untracked[path] {
			out, derr := runAllowExit1(ctx, dir, "diff", "--no-index", "--", os.DevNull, path)
			if derr != nil {
				return res, derr
			}
			return capContent(string(out), maxBytes), nil
		}
		out, derr := run(ctx, dir, "diff", "HEAD", "--", path)
		if derr != nil {
			return res, derr
		}
		return capContent(string(out), maxBytes), nil
	}

	// Whole side: tracked changes, then each untracked file.
	if out, derr := run(ctx, dir, "diff", "HEAD"); derr == nil {
		buf.Write(out)
	}
	for p := range untracked {
		if buf.Len() >= maxBytes {
			break
		}
		if out, derr := runAllowExit1(ctx, dir, "diff", "--no-index", "--", os.DevNull, p); derr == nil {
			buf.Write(out)
		}
	}
	return capContent(buf.String(), maxBytes), nil
}

// untrackedPaths lists untracked files, which `git diff` never shows.
func untrackedPaths(ctx context.Context, dir string) (map[string]bool, error) {
	out, err := run(ctx, dir, "status", "--porcelain=v2", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	p, err := ParsePorcelainV2(out)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool)
	for _, f := range p.Files {
		if f.Status == StatusUntracked {
			set[filepath.ToSlash(f.Path)] = true
		}
	}
	return set, nil
}

// capContent truncates on a rune boundary. Cutting mid-rune renders as replacement
// characters in the console.
func capContent(s string, maxBytes int) DiffResult {
	if len(s) <= maxBytes {
		return DiffResult{Content: s}
	}
	cut := s[:maxBytes]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return DiffResult{Content: cut, Truncated: true}
}
```

- [ ] **Step 4: Run the tests**

```bash
cd apps/node-agent && go test -race ./internal/gitops/
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/internal/gitops
git commit -m "feat(node-agent): changeset diff, including untracked files"
```

---

## Task 8: The gateway verb handler

**Files:**
- Create: `apps/node-agent/internal/gateway/changeset.go`
- Create: `apps/node-agent/internal/gateway/changeset_test.go`
- Modify: `apps/node-agent/cmd/agentpod-node/run.go:105-107`

**Interfaces:**
- Consumes: `gitops.GetStatus`, `gitops.GetDiff`, `gitops.ErrNotARepo`; `WorkspaceResolver` from `internal/gateway/terminal.go`; `Handler`/`HandlerFunc` from `internal/gateway/dispatch.go`.
- Produces: `func NewChangesetHandler(inner Handler, resolver WorkspaceResolver) Handler`.

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/gateway/changeset_test.go`:

```go
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// passthroughHandler stands in for the rest of the chain.
func passthroughHandler() Handler {
	return HandlerFunc(func(_ context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		return "inner:" + verb, false, nil
	})
}

func TestChangesetHandlerPassesOtherVerbsThrough(t *testing.T) {
	h := NewChangesetHandler(passthroughHandler(), WorkspaceFunc(func(string) (string, error) {
		return "", errors.New("should not be called")
	}))
	got, _, err := h.Handle(t.Context(), "health", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if got != "inner:health" {
		t.Errorf("got %v, want the inner handler's result", got)
	}
}

func TestChangesetStatusResolvesTheWorkspace(t *testing.T) {
	var askedFor string
	h := NewChangesetHandler(passthroughHandler(), WorkspaceFunc(func(key string) (string, error) {
		askedFor = key
		return "", errors.New("no workspace")
	}))
	_, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`{"key":"codex:abc"}`), nil)
	if err == nil {
		t.Fatal("want an error when the workspace cannot be resolved")
	}
	if askedFor != "codex:abc" {
		t.Errorf("resolver asked for %q, want codex:abc", askedFor)
	}
}

func TestChangesetStatusRejectsBadParams(t *testing.T) {
	h := NewChangesetHandler(passthroughHandler(), WorkspaceFunc(func(string) (string, error) { return "/tmp", nil }))
	if _, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`not json`), nil); err == nil {
		t.Fatal("want an error for malformed params")
	}
}

func TestChangesetDiffRequiresASide(t *testing.T) {
	h := NewChangesetHandler(passthroughHandler(), WorkspaceFunc(func(string) (string, error) { return "/tmp", nil }))
	_, _, err := h.Handle(t.Context(), "changeset.diff", json.RawMessage(`{"key":"k"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "side") {
		t.Errorf("err = %v, want a message naming the missing side", err)
	}
}

func TestChangesetSaysWhenAWorkspaceIsNotARepo(t *testing.T) {
	// A distinct, readable error: the capability is meant to be gated on this,
	// so seeing it means the gate has drifted, and the message should say what
	// is actually wrong rather than surfacing raw git noise.
	dir := t.TempDir()
	h := NewChangesetHandler(passthroughHandler(), WorkspaceFunc(func(string) (string, error) { return dir, nil }))
	_, _, err := h.Handle(t.Context(), "changeset.status", json.RawMessage(`{"key":"k"}`), nil)
	if err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Errorf("err = %v, want it to name the real problem", err)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/gateway/ -run TestChangeset
```

Expected: FAIL — `undefined: NewChangesetHandler`.

- [ ] **Step 3: Write the handler**

Create `apps/node-agent/internal/gateway/changeset.go`:

```go
package gateway

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitops"
)

// changesetHandler wraps an inner Handler and adds the two changeset verbs.
//
// Neither streams: both return a bounded result, so they take the plain
// request/response path rather than the stream frames term.attach uses.
type changesetHandler struct {
	inner    Handler
	resolver WorkspaceResolver
}

// NewChangesetHandler wraps inner with changeset.status and changeset.diff.
func NewChangesetHandler(inner Handler, resolver WorkspaceResolver) Handler {
	return &changesetHandler{inner: inner, resolver: resolver}
}

func (h *changesetHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	switch verb {
	case "changeset.status":
		return h.status(ctx, params)
	case "changeset.diff":
		return h.diff(ctx, params)
	default:
		return h.inner.Handle(ctx, verb, params, emit)
	}
}

func (h *changesetHandler) workspace(key string) (string, error) {
	if key == "" {
		return "", fmt.Errorf("changeset: missing key")
	}
	dir, err := h.resolver.Workspace(key)
	if err != nil {
		return "", fmt.Errorf("changeset: workspace for %q: %w", key, err)
	}
	return dir, nil
}

func (h *changesetHandler) status(ctx context.Context, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key  string `json:"key"`
		Base string `json:"base"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("changeset.status: bad params: %w", err)
	}
	dir, err := h.workspace(p.Key)
	if err != nil {
		return nil, false, err
	}
	st, err := gitops.GetStatus(ctx, dir, p.Base)
	if err != nil {
		return nil, false, fmt.Errorf("changeset.status: %w", err)
	}
	return st, false, nil
}

func (h *changesetHandler) diff(ctx context.Context, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key      string `json:"key"`
		Base     string `json:"base"`
		Path     string `json:"path"`
		Side     string `json:"side"`
		MaxBytes int    `json:"maxBytes"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, false, fmt.Errorf("changeset.diff: bad params: %w", err)
	}
	if p.Side == "" {
		return nil, false, fmt.Errorf("changeset.diff: missing side (uncommitted or committed)")
	}
	dir, err := h.workspace(p.Key)
	if err != nil {
		return nil, false, err
	}
	d, err := gitops.GetDiff(ctx, dir, p.Side, p.Path, p.Base, p.MaxBytes)
	if err != nil {
		return nil, false, fmt.Errorf("changeset.diff: %w", err)
	}
	return d, false, nil
}
```

- [ ] **Step 4: Wire it into the chain**

In `apps/node-agent/cmd/agentpod-node/run.go`, change the handler chain (currently lines 105-107) to insert the changeset handler:

```go
	h := gateway.NewTerminalHandler(descriptor.NewHandler(reg), resolver, mgr, lifecycleFn)
	h = gateway.NewChangesetHandler(h, resolver)
	h = gateway.NewACPHandler(h, acpMgr, descriptor.NewCapabilityHandler(reg).ACPCommand)
	h = gateway.NewUpdateHandler(h, version)
	gateway.Run(ctx, cfg, h, version, gatherHealth)
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/node-agent && go test -race ./...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/node-agent/internal/gateway apps/node-agent/cmd/agentpod-node/run.go
git commit -m "feat(node-agent): changeset.status and changeset.diff verbs"
```

---

## Task 9: Conditional capability advertisement

**Files:**
- Create: `apps/node-agent/internal/descriptor/gitcap.go`
- Create: `apps/node-agent/internal/descriptor/gitcap_test.go`
- Modify: `apps/node-agent/internal/descriptor/hermes.go:64`
- Modify: `apps/node-agent/internal/descriptor/openclaw.go:133`
- Modify: `apps/node-agent/internal/descriptor/codex.go:135`
- Modify: `apps/node-agent/internal/descriptor/claudecode.go:133`
- Modify: `apps/node-agent/internal/descriptor/opencode.go:114`

**Interfaces:**
- Consumes: `gitops.IsRepo`.
- Produces: `func AppendChangesetCap(caps []string, workspacePath *string) []string`.

- [ ] **Step 1: Write the failing tests**

Create `apps/node-agent/internal/descriptor/gitcap_test.go`:

```go
package descriptor

import (
	"os/exec"
	"slices"
	"testing"
)

func TestAppendChangesetCapOnAGitWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-q")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}

	got := AppendChangesetCap([]string{"health"}, &dir)
	if !slices.Contains(got, "changeset") {
		t.Errorf("got %v, want changeset advertised for a git workspace", got)
	}
}

func TestAppendChangesetCapOnAPlainDirectory(t *testing.T) {
	// Advertising it here would put a tab on the station that always errors.
	dir := t.TempDir()
	got := AppendChangesetCap([]string{"health"}, &dir)
	if slices.Contains(got, "changeset") {
		t.Errorf("got %v, want no changeset for a non-repo", got)
	}
}

func TestAppendChangesetCapWithNoWorkspace(t *testing.T) {
	got := AppendChangesetCap([]string{"health"}, nil)
	if slices.Contains(got, "changeset") {
		t.Errorf("got %v, want no changeset when there is no workspace", got)
	}
}

func TestAppendChangesetCapDoesNotMutateItsInput(t *testing.T) {
	// Descriptors build one caps slice and reuse it across stations. Appending
	// in place would leak one station's capability onto its siblings.
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	cmd := exec.Command("git", "init", "-q")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}

	base := []string{"health", "logs"}
	_ = AppendChangesetCap(base, &dir)
	if len(base) != 2 {
		t.Errorf("input slice was mutated: %v", base)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/node-agent && go test ./internal/descriptor/ -run TestAppendChangesetCap
```

Expected: FAIL — `undefined: AppendChangesetCap`.

- [ ] **Step 3: Implement the helper**

Create `apps/node-agent/internal/descriptor/gitcap.go`:

```go
package descriptor

import (
	"context"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gitops"
)

// changesetProbeTimeout bounds the repo check. Detect runs on every node
// connect and a slow filesystem must not stall enrolment.
const changesetProbeTimeout = 3 * time.Second

// AppendChangesetCap adds "changeset" when the station's workspace is a git
// repository and git is usable.
//
// Advertised conditionally so a station whose workspace is not a repo shows no
// tab, rather than one that always errors.
//
// Returns a NEW slice: descriptors build one caps slice and reuse it across
// several stations, so appending in place would leak one station's capability
// onto its siblings.
func AppendChangesetCap(caps []string, workspacePath *string) []string {
	out := make([]string, len(caps), len(caps)+1)
	copy(out, caps)

	if workspacePath == nil || *workspacePath == "" {
		return out
	}

	ctx, cancel := context.WithTimeout(context.Background(), changesetProbeTimeout)
	defer cancel()

	if gitops.IsRepo(ctx, *workspacePath) {
		out = append(out, "changeset")
	}
	return out
}
```

- [ ] **Step 4: Use it in every descriptor**

In each of the five descriptor files, the capability list is built once and then attached to each `Station`. Change each so the per-station capability list runs through the helper with **that station's own workspace path**.

For `hermes.go`, the composite station at line ~64 becomes:

```go
	caps := []string{"health", "logs", "fs.read", "fs.write", "terminal", "lifecycle", "cleanup", "acp"}
	homeCopy := h.home

	stations := []Station{
		{
			Key:           "hermes",
			Harness:       "hermes",
			Kind:          "composite",
			DisplayName:   "Hermes",
			ParentKey:     nil,
			WorkspacePath: &homeCopy,
			Capabilities:  AppendChangesetCap(caps, &homeCopy),
		},
	}
```

Then, further down the same function where each profile leaf station is appended, replace its `Capabilities: caps` with `Capabilities: AppendChangesetCap(caps, <that station's workspace pointer>)`.

Apply the same change in `openclaw.go`, `codex.go`, `claudecode.go` and `opencode.go`: every place a `Station` literal sets `Capabilities: caps`, wrap it as `AppendChangesetCap(caps, <that station's WorkspacePath>)`. Read each file first — the variable holding the workspace pointer differs between them.

- [ ] **Step 5: Run the tests**

```bash
cd apps/node-agent && go test -race ./...
```

Expected: PASS. Existing descriptor tests that assert exact capability lists on non-repo temp directories keep passing, because the helper adds nothing there.

- [ ] **Step 6: Verify by hand against a real repo**

```bash
cd apps/node-agent && go run ./cmd/agentpod-node detect 2>/dev/null | grep -o '"capabilities":\[[^]]*\]' | head -5
```

Expected: stations whose workspace is a git repository list `"changeset"`; others do not.

- [ ] **Step 7: Commit**

```bash
git add apps/node-agent/internal/descriptor
git commit -m "feat(node-agent): advertise changeset only on git workspaces"
```

---

## Task 10: Hub routes

**Files:**
- Create: `apps/hub/src/routes/station-changeset.ts`
- Create: `apps/hub/src/routes/station-changeset.test.ts`
- Modify: `apps/hub/src/index.ts:42,125`

**Interfaces:**
- Consumes: `getStation`, `gateCapability`, `recordAudit`, `broker.request`.
- Produces: `stationChangesetRoutes` — `POST /api/stations/:id/changeset/status`, `POST /api/stations/:id/changeset/diff`.

- [ ] **Step 1: Write the failing tests**

Create `apps/hub/src/routes/station-changeset.test.ts`. Read `apps/hub/src/routes/station-cleanup.test.ts` first and reuse its app-construction and seeding helpers verbatim rather than inventing new ones.

```ts
import { test, expect, spyOn } from "bun:test";
import * as broker from "../services/broker";

// Reuse the helpers from station-cleanup.test.ts: buildApp(), seedStation().

test("status requires authentication", async () => {
  const app = buildApp({ anonymous: true });
  const res = await app.request("/api/stations/station_x/changeset/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});

test("status 404s on a station the user does not own", async () => {
  const { app } = await seedStation({ capabilities: ["changeset"] });
  const res = await app.request("/api/stations/station_not_mine/changeset/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(404);
});

test("status 403s when the station does not advertise changeset", async () => {
  // The gate must reject BEFORE any node call: a station without a git
  // workspace should cost nothing to ask about.
  const { app, stationId } = await seedStation({ capabilities: ["health"] });
  const spy = spyOn(broker, "request");
  const res = await app.request(`/api/stations/${stationId}/changeset/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(403);
  expect(spy).not.toHaveBeenCalled();
  spy.mockRestore();
});

test("status forwards the station key and returns the node's answer", async () => {
  const { app, stationId, stationKey } = await seedStation({ capabilities: ["changeset"] });
  const payload = {
    repo: { branch: "main", head: "abc", detached: false },
    base: { ref: "origin/main", sha: "def", reason: "upstream" },
    uncommitted: { files: [], insertions: 0, deletions: 0 },
    committed: { files: [], insertions: 0, deletions: 0, commits: [] },
    truncatedFiles: false,
  };
  const spy = spyOn(broker, "request").mockResolvedValue({ ok: true, data: payload });

  const res = await app.request(`/api/stations/${stationId}/changeset/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base: "origin/main" }),
  });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(payload);
  expect(spy).toHaveBeenCalledWith(stationId ? expect.any(String) : "", "changeset.status", {
    key: stationKey,
    base: "origin/main",
  });
  spy.mockRestore();
});

test("an offline node is a 409, not a 502", async () => {
  const { app, stationId } = await seedStation({ capabilities: ["changeset"] });
  const spy = spyOn(broker, "request").mockResolvedValue({ ok: false, error: "node offline" });
  const res = await app.request(`/api/stations/${stationId}/changeset/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(409);
  spy.mockRestore();
});

test("any other broker failure is a 502", async () => {
  const { app, stationId } = await seedStation({ capabilities: ["changeset"] });
  const spy = spyOn(broker, "request").mockResolvedValue({ ok: false, error: "git exploded" });
  const res = await app.request(`/api/stations/${stationId}/changeset/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(502);
  spy.mockRestore();
});

test("diff requires a valid side", async () => {
  const { app, stationId } = await seedStation({ capabilities: ["changeset"] });
  const res = await app.request(`/api/stations/${stationId}/changeset/diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side: "sideways" }),
  });
  expect(res.status).toBe(400);
});

test("diff forwards path, side and maxBytes", async () => {
  const { app, stationId, stationKey } = await seedStation({ capabilities: ["changeset"] });
  const spy = spyOn(broker, "request").mockResolvedValue({
    ok: true,
    data: { content: "@@ -1 +1 @@", truncated: false, binary: false },
  });

  const res = await app.request(`/api/stations/${stationId}/changeset/diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side: "uncommitted", path: "src/a.ts", maxBytes: 4096 }),
  });

  expect(res.status).toBe(200);
  const call = spy.mock.calls[0]!;
  expect(call[1]).toBe("changeset.diff");
  expect(call[2]).toMatchObject({ key: stationKey, side: "uncommitted", path: "src/a.ts", maxBytes: 4096 });
  spy.mockRestore();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test src/routes/station-changeset.test.ts
```

Expected: 404s on every route — they are not mounted yet.

- [ ] **Step 3: Write the routes**

Create `apps/hub/src/routes/station-changeset.ts`:

```ts
/**
 * Station Changeset Routes — POST /api/stations/:id/changeset/status
 *                            POST /api/stations/:id/changeset/diff
 *
 * Safety model (mirrors station-cleanup.ts):
 *   1. Authenticate (401 if anonymous).
 *   2. Station ownership via getStation → 404 if absent.
 *   3. Capability gate: requires "changeset" → 403 if absent (no node call).
 *   4. broker.request() to the node.
 *   5. Respond.
 *
 * Node-offline → 409; other broker errors → 502.
 *
 * `diff` records an audit row and `status` does not. Status is fetched every
 * time the panel opens and on every refresh, so auditing it would bury the log
 * in noise; the diff is where source code actually leaves the machine, and that
 * is the event worth a record.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../db/drizzle";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { recordAudit } from "../services/audit";
import { gateCapability } from "./station-writes";
import type { AuthUser } from "../auth/middleware";

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

const StatusBody = z.object({
  base: z.string().min(1).optional(),
});

const DiffBody = z.object({
  side: z.enum(["uncommitted", "committed"]),
  path: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
  maxBytes: z.number().int().positive().max(8 << 20).optional(),
});

export const stationChangesetRoutes = new Hono()

  .post("/stations/:id/changeset/status", zValidator("json", StatusBody), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const station = await getStation(user.id, c.req.param("id"));
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    if (!gateCapability(station, "changeset")) {
      return c.json(
        { error: "Forbidden: station does not advertise changeset capability" },
        403
      );
    }

    const { base } = c.req.valid("json");
    const result = await broker.request(station.nodeId, "changeset.status", {
      key: station.stationKey,
      ...(base ? { base } : {}),
    });

    if (!result.ok) {
      return c.json(
        { error: result.error ?? "changeset.status failed" },
        brokerErrorStatus(result.error)
      );
    }
    return c.json(result.data);
  })

  .post("/stations/:id/changeset/diff", zValidator("json", DiffBody), async (c) => {
    const user = c.get("user") as AuthUser | undefined;
    if (!user || user.id === "anonymous") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const station = await getStation(user.id, c.req.param("id"));
    if (!station) {
      return c.json({ error: "Not Found" }, 404);
    }

    if (!gateCapability(station, "changeset")) {
      return c.json(
        { error: "Forbidden: station does not advertise changeset capability" },
        403
      );
    }

    const { side, path, base, maxBytes } = c.req.valid("json");

    // Audited: this is the call that moves source code off the machine.
    const audit = await recordAudit(db, {
      userId: user.id,
      nodeId: station.nodeId,
      stationKey: station.stationKey,
      verb: "changeset.diff",
      params: { side, path: path ?? null },
    });

    const result = await broker.request(station.nodeId, "changeset.diff", {
      key: station.stationKey,
      side,
      ...(path ? { path } : {}),
      ...(base ? { base } : {}),
      ...(maxBytes ? { maxBytes } : {}),
    });

    await audit.done(result.ok ? "ok" : "error", result.error).catch(() => {});

    if (!result.ok) {
      return c.json(
        { error: result.error ?? "changeset.diff failed" },
        brokerErrorStatus(result.error)
      );
    }
    return c.json(result.data);
  });
```

- [ ] **Step 4: Mount them**

In `apps/hub/src/index.ts`, add the import next to the cleanup one on line 42:

```ts
import { stationChangesetRoutes } from './routes/station-changeset.ts';
```

and the mount next to the cleanup one on line 125:

```ts
  .route('/api', stationChangesetRoutes)                   // POST /api/stations/:id/changeset/{status,diff}
```

- [ ] **Step 5: Run the tests**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/routes/station-changeset.ts apps/hub/src/routes/station-changeset.test.ts apps/hub/src/index.ts
git commit -m "feat(hub): changeset status and diff routes"
```

---

## Task 11: Console API client and panel

**Files:**
- Modify: `apps/console/src/lib/api/client.ts`
- Create: `apps/console/src/lib/components/stations/ChangesetPanel.svelte`
- Create: `apps/console/src/lib/components/stations/ChangesetPanel.svelte.test.ts`

**Interfaces:**
- Consumes: the hub routes from Task 10; `http` from `client.ts`.
- Produces:
  - `type ChangesetFile`, `ChangesetStatusResult`, `ChangesetDiffResult` in `client.ts`
  - `changesetStatus(stationId: string, base?: string): Promise<ChangesetStatusResult>`
  - `changesetDiff(stationId: string, side: "uncommitted" | "committed", path?: string): Promise<ChangesetDiffResult>`
  - `ChangesetPanel` with props `{ stationId: string }`

- [ ] **Step 1: Write the failing test**

Create `apps/console/src/lib/components/stations/ChangesetPanel.svelte.test.ts`. Read `CleanupPanel.svelte.test.ts` first and match its render and mocking conventions.

```ts
import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import ChangesetPanel from "./ChangesetPanel.svelte";
import * as client from "$lib/api/client";

const CLEAN = {
  repo: { branch: "main", head: "abc1234", detached: false },
  base: { ref: "origin/main", sha: "def5678", reason: "upstream" as const },
  uncommitted: { files: [], insertions: 0, deletions: 0 },
  committed: { files: [], insertions: 0, deletions: 0, commits: [] },
  truncatedFiles: false,
};

const DIRTY = {
  ...CLEAN,
  uncommitted: {
    files: [
      { path: "src/a.ts", oldPath: null, status: "modified" as const, insertions: 12, deletions: 3, binary: false },
      { path: "notes.md", oldPath: null, status: "untracked" as const, insertions: null, deletions: null, binary: false },
    ],
    insertions: 12,
    deletions: 3,
  },
  committed: {
    files: [{ path: "src/b.ts", oldPath: null, status: "added" as const, insertions: 5, deletions: 0, binary: false }],
    insertions: 5,
    deletions: 0,
    commits: [{ sha: "9f1c2ab", shortSha: "9f1c2ab", subject: "agent work", author: "codex", committedAt: "2026-08-11T09:15:00Z" }],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

test("says which base it used and why", async () => {
  // Without this, a surprising diff on a remote machine is unexplainable.
  vi.spyOn(client, "changesetStatus").mockResolvedValue(CLEAN);
  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText(/origin\/main/)).toBeInTheDocument());
  expect(screen.getByText(/upstream/i)).toBeInTheDocument();
});

test("a clean workspace says so rather than showing an empty list", async () => {
  vi.spyOn(client, "changesetStatus").mockResolvedValue(CLEAN);
  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText(/no changes/i)).toBeInTheDocument());
});

test("lists uncommitted and committed work separately", async () => {
  vi.spyOn(client, "changesetStatus").mockResolvedValue(DIRTY);
  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());
  expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  expect(screen.getByText(/agent work/)).toBeInTheDocument();
});

test("an untracked file is labelled and shows no line counts", async () => {
  vi.spyOn(client, "changesetStatus").mockResolvedValue(DIRTY);
  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText("notes.md")).toBeInTheDocument());
  expect(screen.getByText(/untracked/i)).toBeInTheDocument();
});

test("clicking a file fetches that file's patch", async () => {
  vi.spyOn(client, "changesetStatus").mockResolvedValue(DIRTY);
  const diff = vi.spyOn(client, "changesetDiff").mockResolvedValue({
    content: "@@ -1 +1 @@\n-one\n+two\n",
    truncated: false,
    binary: false,
  });

  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());
  await userEvent.click(screen.getByText("src/a.ts"));

  await waitFor(() => expect(diff).toHaveBeenCalledWith("station_1", "uncommitted", "src/a.ts"));
});

test("a truncated patch says so", async () => {
  vi.spyOn(client, "changesetStatus").mockResolvedValue(DIRTY);
  vi.spyOn(client, "changesetDiff").mockResolvedValue({
    content: "@@ -1 +1 @@\n+partial",
    truncated: true,
    binary: false,
  });

  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText("src/a.ts")).toBeInTheDocument());
  await userEvent.click(screen.getByText("src/a.ts"));
  await waitFor(() => expect(screen.getByText(/truncated/i)).toBeInTheDocument());
});

test("a failed load shows the error instead of an empty panel", async () => {
  vi.spyOn(client, "changesetStatus").mockRejectedValue(new Error("node offline"));
  render(ChangesetPanel, { props: { stationId: "station_1" } });
  await waitFor(() => expect(screen.getByText(/node offline/)).toBeInTheDocument());
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/console && pnpm test -- ChangesetPanel
```

Expected: FAIL — the component does not exist.

- [ ] **Step 3: Add the API client functions**

Append to `apps/console/src/lib/api/client.ts`, after the cleanup section:

```ts
// ─── Changeset endpoints ──────────────────────────────────────────────────────

export type ChangesetFileStatus =
  | "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "untracked";

export type ChangesetFile = {
  path: string;
  oldPath: string | null;
  status: ChangesetFileStatus;
  /** Null for binary files and for untracked files, which git will not count
   *  without mutating the index. */
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type ChangesetCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  committedAt: string;
};

export type ChangesetStatusResult = {
  repo: { branch: string | null; head: string | null; detached: boolean };
  base: { ref: string; sha: string; reason: "explicit" | "upstream" | "default-branch" | "head" };
  uncommitted: { files: ChangesetFile[]; insertions: number; deletions: number };
  committed: {
    files: ChangesetFile[];
    insertions: number;
    deletions: number;
    commits: ChangesetCommit[];
  };
  truncatedFiles: boolean;
};

export type ChangesetDiffResult = { content: string; truncated: boolean; binary: boolean };

export const changesetStatus = (stationId: string, base?: string) =>
  http<ChangesetStatusResult>(`/api/stations/${stationId}/changeset/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(base ? { base } : {}),
  });

export const changesetDiff = (
  stationId: string,
  side: "uncommitted" | "committed",
  path?: string
) =>
  http<ChangesetDiffResult>(`/api/stations/${stationId}/changeset/diff`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side, ...(path ? { path } : {}) }),
  });
```

- [ ] **Step 4: Write the panel**

Create `apps/console/src/lib/components/stations/ChangesetPanel.svelte`. Read `CleanupPanel.svelte` first and match its import set, its `$state`/`$derived` conventions, and its use of `Card`, `Badge`, `Button` and `Empty`.

```svelte
<script lang="ts">
  import { changesetStatus, changesetDiff } from "$lib/api/client";
  import type {
    ChangesetStatusResult,
    ChangesetDiffResult,
    ChangesetFile,
  } from "$lib/api/client";
  import * as Card from "$lib/components/ui/card";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Empty } from "$lib/components/ui/empty";
  import CodeBlock from "$lib/components/ui/code-block/code-block.svelte";

  interface Props {
    stationId: string;
  }

  let { stationId }: Props = $props();

  // ─── State ──────────────────────────────────────────────────────────────────

  let status = $state<ChangesetStatusResult | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  let openPath = $state<string | null>(null);
  let openSide = $state<"uncommitted" | "committed">("uncommitted");
  let patch = $state<ChangesetDiffResult | null>(null);
  let patchLoading = $state(false);
  let patchError = $state<string | null>(null);

  // ─── Derived ────────────────────────────────────────────────────────────────

  const isClean = $derived(
    !!status &&
      status.uncommitted.files.length === 0 &&
      status.committed.files.length === 0
  );

  /** Why this base, in words. A surprising diff on a machine you are not
   *  sitting at is otherwise unexplainable. */
  const baseExplanation = $derived.by(() => {
    switch (status?.base.reason) {
      case "explicit":
        return "you asked for this base";
      case "upstream":
        return "upstream — the branch tracks it";
      case "default-branch":
        return "default branch — this branch tracks nothing";
      case "head":
        return "HEAD — no upstream and no origin, so only uncommitted work is shown";
      default:
        return "";
    }
  });

  // ─── Actions ────────────────────────────────────────────────────────────────

  async function load() {
    loading = true;
    loadError = null;
    try {
      status = await changesetStatus(stationId);
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Couldn't read this workspace.";
    } finally {
      loading = false;
    }
  }

  async function openFile(side: "uncommitted" | "committed", file: ChangesetFile) {
    openSide = side;
    openPath = file.path;
    patch = null;
    patchError = null;
    patchLoading = true;
    try {
      patch = await changesetDiff(stationId, side, file.path);
    } catch (e) {
      patchError = e instanceof Error ? e.message : "Couldn't read this file's diff.";
    } finally {
      patchLoading = false;
    }
  }

  function counts(f: ChangesetFile): string {
    if (f.binary) return "binary";
    if (f.insertions === null || f.deletions === null) return "";
    return `+${f.insertions} −${f.deletions}`;
  }

  $effect(() => {
    void stationId;
    load();
  });
</script>

<div class="space-y-4">
  {#if loading}
    <p class="text-muted-foreground text-sm">Reading the workspace…</p>
  {:else if loadError}
    <Empty title="Couldn't read this workspace">{loadError}</Empty>
  {:else if status}
    <Card.Root>
      <Card.Header>
        <Card.Title>
          {status.repo.detached ? "detached HEAD" : (status.repo.branch ?? "unknown branch")}
        </Card.Title>
        <Card.Description>
          Compared against <code>{status.base.ref}</code> — {baseExplanation}
        </Card.Description>
      </Card.Header>
      <Card.Footer>
        <Button variant="outline" size="sm" onclick={load}>Refresh</Button>
      </Card.Footer>
    </Card.Root>

    {#if status.truncatedFiles}
      <p class="text-sm text-amber-600">
        Too many changed files to list them all — this is a partial view.
      </p>
    {/if}

    {#if isClean}
      <Empty title="No changes">
        This workspace matches its base. Nothing is uncommitted and nothing is
        waiting to be delivered.
      </Empty>
    {:else}
      {#if status.uncommitted.files.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title>Uncommitted</Card.Title>
            <Card.Description>
              Not saved to a commit — the agent may still be working.
              +{status.uncommitted.insertions} −{status.uncommitted.deletions}
            </Card.Description>
          </Card.Header>
          <Card.Content class="space-y-1">
            {#each status.uncommitted.files as f (f.path)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                onclick={() => openFile("uncommitted", f)}
              >
                <Badge variant="outline">{f.status}</Badge>
                <span class="truncate font-mono">{f.path}</span>
                {#if f.oldPath}
                  <span class="text-muted-foreground truncate text-xs">was {f.oldPath}</span>
                {/if}
                <span class="text-muted-foreground ml-auto text-xs">{counts(f)}</span>
              </button>
            {/each}
          </Card.Content>
        </Card.Root>
      {/if}

      {#if status.committed.files.length > 0}
        <Card.Root>
          <Card.Header>
            <Card.Title>Committed, not on the base</Card.Title>
            <Card.Description>
              Finished work sitting on this machine.
              +{status.committed.insertions} −{status.committed.deletions}
            </Card.Description>
          </Card.Header>
          <Card.Content class="space-y-1">
            {#each status.committed.commits as c (c.sha)}
              <p class="text-muted-foreground text-xs">
                <code>{c.shortSha}</code>
                {c.subject} — {c.author}
              </p>
            {/each}
            {#each status.committed.files as f (f.path)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted"
                onclick={() => openFile("committed", f)}
              >
                <Badge variant="outline">{f.status}</Badge>
                <span class="truncate font-mono">{f.path}</span>
                <span class="text-muted-foreground ml-auto text-xs">{counts(f)}</span>
              </button>
            {/each}
          </Card.Content>
        </Card.Root>
      {/if}
    {/if}

    {#if openPath}
      <Card.Root>
        <Card.Header>
          <Card.Title class="font-mono text-sm">{openPath}</Card.Title>
          {#if patch?.truncated}
            <Card.Description>
              This patch is truncated — it was too large to send in full.
            </Card.Description>
          {/if}
        </Card.Header>
        <Card.Content>
          {#if patchLoading}
            <p class="text-muted-foreground text-sm">Loading the diff…</p>
          {:else if patchError}
            <p class="text-destructive text-sm">{patchError}</p>
          {:else if patch}
            {#if patch.binary || patch.content.trim() === ""}
              <p class="text-muted-foreground text-sm">
                No textual diff to show for this file.
              </p>
            {:else}
              <CodeBlock code={patch.content} lang="diff" />
            {/if}
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
  {/if}
</div>
```

Check `code-block.svelte`'s actual prop names before finishing — if they are not `code` and `lang`, use the real ones.

- [ ] **Step 5: Run the tests**

```bash
cd apps/console && pnpm test -- ChangesetPanel
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/console/src/lib/api/client.ts apps/console/src/lib/components/stations/ChangesetPanel.svelte apps/console/src/lib/components/stations/ChangesetPanel.svelte.test.ts
git commit -m "feat(console): changeset panel"
```

---

## Task 12: The gated tab

**Files:**
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte:33-43,115,297`
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/page.svelte.test.ts`

**Interfaces:**
- Consumes: `ChangesetPanel` from Task 11.
- Produces: a `changes` tab, rendered only when the station advertises `changeset`.

- [ ] **Step 1: Write the failing test**

Append to `apps/console/src/routes/nodes/[id]/stations/[stationId]/page.svelte.test.ts`, matching the file's existing render helpers and station fixtures.

```ts
test("a station with the changeset capability gets a Changes tab", async () => {
  const { getByRole } = renderStationPage({
    capabilities: ["health", "changeset"],
  });
  await waitFor(() => expect(getByRole("tab", { name: /changes/i })).toBeInTheDocument());
});

test("a station without it gets no Changes tab", async () => {
  // A tab that always errors is worse than no tab — that is why the capability
  // is advertised conditionally in the first place.
  const { queryByRole } = renderStationPage({ capabilities: ["health"] });
  await waitFor(() => expect(queryByRole("tab", { name: /health/i })).toBeInTheDocument());
  expect(queryByRole("tab", { name: /changes/i })).toBeNull();
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/console && pnpm test -- page.svelte
```

Expected: FAIL — no tab named Changes.

- [ ] **Step 3: Add the tab**

In `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte`:

Add the import alongside the other station panels:

```ts
  import ChangesetPanel from "$lib/components/stations/ChangesetPanel.svelte";
```

Extend the `Tab` type and `VALID_TABS` (lines 33-43):

```ts
  type Tab = "chat" | "health" | "logs" | "files" | "terminal" | "changes" | "cleanup" | "activity";
  const VALID_TABS: readonly Tab[] = [
    "chat",
    "health",
    "logs",
    "files",
    "terminal",
    "changes",
    "cleanup",
    "activity",
  ];
```

Add the capability derivation next to `hasCleanup` (around line 115):

```ts
  const hasChangeset = $derived(
    Array.isArray(station?.capabilities) && station!.capabilities.includes("changeset")
  );
```

Find where the `tabs` array is built (it is what `activeTab` checks with `tabs.some(...)`) and add a `changes` entry gated on `hasChangeset`, following the exact shape the neighbouring `cleanup` entry uses.

Then add the panel next to `<CleanupPanel {stationId} />` around line 297, using the same plain if-mounted form — `changes` is deliberately **not** a heavy tab, because it must re-fetch on every mount rather than showing a stale view of a workspace that changes under it:

```svelte
      {#if hasChangeset}
        <ChangesetPanel {stationId} />
      {/if}
```

Match the surrounding tabpanel wrapper markup exactly — read the `cleanup` block and mirror it, including its `id` and `aria-labelledby` attributes.

- [ ] **Step 4: Run the console suite**

```bash
cd apps/console && pnpm check && pnpm test && pnpm build
```

Expected: PASS on all three.

- [ ] **Step 5: Commit**

```bash
git add "apps/console/src/routes/nodes/[id]/stations/[stationId]"
git commit -m "feat(console): Changes tab, gated on the changeset capability"
```

---

## Task 13: Full verification and PR

- [ ] **Step 1: Run every suite**

```bash
cd packages/contract && bun test
cd ../../apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
cd ../node-agent && go test -race ./...
cd ../console && pnpm check && pnpm test && pnpm build
```

Expected: all four green. These are the four required checks on `main`.

- [ ] **Step 2: Verify the fixture check the way CI does**

```bash
cd packages/contract && bun run scripts/emit-go-fixtures.ts --check
```

Expected: PASS with no diff.

- [ ] **Step 3: Verify by hand against a real workspace**

Build the node-agent and point it at this repository, which is a git repo with real history:

```bash
cd apps/node-agent && go build -o /tmp/apn ./cmd/agentpod-node && /tmp/apn detect | grep -c changeset
```

Expected: at least one station advertises it. Then make a scratch edit and an untracked file in a throwaway clone and confirm `GetStatus` reports both — the Go tests cover this, but seeing it on a real repository with real history catches assumptions the fixtures encode.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin changeset-capability
gh pr create --title "feat: changeset capability — observe a station's workspace diff" --body "$(cat <<'EOF'
Implements `docs/superpowers/specs/2026-08-11-changeset-capability-design.md` (Horizon 1).

Two new verbs let the console show what an agent has changed in a station's
workspace — uncommitted edits, untracked files, and commits not yet on a base —
without SSHing to the machine.

- `changeset.status` — the summary, with the base and *why* it was chosen
- `changeset.diff` — a patch, whole-side or per-file, truncated like `fs.read`

Observe-only. No persistence, no delivery: the change artifact store is Horizon 2.

**Also fixes a latent bug found while designing this.** `stations.capabilities`
was written only by `adoptStations`, so a station adopted before a capability
existed could never gain it — `changeset` would have appeared on newly-adopted
stations and on none of the existing fleet. `posture`, later this horizon, would
have hit the same wall. Capabilities now refresh on node connect, updating
already-adopted rows only and never inserting.

Invariants, each with a test: the repository is never mutated (no `git add -N`),
`GIT_OPTIONAL_LOCKS=0` on every call so we never contend with a working agent's
own git, and every invocation is an argv exec with a timeout.

Known limits, recorded in the spec: no Windows support, submodules report as
pointer moves, no fleet-wide roll-up.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01EohapceVTgobwUGTQ5LuyW
EOF
)"
```

- [ ] **Step 5: Wait for the four required checks**

```bash
gh pr checks --watch
```

Expected: `contract`, `hub`, `node-agent`, `console` all green.
