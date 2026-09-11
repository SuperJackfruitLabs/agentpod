/**
 * Who is calling the hub's MCP endpoint.
 *
 * Mounted **before** `authMiddleware` and resolving its own auth, for the same reason
 * `dispatchableRoutes` is: `authMiddleware` refuses any non-human principal, which is right for
 * the operator API and wrong for a surface whose whole point is agents.
 *
 * The verification itself is `verifyHubToken` — the one shared verifier, so a key this hub
 * publishes cannot be accepted at one door and refused at another.
 */
import { verifyHubToken } from "../auth/hub-token.ts";

export interface McpCaller {
  /** The principal id from `sub`. For an agent, this is what its station is derived from. */
  principalId: string;
  kind: "human" | "agent" | "service";
}

/**
 * Resolve a bearer token, or null.
 *
 * Only `Authorization: Bearer`. Deliberately not the `?token=` query fallback `authMiddleware`
 * accepts: a credential in a URL is a credential in a log, and MCP clients have no reason to
 * need it. Narrowing what a new surface accepts is free; widening it later is not.
 */
export async function resolveMcpCaller(request: Request): Promise<McpCaller | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  if (!match) return null;

  const claims = await verifyHubToken(match[1]!);
  if (!claims) return null;

  const kind = claims.principalKind;
  if (kind !== "human" && kind !== "agent" && kind !== "service") return null;
  return { principalId: claims.sub, kind };
}

/** The refusal, in the shape an MCP client can read. */
export function mcpUnauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "This endpoint takes a hub-issued token in `Authorization: Bearer`. Get one with `apn fleet login`.",
      },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}
