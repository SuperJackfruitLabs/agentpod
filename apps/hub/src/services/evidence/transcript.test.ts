import { describe, expect, test } from "bun:test";
import type { EvidenceItem } from "@agentpod/contract";

import {
  FIELD_LIMIT_BYTES,
  cutField,
  decodeCursor,
  encodeCursor,
  parseLimit,
  parseRange,
  selectPage,
  truncateItem,
  type WireItem,
} from "./transcript";

describe("parseRange", () => {
  const bounds = { first: 3, last: 40 };
  test("defaults to the session's bounds", () => expect(parseRange({}, bounds)).toEqual({ from: 3, to: 40 }));
  test("accepts a range inside them", () => expect(parseRange({ seq_from: "5", seq_to: "5" }, bounds)).toEqual({ from: 5, to: 5 }));
  for (const q of [{ seq_from: "6", seq_to: "5" }, { seq_from: "2" }, { seq_to: "41" }, { seq_from: "1e3" }, { seq_from: "" }, { seq_to: " 7" }]) {
    test(`refuses ${JSON.stringify(q)}`, () => expect(parseRange(q, bounds)).toBeNull());
  }
  test("a session with no events answers only the empty range", () => {
    expect(parseRange({}, null)).toEqual({ from: 0, to: 0 });
    expect(parseRange({ seq_from: "1" }, null)).toBeNull();
  });
});

describe("cursor and limit", () => {
  test("a cursor round-trips, and anything else is null", () => {
    expect(decodeCursor(encodeCursor(1234))).toBe(1234);
    for (const c of ["", "nonsense", Buffer.from("s:-1").toString("base64url"), Buffer.from("x:5").toString("base64url")]) {
      expect(decodeCursor(c)).toBeNull();
    }
  });
  test("limit is clamped into 1..200 and never an error", () => {
    expect([parseLimit(undefined), parseLimit("0"), parseLimit("7"), parseLimit("9999"), parseLimit("abc")]).toEqual([200, 1, 7, 200, 200]);
  });
});

describe("selectPage", () => {
  const items: EvidenceItem[] = [
    { kind: "state", seq: 1, status: "idle" },
    { kind: "message", seq_from: 2, seq_to: 9, text: "a" },
    { kind: "state", seq: 5, status: "working" },
    { kind: "other", seq: 10, type: "x" },
  ];
  test("skips items before the cursor and points at the first one it left out", () => {
    expect(selectPage(items, 2, 2)).toEqual({ page: [items[1]!, items[2]!], nextSeq: 10 });
    expect(selectPage(items, 10, 2)).toEqual({ page: [items[3]!], nextSeq: null });
  });

  test("never points back at its own start, so a pager cannot loop on out-of-order items", () => {
    // The fold keeps first seqs ascending; if that ever breaks, the page ends rather than
    // handing back a cursor that serves the same page forever.
    const outOfOrder: EvidenceItem[] = [
      { kind: "other", seq: 8, type: "x" },
      { kind: "other", seq: 7, type: "y" },
    ];
    expect(selectPage(outOfOrder, 7, 1)).toEqual({ page: [outOfOrder[0]!], nextSeq: null });
  });
});

describe("cutField", () => {
  test("a field at the limit is left alone; one byte over is cut", () => {
    expect(cutField("a".repeat(FIELD_LIMIT_BYTES))).toBeNull();
    expect(cutField("a".repeat(FIELD_LIMIT_BYTES + 1))).toEqual({ truncated: true, bytes: FIELD_LIMIT_BYTES + 1, head: "a".repeat(FIELD_LIMIT_BYTES) });
  });

  test("never splits a multi-byte character, and the head stays within 16 KiB", () => {
    // "é" is 2 bytes and "€" 3: a boundary that falls inside one must back off to its start.
    for (const s of ["a" + "é".repeat(FIELD_LIMIT_BYTES), "€".repeat(FIELD_LIMIT_BYTES)]) {
      const cut = cutField(s)!;
      expect(Buffer.byteLength(cut.head)).toBeLessThanOrEqual(FIELD_LIMIT_BYTES);
      expect(cut.head).not.toContain("�");
      expect(s.startsWith(cut.head)).toBe(true);
      expect(cut.bytes).toBe(Buffer.byteLength(s));
    }
  });

  test("JSON is measured serialised", () => {
    const v = { out: "x".repeat(FIELD_LIMIT_BYTES) };
    expect(cutField(v)).toMatchObject({ truncated: true, bytes: JSON.stringify(v).length });
  });
});

test("truncateItem cuts text, input and both halves of output, and counts each", () => {
  const big = "z".repeat(FIELD_LIMIT_BYTES + 1);
  const item = {
    kind: "tool_call", id: "t", seq_from: 1, seq_to: 1, title: big, tool_kind: null, status: "completed",
    input: { big }, output: { content: [big], raw: big }, redactions: 0,
  } as unknown as WireItem;
  const { item: out, truncated } = truncateItem(item);
  expect(truncated).toBe(4);
  expect((out.output as { raw: { truncated: boolean } }).raw.truncated).toBe(true);
  expect(out.id).toBe("t");
});
