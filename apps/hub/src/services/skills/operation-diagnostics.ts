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

/**
 * Classifies a node's refusal of a read-only inspection.
 *
 * A node that refuses for a STATEABLE reason is not a node that failed, and
 * the two must not share a status. `skills/maintenance/plan` returned 502
 * "Node maintenance preview is unavailable or invalid" for two different
 * healthy refusals found on a live station -- an interrupted operation that
 * had not been resumed, and a retained backup still referenced by the live
 * head. Both are recoverable and both name what to do, yet both read to an
 * operator as a broken node, which sends the diagnosis to the wrong place.
 *
 * A conflict the node can describe becomes 409 carrying that description. A
 * transport failure -- offline, disconnected, timed out, or no answer at all
 * -- stays 502, because there the node genuinely did not answer.
 *
 * The node's text is bounded and path-redacted exactly as every other
 * node-supplied string is: it reaches an operator's screen, and a namespace
 * path is not theirs to leak.
 */
export function nodeRefusal(nodeError?: string): {
  status: 409 | 502;
  message: string;
} {
  const transport = ["timeout", "node offline", "node disconnected"];
  if (!nodeError || transport.includes(nodeError)) {
    return { status: 502, message: "Node inspection is unavailable or invalid" };
  }
  const conflict = nodeError.replace(/^skill installation conflict:\s*/, "");
  if (conflict === nodeError) {
    // Not a conflict the node named; treat as an unusable answer.
    return { status: 502, message: "Node inspection is unavailable or invalid" };
  }
  const detail = conflict
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(?:file:\/\/)?(?:\/[\w.~-]+){2,}/g, "[path redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxDiagnosticLength);
  return {
    status: 409,
    message: detail
      ? `The station refused: ${detail}. Inspect the station and resolve it before retrying`
      : "The station refused the inspection; inspect the station before retrying",
  };
}
