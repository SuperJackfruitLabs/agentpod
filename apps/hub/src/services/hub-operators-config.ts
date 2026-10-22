/**
 * Parsing `HUB_OPERATORS` (workspace authority spec, W3). Pure — no database — so boot validation
 * (`utils/validate-config.ts`) can refuse a malformed value before anything connects. The
 * reconcile is `services/hub-operators.ts`.
 */
import { PrincipalId } from "@agentpod/contract";

export class HubOperatorsConfigError extends Error {
  constructor(readonly invalid: string[]) {
    super(
      `HUB_OPERATORS must be a comma-separated list of principal ids (prn_ followed by 20 hex characters); ` +
        `not valid: ${invalid.map((v) => JSON.stringify(v)).join(", ")}`,
    );
    this.name = "HubOperatorsConfigError";
  }
}

/** Null when unset or blank (leave the table alone); otherwise the de-duplicated ids. Throws on a malformed entry. */
export function parseHubOperators(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === "") return null;
  const entries = raw.split(",").map((s) => s.trim());
  const invalid = entries.filter((e) => !PrincipalId.safeParse(e).success);
  if (invalid.length > 0) throw new HubOperatorsConfigError(invalid);
  return [...new Set(entries)];
}
