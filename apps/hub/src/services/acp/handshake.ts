/**
 * The ACP client over a wire: the SDK connection, `initialize` (and Salaam's feature check),
 * `session/new` or `session/load`; the acp.open options; and the proxied MCP tools.
 */

import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection } from "@agentclientprotocol/sdk";
import { SalaamAcpFeatures, SalaamExecutionFeatures } from "@agentpod/contract";
import { acpTraceMeta } from "../../telemetry/propagation";
import { assertSalaamManagedMcp, readSalaamCancellation } from "../salaam";
import { handlePermissionRequest } from "./permissions";
import { liveById, type LiveSession } from "./session-state";
import { HANDSHAKE_TIMEOUT_MESSAGE, handshakeTimeoutMs, withDeadline } from "./timing";
import type { AcpWire, OpenAcpWireOptions } from "./transport";
import { handleSessionUpdate } from "./updates";

/** What a session does when its wire closes: `recovery.ts`'s `handleWireClosed`, passed in. */
export type WireClosedHandler = (live: LiveSession, reason: string, closedWire: AcpWire) => Promise<void>;

/**
 * Build the ACP client over a wire and complete the handshake.
 *
 * Shared by the first open and by a re-attach, so the two can never drift into
 * handshaking differently — which would mean a resumed session quietly having
 * different capabilities from the one it replaced.
 */
export async function connectAndHandshake(
  live: LiveSession,
  wire: AcpWire,
  onClosed: WireClosedHandler,
): Promise<void> {
  if (live.executionAuthority) {
    live.managedMcpVerified = false;
    const cancellation = await readSalaamCancellation(live.id);
    live.pendingCancellation =
      cancellation && cancellation.state !== "confirmed"
        ? cancellation
        : undefined;
  }
  const connection = bindClient(live, wire, onClosed);
  await initializeAgent(live, connection, wire);
  await openAgentSession(live, connection);
}

/** The SDK client over the wire, its callbacks bound to this session, and the close watch. */
function bindClient(live: LiveSession, wire: AcpWire, onClosed: WireClosedHandler): ClientConnection {
  const app = client({ name: "agentpod-hub" })
    .onNotification("session/update", ({ params }) => {
      handleSessionUpdate(live, params);
    })
    .onRequest("session/request_permission", ({ params }) =>
      handlePermissionRequest(live, params),
    );
  const connection = app.connect(ndJsonStream(wire.writable, wire.readable));
  live.connection = connection;
  live.agent = connection.agent;
  connection.closed.catch(() => {
    // Post-exit stream errors surface here; teardown runs via wire.closed.
  });
  void wire.closed.then(
    (reason) => {
      if (live.wire === wire) void onClosed(live, reason, wire);
    },
    () => {
      if (live.wire === wire) void onClosed(live, "wire error", wire);
    },
  );
  return connection;
}

/** `initialize`, with Salaam's features asked for and checked, and whether images are taken. */
async function initializeAgent(live: LiveSession, connection: ClientConnection, wire: AcpWire): Promise<void> {
  const initialized = await withDeadline(
    connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: live.executionAuthority
        ? {
            _meta: {
              "salaam.dev/features": { promptReceipts: 1, updateIds: 1 },
              "salaam.dev/executionFeatures": {
                failures: 1,
                cancellationReceipts: 1,
                toolSemantics: 1,
              },
            },
          }
        : {},
      clientInfo: { name: "agentpod-hub", version: "0.1.0" },
    }),
    handshakeTimeoutMs,
    HANDSHAKE_TIMEOUT_MESSAGE,
  );
  // Read, not assumed: every adapter probed on 2026-09-24 says yes, and the one
  // that someday says no should get a note instead of a failed turn.
  if (live.executionAuthority) {
    const meta = (initialized as { _meta?: Record<string, unknown> })._meta;
    if (!SalaamAcpFeatures.safeParse(meta?.["salaam.dev/features"]).success)
      throw Error(
        "Upgrade the Salaam adapter: durable prompt receipt and history support is required",
      );
    if (
      !SalaamExecutionFeatures.safeParse(meta?.["salaam.dev/executionFeatures"])
        .success
    )
      throw Error(
        "Upgrade the Salaam adapter: typed failures and confirmed cancellation receipts are required",
      );
    assertSalaamManagedMcp(initialized, wire.mcpProxy);
    live.managedMcpVerified = wire.mcpProxy.length > 0;
  }
  live.acceptsImages =
    (
      initialized as
        | { agentCapabilities?: { promptCapabilities?: { image?: boolean } } }
        | undefined
    )?.agentCapabilities?.promptCapabilities?.image === true;
}

/** `session/new`, or `session/load` for a Salaam session that already has one, and its identity. */
async function openAgentSession(live: LiveSession, connection: ClientConnection): Promise<void> {
  const created = await withDeadline(
    connection.agent.request(
      live.executionAuthority?.sessionId ? "session/load" : "session/new",
      {
        ...(live.executionAuthority?.sessionId
          ? { sessionId: live.executionAuthority.sessionId }
          : {}),
        // The SDK requires an absolute cwd; the station workspace is the natural
        // one, "/" the fallback for workspace-less stations.
        cwd: live.workspacePath ?? "/",
        mcpServers: live.mcpServers,
        // superwitness C2: the harness may continue the run's trace. Ids only.
        ...acpTraceMeta(),
      },
    ),
    handshakeTimeoutMs,
    HANDSHAKE_TIMEOUT_MESSAGE,
  );
  // ACP session/load accepts the supplied id and normally returns no sessionId.
  const returnedSession = (created as { sessionId?: string }).sessionId;
  if (
    live.executionAuthority?.sessionId &&
    returnedSession !== undefined &&
    returnedSession !== live.executionAuthority.sessionId
  )
    throw Error("Salaam ACP resumed a different session");
  live.acpSessionId = (live.executionAuthority?.sessionId ?? returnedSession)!;
  if (!live.acpSessionId)
    throw Error("ACP handshake returned no session identity");
}

/** The acp.open options a session's (re-)open sends. */

export function proxyOptions(live: LiveSession): OpenAcpWireOptions {
  return {
    ...(live.mcpProxyRequested
      ? { mcpProxy: { stationId: live.stationId } }
      : {}),
    ...(live.executionAuthority
      ? { salaamAuthority: live.executionAuthority.binding }
      : {}),
  };
}

/** The names the node's proxy gives its two servers (node-agent internal/mcpproxy). */
const PROXIED_HUB = "agentpod";
const PROXIED_SUPERLIBRARY = "superlibrary";

/**
 * Does this live session carry BOTH the hub's MCP server and Superlibrary's, through its node's
 * proxy? The card prompt names `agentpod_link_artifact` and `library_search` on this alone
 * (S3-R12): a prompt naming a tool the session lacks sends the agent into a failing call.
 */
export function sessionHasLibraryTools(sessionId: string): boolean {
  const live = liveById.get(sessionId);
  return (
    !!live &&
    (live.harness !== 'salaam' || live.managedMcpVerified === true) &&
    live.mcpProxied.includes(PROXIED_HUB) &&
    live.mcpProxied.includes(PROXIED_SUPERLIBRARY)
  );
}
