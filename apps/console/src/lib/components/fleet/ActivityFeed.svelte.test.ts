/**
 * ActivityFeed.svelte.test.ts
 *
 * The whole point of this component is that a machine hammering the same
 * verb 18 times in a row is ONE fact, not 18 lines of scrollback. So most
 * of these tests are about the collapsing rule and its edges.
 *
 * One test pins a class instead of behaviour (`relative` on each row),
 * because vitest.config.ts strips <style> and sets css:false — computed
 * styles are unavailable here — and that class guards a real layout bug
 * (see the comment on that test).
 */
import { test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import type { ActivityRow } from "$lib/api/client";
import ActivityFeed from "./ActivityFeed.svelte";

const T0 = Date.parse("2026-09-02T12:00:00.000Z");

/** Newest-first, the order GET /api/activity returns. */
function row(i: number, partial: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: `aud_${i}`,
    verb: "posture.scan",
    stationKey: "claude-code:atlas",
    nodeId: "n_orion_0123456789",
    result: "ok",
    createdAt: new Date(T0 - i * 60_000).toISOString(),
    ...partial,
  };
}

test("18 consecutive identical rows collapse into one row carrying ×18", () => {
  const rows = Array.from({ length: 18 }, (_, i) => row(i));

  const { getAllByTestId, getByTestId } = render(ActivityFeed, { props: { rows } });

  expect(getAllByTestId("activity-row")).toHaveLength(1);
  expect(getByTestId("activity-repeat").textContent?.trim()).toBe("×18");
});

test("a different verb between two identical ones prevents collapsing", () => {
  const rows = [
    row(0, { verb: "posture.scan" }),
    row(1, { verb: "fs.write" }),
    row(2, { verb: "posture.scan" }),
  ];

  const { getAllByTestId, queryByTestId } = render(ActivityFeed, { props: { rows } });

  const rendered = getAllByTestId("activity-row");
  expect(rendered).toHaveLength(3);
  // Nothing collapsed, so no row wears a count.
  expect(queryByTestId("activity-repeat")).toBeNull();
  expect(rendered[0].textContent).toContain("posture.scan");
  expect(rendered[1].textContent).toContain("fs.write");
  expect(rendered[2].textContent).toContain("posture.scan");
});

test("the same verb with a different result does not collapse", () => {
  const rows = [
    row(0, { verb: "acp.prompt", result: "ok" }),
    row(1, { verb: "acp.prompt", result: "error" }),
    row(2, { verb: "acp.prompt", result: "error" }),
  ];

  const { getAllByTestId, getAllByTestId: all } = render(ActivityFeed, { props: { rows } });

  expect(getAllByTestId("activity-row")).toHaveLength(2);
  // The two errors are the ones that merged.
  expect(all("activity-repeat")).toHaveLength(1);
  expect(all("activity-repeat")[0].textContent?.trim()).toBe("×2");
});

test("a single row shows no count badge", () => {
  const { queryByTestId, getAllByTestId } = render(ActivityFeed, {
    props: { rows: [row(0)] },
  });

  expect(getAllByTestId("activity-row")).toHaveLength(1);
  expect(queryByTestId("activity-repeat")).toBeNull();
});

test("limit caps the COLLAPSED rows, so one burst can't eat the whole feed", () => {
  // 18 identical, then three distinct verbs. With a limit of 3 the burst is
  // one row and the next two verbs still get in.
  const rows = [
    ...Array.from({ length: 18 }, (_, i) => row(i)),
    row(20, { verb: "fs.write" }),
    row(21, { verb: "term.open" }),
    row(22, { verb: "cleanup.apply" }),
  ];

  const { getAllByTestId } = render(ActivityFeed, { props: { rows, limit: 3 } });

  const rendered = getAllByTestId("activity-row");
  expect(rendered).toHaveLength(3);
  expect(rendered[0].textContent).toContain("×18");
  expect(rendered[1].textContent).toContain("fs.write");
  expect(rendered[2].textContent).toContain("term.open");
});

test("a row carries its verb, its subject and its result in words", () => {
  const { getAllByTestId } = render(ActivityFeed, {
    props: { rows: [row(0, { verb: "changeset.diff", result: "error" })] },
  });

  const text = getAllByTestId("activity-row")[0].textContent ?? "";
  expect(text).toContain("changeset.diff");
  expect(text).toContain("claude-code:atlas");
  expect(text).toContain("error");
});

test("the tick takes its colour from the result: ok → running, pending → unknown, error → error", () => {
  const { getAllByTestId } = render(ActivityFeed, {
    props: {
      rows: [
        row(0, { verb: "a.one", result: "ok" }),
        row(1, { verb: "b.two", result: "pending" }),
        row(2, { verb: "c.three", result: "error" }),
      ],
    },
  });

  const ticks = getAllByTestId("activity-tick");
  expect(ticks[0].innerHTML).toContain("bg-status-running");
  expect(ticks[1].innerHTML).toContain("bg-status-unknown");
  expect(ticks[2].innerHTML).toContain("bg-status-error");
});

test("a row with no result at all reads as unknown rather than as nothing", () => {
  const { getAllByTestId } = render(ActivityFeed, {
    props: { rows: [row(0, { result: undefined })] },
  });

  expect(getAllByTestId("activity-tick")[0].innerHTML).toContain("bg-status-unknown");
  expect(getAllByTestId("activity-row")[0].textContent).toContain("unknown");
});

test("a row with no station falls back to the node rather than rendering blank", () => {
  const { getAllByTestId } = render(ActivityFeed, {
    props: { rows: [row(0, { stationKey: undefined, nodeId: "n_vega_9876543210" })] },
  });

  expect(getAllByTestId("activity-row")[0].textContent).toContain("n_vega_9");
});

test("with no rows the feed says so in words", () => {
  const { getByTestId, queryAllByTestId } = render(ActivityFeed, { props: { rows: [] } });

  expect(queryAllByTestId("activity-row")).toHaveLength(0);
  expect(getByTestId("activity-empty").textContent).toContain("No activity yet");
});

test("every row is `relative` — a StateDot's sr-only label must not escape the page", () => {
  // StateDot's sr-only word is position:absolute. Without a positioned
  // ancestor its containing block is the initial one, so overflow:hidden
  // does not clip it and it DOES add to the document's scroll width — it
  // dragged a 1500px viewport to 1828px in the attention lane. Every row
  // that holds a dot needs `relative`.
  const { getAllByTestId } = render(ActivityFeed, { props: { rows: [row(0), row(1, { verb: "fs.move" })] } });

  for (const el of getAllByTestId("activity-row")) {
    expect(el.className).toContain("relative");
  }
});

test("the feed scrolls horizontally inside itself, never the page", () => {
  const { getByTestId } = render(ActivityFeed, { props: { rows: [row(0)] } });

  expect(getByTestId("activity-feed").className).toContain("overflow-x-auto");
});
