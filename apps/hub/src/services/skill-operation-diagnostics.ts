const maxDiagnosticLength = 512;

/**
 * Returns a user-visible reason for an unconfirmed node operation without
 * retaining paths, control characters, or an unbounded node-supplied payload.
 */
export function unconfirmedNodeOperationReason(
  phase: "plan" | "apply" | "inspect",
  nodeError?: string,
): string {
  const fallback = `Node outcome is unknown during ${phase}; inspect the operation before retrying`;
  if (!nodeError) return fallback;

  if (nodeError === "node offline")
    return `Node is offline during ${phase}; inspect the operation before retrying`;
  if (nodeError === "node disconnected")
    return `Node disconnected during ${phase}; inspect the operation before retrying`;
  if (nodeError === "timeout")
    return `Node timed out during ${phase}; inspect the operation before retrying`;

  const detail = nodeError
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:file:\/\/)?(?:\/[\w.~-]+){2,}/g, "[path redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxDiagnosticLength);
  return detail
    ? `Node rejected ${phase}: ${detail}. Inspect the operation before retrying`
    : fallback;
}
