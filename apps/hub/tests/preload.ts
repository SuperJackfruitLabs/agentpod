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

afterAll(closeOpenMachines);
