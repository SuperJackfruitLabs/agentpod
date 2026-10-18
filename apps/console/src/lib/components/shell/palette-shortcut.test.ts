import { expect, test, vi } from "vitest";
import { onPaletteShortcut } from "./palette-shortcut";

test.each([
  [{ key: "k", metaKey: true }, true],
  [{ key: "k", ctrlKey: true }, true],
  [{ key: "k" }, false],
  [{ key: "j", metaKey: true }, false],
])("Cmd/Ctrl+K opens the palette: %o", (init, opens) => {
  const toggle = vi.fn();
  const e = new KeyboardEvent("keydown", { ...init, cancelable: true });
  onPaletteShortcut(e, toggle);
  expect(toggle).toHaveBeenCalledTimes(opens ? 1 : 0);
  expect(e.defaultPrevented).toBe(opens);
});
