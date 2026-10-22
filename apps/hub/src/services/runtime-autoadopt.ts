/**
 * Runtime Auto-Adopt Service
 *
 * When a provisioned node comes online, automatically detect and adopt the
 * harness station that was pre-installed in the runtime image.
 *
 * Entry point: `autoAdoptProvisionedHarness(nodeId)`
 *
 * Algorithm:
 * 1. Load the provisionedRuntimes row for this nodeId.
 * 2. If none, or harness === "none" → no-op.
 * 3. If any station is already adopted for this node → return (idempotent).
 * 4. Detect stations via broker RPC (10 s timeout).
 * 5. Parse with VERB_RESULTS.detect; pick the station whose harness matches,
 *    preferring workspacePath === "/workspace".
 * 6. Adopt that station via station-registry.
 * 7. Never throws — all errors are logged with a clear prefix.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { provisionedRuntimes } from "../db/schema/nodes";
import * as broker from "./broker";
import { adoptStations, listAdopted } from "./station-registry";
import { VERB_RESULTS } from "@agentpod/contract";
import type { DetectedStation } from "@agentpod/contract";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Injectable dependencies — used in tests to avoid a live WebSocket. */
export interface AutoAdoptDeps {
  /**
   * Drop-in replacement for broker.request.  Defaults to the real broker when
   * not supplied.  Signature matches broker.request exactly so tests can pass
   * a simple async function without extra ceremony.
   */
  brokerRequest?: (
    nodeId: string,
    verb: string,
    params: unknown,
    opts?: { timeoutMs?: number }
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect and adopt the provisioned harness station for a node that just came
 * online.  Fire-and-forget safe: the function resolves (never rejects).
 *
 * @param nodeId  The node that connected.
 * @param deps    Optional injectable deps for testing (omit in production).
 */
export async function autoAdoptProvisionedHarness(
  nodeId: string,
  deps: AutoAdoptDeps = {}
): Promise<void> {
  try {
    const brokerRequest = deps.brokerRequest ?? broker.request;

    // ── Step 1: Load the provisioned runtime row ──────────────────────────
    const rows = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.nodeId, nodeId));

    const row = rows[0];
    if (!row) {
      // No provisioned runtime linked to this node — nothing to do.
      return;
    }

    if (row.harness === "none") {
      // Generic runtime with no harness to auto-adopt.
      return;
    }

    // ── Step 2: Idempotency check ─────────────────────────────────────────
    const alreadyAdopted = await listAdopted(row.userId, nodeId, row.tenantId);
    if (alreadyAdopted.length > 0) {
      // A station was already adopted for this node — skip.
      return;
    }

    // ── Step 3: Detect stations via broker ────────────────────────────────
    const r = await brokerRequest(nodeId, "detect", {}, { timeoutMs: 10_000 });
    if (!r.ok) {
      console.log(
        `[auto-adopt] detect failed for node ${nodeId}: ${r.error ?? "unknown"}`
      );
      return;
    }

    // ── Step 4: Parse the detect result ───────────────────────────────────
    const parsed = VERB_RESULTS.detect.safeParse(r.data);
    if (!parsed.success) {
      console.log(
        `[auto-adopt] invalid detect response for node ${nodeId}:`,
        parsed.error.message
      );
      return;
    }

    const stations = parsed.data; // Station[]

    // ── Step 5: Pick the matching station ─────────────────────────────────
    const matching = stations.filter((s) => s.harness === row.harness);
    if (matching.length === 0) {
      console.log(
        `[auto-adopt] no matching harness station (harness="${row.harness}") found for node ${nodeId}`
      );
      return;
    }

    // Prefer the station with workspacePath === "/workspace"; fall back to the
    // first match if none has that path.
    const station =
      matching.find((s) => s.workspacePath === "/workspace") ?? matching[0]!;

    // ── Step 6: Build DetectedStation[] and adopt ─────────────────────────
    // adoptStations expects DetectedStation[] (Station + adopted flag).
    // The node never sets adopted — that's a hub-side annotation.
    const detected: DetectedStation[] = stations.map((s) => ({
      ...s,
      adopted: false,
    }));

    await adoptStations(row.userId, nodeId, [station.key], detected);

    console.log(
      `[auto-adopt] adopted station "${station.key}" (harness="${row.harness}") for node ${nodeId}`
    );
  } catch (err) {
    // Wrap everything so a DB hiccup or unexpected error never propagates to
    // the gateway on-open handler.
    console.error(`[auto-adopt] unexpected error for node ${nodeId}:`, err);
  }
}
