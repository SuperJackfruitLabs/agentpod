/**
 * Every request a checked fake board refused since the last test ended (`superpipeline-contract.ts`).
 *
 * A refused request throws at the call, but the code under test may catch it: `gate()` reads any
 * failure as "could not read it", and a dispatch parks on an error. So each refusal is also kept
 * here, and the global `afterEach` in `tests/preload.ts` fails the test that made it. No imports,
 * so the preload loads nothing else.
 */
const refused: string[] = [];

export function noteContractViolation(message: string): void {
  refused.push(message);
}

/** The refusals since the last call, cleared. */
export function takeContractViolations(): string[] {
  return refused.splice(0, refused.length);
}
