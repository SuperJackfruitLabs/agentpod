/** Cmd+K (macOS) or Ctrl+K anywhere opens or closes the command palette. */
export function onPaletteShortcut(e: KeyboardEvent, toggle: () => void): void {
  if ((e.metaKey || e.ctrlKey) && e.key === "k") {
    e.preventDefault();
    toggle();
  }
}
