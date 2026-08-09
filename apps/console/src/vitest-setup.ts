import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

// jsdom doesn't implement scrollIntoView at all. bits-ui's Command primitive
// calls it unconditionally when the selected item changes (on mount, on
// filter, on hover) to keep the highlighted row in view. Without a stub,
// every test that mounts a Command list throws "scrollIntoView is not a
// function" as an unhandled rejection from bits-ui's internal afterTick.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no ResizeObserver. bits-ui's floating-layer (used by Tooltip,
// Popover, Select, ...) instantiates one as soon as its content mounts —
// e.g. when a focusable tab receives focus and its tooltip opens. Without a
// stub, any test that focuses such an element throws
// "ResizeObserver is not a constructor" as an unhandled exception.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom has no matchMedia. The theme store resolves the "system" colour scheme
// with it at module-initialisation time (src/lib/themes/store.svelte.ts), so any
// test that transitively imports a themed component (Terminal, the monaco
// editor, the station page) crashes during module evaluation without it. Report
// light mode and no listeners — tests never assert on the resolved scheme.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// Unmount components, then let bits-ui's 24ms body-scroll-lock cleanup timer
// fire while the DOM still exists. Without the flush, the last dialog-using
// test in a file races vitest's environment teardown and crashes with
// "document is not defined" (deterministic on CI's Node 24 — seen from
// CleanupPanel and NewRuntimeDialog test files). Global because ANY test that
// mounts a bits-ui dialog can be the one holding the pending timer.
afterEach(async () => {
  cleanup();
  await new Promise((r) => setTimeout(r, 40));
});
