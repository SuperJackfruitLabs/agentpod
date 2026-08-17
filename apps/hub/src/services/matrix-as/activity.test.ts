// What the Matrix path does with an ACP update kind it does not handle.
//
// It used to do nothing at all — no default case, no log, no record — which is
// how `tool_call` came to be discarded for the entire life of the bridge
// without a single line anywhere saying so. The kaambaan coalescer keeps
// `unmapped()`/`losses()` for exactly this reason, and lists its dropped kinds
// explicitly "so a NEW kind shows up in `unmapped()` instead of joining this
// set by accident" (`bridge/coalesce.ts:53-62`). This is that discipline, on
// the path that lacked it.

import { beforeEach, describe, expect, it } from "bun:test";
import { _resetUnmappedForTest, noteUnmappedKind, unmappedKinds } from "./activity";

describe("unmapped session update kinds", () => {
  beforeEach(() => {
    _resetUnmappedForTest();
  });

  it("has nothing to report before anything unknown arrives", () => {
    expect(unmappedKinds()).toEqual([]);
  });

  it("reports a kind it has never seen, so the caller can log it once", () => {
    expect(noteUnmappedKind("plan")).toBe(true);
    expect(unmappedKinds()).toEqual(["plan"]);
  });

  it("does not report the same kind twice, so a busy session logs once", () => {
    // A single turn emits hundreds of the same update. A line per event would
    // bury the signal this exists to raise.
    expect(noteUnmappedKind("plan")).toBe(true);
    expect(noteUnmappedKind("plan")).toBe(false);
    expect(noteUnmappedKind("plan")).toBe(false);
    expect(unmappedKinds()).toEqual(["plan"]);
  });

  it("keeps kinds sorted, so two runs of the same fleet read the same", () => {
    noteUnmappedKind("usage_update");
    noteUnmappedKind("current_mode_update");
    noteUnmappedKind("plan");
    expect(unmappedKinds()).toEqual(["current_mode_update", "plan", "usage_update"]);
  });

  it("ignores a kind that is not a string, rather than recording garbage", () => {
    // `payload.sessionUpdate` comes off a `z.unknown()` payload — nothing
    // upstream promises it is a string, or present at all.
    expect(noteUnmappedKind(undefined as unknown as string)).toBe(false);
    expect(noteUnmappedKind(42 as unknown as string)).toBe(false);
    expect(noteUnmappedKind("")).toBe(false);
    expect(unmappedKinds()).toEqual([]);
  });
});
