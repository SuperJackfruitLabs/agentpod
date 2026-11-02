/**
 * The public entry point of services/salaam: the names other modules import, and nothing else.
 * Every import from outside this folder goes through here; see docs/contributor/code-quality.md.
 */
export {
  APPROVAL_RULE_SCOPES,
  AlwaysAllowRefused,
  NoOccupant,
  alwaysAllowFromAnswer,
  setApprovalRule,
} from "./approval-rules";
export {
  admitSalaamExecution,
  inspectSalaamExecution,
  isSalaamAuthorityDenied,
  makeSalaamExecution,
  renewSalaamExecution,
  revokeSalaamExecution,
  salaamStationHolder,
  validateSalaamAuthority,
} from "./authority";
export type { SalaamStationHolder } from "./authority";
export { readSalaamCancellation } from "./cancellations";
export type { SalaamCancellationState } from "./cancellations";
export { assertSalaamManagedMcp } from "./mcp";
export { bindSalaamPrompt, getSalaamPrompt, updateSalaamPrompt } from "./prompts";
export { prepareSalaamWork, workDigest } from "./work";
