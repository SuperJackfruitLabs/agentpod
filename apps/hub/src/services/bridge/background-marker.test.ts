import { expect, test } from "bun:test";
import { backgroundMarker } from "./dispatch-turn";

const content = (text: string) => [{ type: "content", content: { type: "text", text } }];

// The exact update a staging Hermes v0.23.1 station sent for a notify_on_complete terminal call
// (2026-11-15). Its result is Markdown text, not JSON.
const markdownTerminal = {
  kind: "execute",
  status: "completed",
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_013i4Sp2g1ApBvvjYNoRBGut",
  content: content(
    "terminal result\n- **output:** Background process started\n- **session_id:** proc_1fa5e4a37a64\n- **pid:** 859246\n- **exit_code:** 0\n- **notify_on_complete:** True",
  ),
};

test("a Markdown terminal result with notify_on_complete marks its background process", () => {
  expect(backgroundMarker(markdownTerminal, markdownTerminal.toolCallId)).toEqual({
    key: "process:proc_1fa5e4a37a64",
    label: "background process proc_1fa5e4a37a64",
  });
});

test("a Markdown terminal result without notify_on_complete is not background work", () => {
  const plain = { ...markdownTerminal, content: content("terminal result\n- **output:** ok\n- **exit_code:** 0") };
  expect(backgroundMarker(plain, plain.toolCallId)).toBeNull();
  const off = { ...markdownTerminal, content: content("terminal result\n- **session_id:** proc_x\n- **notify_on_complete:** False") };
  expect(backgroundMarker(off, off.toolCallId)).toBeNull();
});

test("the JSON forms still mark delegations and processes", () => {
  expect(backgroundMarker({ content: content('{"status":"dispatched","mode":"background","delegation_id":"deleg_1"}') }, "t1"))
    .toEqual({ key: "delegation:deleg_1", label: "delegated subtask deleg_1" });
  expect(backgroundMarker({ content: content('{"session_id":"proc_build","notify_on_complete":true}') }, "t2"))
    .toEqual({ key: "process:proc_build", label: "background process proc_build" });
});
