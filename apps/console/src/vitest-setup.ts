import { afterEach } from "vitest";
import { cleanup } from "@testing-library/svelte";

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
