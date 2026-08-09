import { test, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import PromptInput from "./PromptInput.svelte";

function setup(props: Partial<{ disabled: boolean; working: boolean }> = {}) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  const utils = render(PromptInput, {
    props: { working: false, onSend, onCancel, ...props },
  });
  const textarea = utils.getByPlaceholderText("Message the agent…") as HTMLTextAreaElement;
  return { ...utils, onSend, onCancel, textarea };
}

test("Enter sends the trimmed text and clears the box", async () => {
  const { textarea, onSend } = setup();

  await fireEvent.input(textarea, { target: { value: "  hello agent  " } });
  await fireEvent.keyDown(textarea, { key: "Enter" });

  expect(onSend).toHaveBeenCalledWith("hello agent");
  expect(textarea.value).toBe("");
});

test("Shift+Enter does not send", async () => {
  const { textarea, onSend } = setup();

  await fireEvent.input(textarea, { target: { value: "line one" } });
  await fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

  expect(onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe("line one");
});

test("Enter with only whitespace does not send", async () => {
  const { textarea, onSend } = setup();

  await fireEvent.input(textarea, { target: { value: "   " } });
  await fireEvent.keyDown(textarea, { key: "Enter" });

  expect(onSend).not.toHaveBeenCalled();
});

test("Enter during IME composition does not send", async () => {
  const { textarea, onSend } = setup();

  await fireEvent.input(textarea, { target: { value: "こんにちは" } });
  await fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });

  expect(onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe("こんにちは");
});

test("send button sends and is disabled while empty", async () => {
  const { getByRole, textarea, onSend } = setup();

  const send = getByRole("button", { name: "Send" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);

  await fireEvent.input(textarea, { target: { value: "do the thing" } });
  expect(send.disabled).toBe(false);

  await fireEvent.click(send);
  expect(onSend).toHaveBeenCalledWith("do the thing");
  expect(textarea.value).toBe("");
});

test("working shows a stop button that calls onCancel; Send is absent", async () => {
  const { getByRole, queryByRole, textarea, onSend, onCancel } = setup({ working: true });

  const stop = getByRole("button", { name: "Stop the current turn" });
  expect(queryByRole("button", { name: "Send" })).toBeNull();

  await fireEvent.click(stop);
  expect(onCancel).toHaveBeenCalledTimes(1);

  // Enter while working keeps the draft instead of silently losing it.
  await fireEvent.input(textarea, { target: { value: "queued thought" } });
  await fireEvent.keyDown(textarea, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(textarea.value).toBe("queued thought");
});

test("disabled disables the textarea", () => {
  const { textarea } = setup({ disabled: true });
  expect(textarea.disabled).toBe(true);
});
