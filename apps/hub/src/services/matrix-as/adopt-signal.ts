/**
 * Telling a node to adopt a station's new Matrix identity — and hearing back
 * what it now answers as.
 *
 * **This is the move's only trigger.** Design §4 step 5 said "the node reports
 * the new mxid on its next detect", and the whole-branch review found there is
 * no next detect: `matrix.adopt` restarts the HARNESS, not the node-agent, so
 * the websocket whose `onOpen` calls `refreshAdoptedCapabilities`
 * (`routes/gateway.ts`) never reopens, and `GatewayClientMessage` carries no
 * mxid on any variant. Before this file the loop simply did not close — a moved
 * station worked, `stations.matrix_id` stayed stale forever, `moveState` read
 * `waiting` for good, `retireOldIdentity` never ran, the old credential stayed
 * live, and nothing landed in `principal_identities`.
 *
 * `VERB_RESULTS["matrix.adopt"]` already existed and was never parsed, so the
 * return path was there unused. The node fills it in by reading the profile it
 * just wrote back through `descriptor.MatrixIDFromProfile` — the same reader a
 * detect uses — so what arrives here is not an echo of what the hub sent but
 * the answer a detect would have given, taken at the one moment the node is
 * certainly talking to the hub about this station.
 *
 * What comes back goes into `stationReportedMatrixId`, the existing hook every
 * detect already announces through. Nothing here knows what convergence means;
 * `identity-move.ts` does, and it is wired to that hook at boot.
 *
 * **Fire-and-forget from the operator's request** (Ruling 9). The node's round
 * trip is a credential fetch, a profile write and a harness restart; blocking
 * an HTTP response on it would be a worse design, not a safer one. So the
 * caller does not await this, and every outcome below is an outcome rather than
 * a thrown error: the authorization is already committed and stands either way.
 */

import { VERB_RESULTS } from "@agentpod/contract";
import * as broker from "../broker";
import { stationReportedMatrixId } from "./hooks";
import { createLogger } from "../../utils/logger";

const log = createLogger("adopt-signal");

/** How long a node gets to fetch, write and restart before we stop waiting. */
export const ADOPT_SIGNAL_TIMEOUT_MS = 120_000;

export type AdoptSignalOutcome =
  /** The node adopted and reported an identity; it has been announced. */
  | { status: "reported"; matrixId: string }
  /**
   * The node accepted but reports no identity in the profile — the §3 failure
   * (a credential written where the harness does not look), or an older node
   * that predates the field. Either way there is nothing to converge on, and
   * the station is left exactly as it was.
   */
  | { status: "no-identity" }
  /** The node was offline, timed out, or refused. Nothing has changed. */
  | { status: "unreachable"; error: string }
  /** The node answered in a shape this hub does not understand. */
  | { status: "unreadable" };

export interface AdoptSignalDeps {
  /** Injectable so a test can drive the outcome without a websocket. */
  brokerRequest?: (
    nodeId: string,
    verb: string,
    params: unknown,
    opts?: { timeoutMs?: number }
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  /** Injectable for the same reason; defaults to the production hook. */
  report?: (stationId: string, mxid: string) => Promise<void>;
  /** The route's audit line, so a failed signal is visible where it was asked for. */
  say?: (line: string) => void;
}

/**
 * Signal one node to adopt one station's new identity, and announce whatever
 * mxid it reports back.
 *
 * Never throws: `broker.request` resolves `{ok:false}` rather than rejecting,
 * and `stationReportedMatrixId` swallows a listener's failure by contract.
 */
export async function signalNodeToAdopt(
  args: { nodeId: string; stationId: string; stationKey: string },
  deps: AdoptSignalDeps = {}
): Promise<AdoptSignalOutcome> {
  const request = deps.brokerRequest ?? broker.request;
  const report = deps.report ?? stationReportedMatrixId;
  const say = deps.say ?? ((line: string) => console.log(line));

  // Both `key` and `stationId` travel: the node's profile-directory lookup
  // needs the station KEY, the hub's redemption endpoint is keyed by the
  // station's database ID, and neither can stand in for the other (Defect 2).
  // Both are non-secret, so this stays within the broker's own constraint that
  // a credential never rides along here.
  const result = await request(
    args.nodeId,
    "matrix.adopt",
    { key: args.stationKey, stationId: args.stationId },
    { timeoutMs: ADOPT_SIGNAL_TIMEOUT_MS }
  );

  if (!result.ok) {
    const error = result.error ?? "unknown error";
    say(
      `[station-matrix] authorised ${args.stationId} but could not signal node ` +
        `${args.nodeId} to adopt it (${error}) — the authorization stands and can be ` +
        `signalled again`
    );
    return { status: "unreachable", error };
  }

  const parsed = VERB_RESULTS["matrix.adopt"].safeParse(result.data);
  if (!parsed.success) {
    log.warn("a node answered matrix.adopt in a shape this hub does not understand", {
      nodeId: args.nodeId,
      stationId: args.stationId,
    });
    return { status: "unreadable" };
  }

  const matrixId = parsed.data.matrixId;
  if (!matrixId) {
    // Said plainly rather than left silent: the station is no worse off — the
    // credential is written and the harness restarted — but it will NOT
    // converge, and the operator's panel will sit at "waiting for the node"
    // until somebody reads this line. That is §4's safe state, not a fault.
    say(
      `[station-matrix] node ${args.nodeId} adopted ${args.stationId} but its profile ` +
        `reads as no Matrix identity — this move will not converge`
    );
    return { status: "no-identity" };
  }

  // The same announcement `station-registry` makes on every detect, and
  // deliberately the same one: convergence has exactly one definition and one
  // listener (`identity-move.ts`'s `onNodeReportedMatrixId`, wired in
  // `index.ts`), so a second path to it would be a second place for the
  // irreversible step to be decided.
  await report(args.stationId, matrixId);
  return { status: "reported", matrixId };
}
