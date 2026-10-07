/**
 * Loaded before every `bun test` run (see bunfig.toml).
 *
 * Closes any Matrix crypto machine a test left open, once, after the last test
 * file. An `OlmMachine` still open when bun test exits aborts the whole run
 * with SIGABRT from inside napi-rs — after every test has passed (issue #457,
 * PR #618's hub job). bun test does not run `process.on('exit')` listeners,
 * so the one in `open-machines.ts` never fires here; a global `afterAll` does,
 * and before napi tears down its runtime.
 *
 * `open-machines.ts` has no imports, so loading it here pulls in neither the
 * native binding nor config before a test has set its environment.
 */

import { afterAll } from "bun:test";
import { closeOpenMachines } from "../src/services/matrix-as/open-machines";
import { shutdownTelemetry } from "../src/telemetry/otel";
import { installFakePlane } from "./helpers/fake-plane";

/**
 * The organization plane is the hub's only issuer and the only home of its principals (P3 plan,
 * Task 17), so every test runs against one: `TEST_PLANE`'s settings, and an in-memory plane
 * (`helpers/fake-plane.ts`) behind the real client, directory and verifier seams. A test that
 * needs a different plane (one that is down, one that refuses) overrides a seam and restores it.
 *
 * The directory has a zero TTL so a test reads its own writes at once; its last-good fallback
 * still works, which the outage tests rely on.
 */
installFakePlane();

afterAll(async () => {
  await closeOpenMachines();
  // After the crypto machines (ws1 A2): an exporting provider left open must not keep
  // bun test alive or abort it. A no-op when no test started one. Never throws: a
  // collector that is down must not fail the run.
  try {
    await shutdownTelemetry(1_000);
  } catch {
    // best effort
  }
});
