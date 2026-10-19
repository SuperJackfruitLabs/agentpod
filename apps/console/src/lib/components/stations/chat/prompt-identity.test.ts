import { expect, it } from "vitest";
import { rememberPrompt, acknowledgePrompt } from "./prompt-identity";
it("retains one logical ID across reload/failed-send retry until matching acknowledgment", () => {
  const storage = sessionStorage;
  storage.clear();
  const id = rememberPrompt(storage, "session-a", "hello");
  expect(rememberPrompt(storage, "session-a", "hello")).toBe(id);
  acknowledgePrompt(storage, "session-a", crypto.randomUUID());
  expect(rememberPrompt(storage, "session-a", "hello")).toBe(id);
  acknowledgePrompt(storage, "session-a", id);
  expect(rememberPrompt(storage, "session-a", "hello")).not.toBe(id);
});
it("changed input cannot erase an unacknowledged instruction; another session stays independent", () => {
  sessionStorage.clear();
  const first = rememberPrompt(sessionStorage, "a", "hello");
  expect(() => rememberPrompt(sessionStorage, "a", "changed")).toThrow(/previous message/i);
  expect(rememberPrompt(sessionStorage, "a", "hello")).toBe(first);
  acknowledgePrompt(sessionStorage, "a", first);
  expect(rememberPrompt(sessionStorage, "a", "changed")).not.toBe(first);
  expect(rememberPrompt(sessionStorage, "b", "hello")).not.toBe(first);
});
