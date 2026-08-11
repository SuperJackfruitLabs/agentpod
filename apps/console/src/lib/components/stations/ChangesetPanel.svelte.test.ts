import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, cleanup } from "@testing-library/svelte";
import * as api from "$lib/api/client";
// Static import ensures module is compiled during file collection, so the
// first test doesn't pay the compilation cost inside its waitFor window.
import ChangesetPanel from "./ChangesetPanel.svelte";

beforeEach(() => vi.restoreAllMocks());
afterEach(cleanup); // scroll-lock timer flush lives in src/vitest-setup.ts

const CLEAN: api.ChangesetStatusResult = {
  repo: { branch: "main", head: "abc1234", detached: false },
  base: { ref: "origin/main", sha: "def5678", reason: "upstream" },
  uncommitted: { files: [], insertions: 0, deletions: 0 },
  committed: { files: [], insertions: 0, deletions: 0, commits: [] },
  truncatedFiles: false,
};

const DIRTY: api.ChangesetStatusResult = {
  ...CLEAN,
  uncommitted: {
    files: [
      { path: "src/a.ts", oldPath: null, status: "modified", insertions: 12, deletions: 3, binary: false },
      { path: "notes.md", oldPath: null, status: "untracked", insertions: null, deletions: null, binary: false },
    ],
    insertions: 12,
    deletions: 3,
  },
  committed: {
    files: [
      { path: "src/b.ts", oldPath: null, status: "added", insertions: 5, deletions: 0, binary: false },
    ],
    insertions: 5,
    deletions: 0,
    commits: [
      {
        sha: "9f1c2ab",
        shortSha: "9f1c2ab",
        subject: "agent work",
        author: "codex",
        committedAt: "2026-08-11T09:15:00Z",
      },
    ],
  },
};

test("says which base it used and why", async () => {
  // Without this, a surprising diff on a machine you are not sitting at is
  // unexplainable — "no upstream, so only uncommitted work is shown" is a
  // different situation from "diffed against your upstream".
  vi.spyOn(api, "changesetStatus").mockResolvedValue(CLEAN);
  const { getByText, container } = render(ChangesetPanel, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("origin/main")).toBeTruthy());
  expect(container.textContent).toMatch(/upstream/i);
});

test("explains a HEAD base as showing uncommitted work only", async () => {
  vi.spyOn(api, "changesetStatus").mockResolvedValue({
    ...CLEAN,
    base: { ref: "HEAD", sha: "abc1234", reason: "head" },
  });
  const { container } = render(ChangesetPanel, { props: { stationId: "station_1" } });

  await waitFor(() => expect(container.textContent).toMatch(/uncommitted work/i));
});

test("a clean workspace says so rather than showing an empty list", async () => {
  vi.spyOn(api, "changesetStatus").mockResolvedValue(CLEAN);
  const { getByText } = render(ChangesetPanel, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText(/no changes/i)).toBeTruthy());
});

test("lists uncommitted and committed work separately", async () => {
  vi.spyOn(api, "changesetStatus").mockResolvedValue(DIRTY);
  const { getByText, container } = render(ChangesetPanel, { props: { stationId: "station_1" } });

  await waitFor(() => expect(getByText("src/a.ts")).toBeTruthy());
  expect(getByText("src/b.ts")).toBeTruthy();
  expect(container.textContent).toMatch(/agent work/);
  // The two sides must be labelled distinctly — they are different situations.
  expect(container.textContent).toMatch(/uncommitted/i);
  expect(container.textContent).toMatch(/committed, not on the base/i);
});

test("an untracked file is labelled and shows no line counts", async () => {
  vi.spyOn(api, "changesetStatus").mockResolvedValue(DIRTY);
  const { getByText, getByTestId } = render(ChangesetPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("notes.md")).toBeTruthy());
  const row = getByTestId("changeset-file-notes.md");
  expect(row.textContent).toMatch(/untracked/i);
  // A "+0 −0" here would read as "nothing in this file", which is a lie.
  expect(row.textContent).not.toMatch(/[+−-]\d/);
});

test("clicking a file fetches that file's patch", async () => {
  vi.spyOn(api, "changesetStatus").mockResolvedValue(DIRTY);
  const diff = vi.spyOn(api, "changesetDiff").mockResolvedValue({
    content: "@@ -1 +1 @@\n-one\n+two\n",
    truncated: false,
    binary: false,
  });

  const { getByText, getByTestId } = render(ChangesetPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("src/a.ts")).toBeTruthy());
  fireEvent.click(getByTestId("changeset-file-src/a.ts"));

  await waitFor(() =>
    expect(diff).toHaveBeenCalledWith("station_1", "uncommitted", "src/a.ts")
  );
});

test("a committed file is fetched from the committed side", async () => {
  // Sending the wrong side returns someone else's diff, or nothing at all.
  vi.spyOn(api, "changesetStatus").mockResolvedValue(DIRTY);
  const diff = vi.spyOn(api, "changesetDiff").mockResolvedValue({
    content: "@@ -0,0 +1 @@\n+new\n",
    truncated: false,
    binary: false,
  });

  const { getByText, getByTestId } = render(ChangesetPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("src/b.ts")).toBeTruthy());
  fireEvent.click(getByTestId("changeset-file-src/b.ts"));

  await waitFor(() =>
    expect(diff).toHaveBeenCalledWith("station_1", "committed", "src/b.ts")
  );
});

test("a truncated patch says so", async () => {
  vi.spyOn(api, "changesetStatus").mockResolvedValue(DIRTY);
  vi.spyOn(api, "changesetDiff").mockResolvedValue({
    content: "@@ -1 +1 @@\n+partial",
    truncated: true,
    binary: false,
  });

  const { getByText, getByTestId, container } = render(ChangesetPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("src/a.ts")).toBeTruthy());
  fireEvent.click(getByTestId("changeset-file-src/a.ts"));

  await waitFor(() => expect(container.textContent).toMatch(/truncated/i));
});

test("a capped file list says the view is partial", async () => {
  // Silently showing 1000 of 4000 files reads as "that is everything".
  vi.spyOn(api, "changesetStatus").mockResolvedValue({ ...DIRTY, truncatedFiles: true });
  const { container } = render(ChangesetPanel, { props: { stationId: "station_1" } });

  await waitFor(() => expect(container.textContent).toMatch(/partial|too many/i));
});

test("a failed load shows the error instead of an empty panel", async () => {
  vi.spyOn(api, "changesetStatus").mockRejectedValue(new Error("node offline"));
  const { container } = render(ChangesetPanel, { props: { stationId: "station_1" } });

  await waitFor(() => expect(container.textContent).toMatch(/node offline/));
});

test("a failed diff does not blank the file list", async () => {
  // The status is still good; only the patch failed. Losing the list would
  // make the panel look broken.
  vi.spyOn(api, "changesetStatus").mockResolvedValue(DIRTY);
  vi.spyOn(api, "changesetDiff").mockRejectedValue(new Error("git exploded"));

  const { getByText, getByTestId, container } = render(ChangesetPanel, {
    props: { stationId: "station_1" },
  });

  await waitFor(() => expect(getByText("src/a.ts")).toBeTruthy());
  fireEvent.click(getByTestId("changeset-file-src/a.ts"));

  await waitFor(() => expect(container.textContent).toMatch(/git exploded/));
  // The row itself must survive — getByText would now match twice, because the
  // open patch card also shows the path in its title.
  expect(getByTestId("changeset-file-src/a.ts")).toBeTruthy();
  expect(getByTestId("changeset-file-notes.md")).toBeTruthy();
});
