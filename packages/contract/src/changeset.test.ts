import { test, expect } from "bun:test";
import { Capability } from "./station";
import { ChangesetStatus, ChangesetDiff, ChangesetFile } from "./changeset";
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
