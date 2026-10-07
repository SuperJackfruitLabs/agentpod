/**
 * Who is calling the hub's MCP endpoint.
 *
 * Mounted **before** `authMiddleware` and resolving its own auth, for the same reason
 * `dispatchableRoutes` is: `authMiddleware` refuses any non-human principal, which is right for
 * the operator API and wrong for a surface whose whole point is agents.
 *
 * The verification itself is `verifyPlaneBearer` — the one shared verifier, so a key accepted at
 * one door cannot be refused at another.
 */
import { verifyPlaneBearer } from "../auth/hub-token.ts";

export interface McpCaller {
  /** The principal id from `sub`. For an agent, this is what its station is derived from. */
  principalId: string;
  kind: "human" | "agent" | "service";
}

/** An org-plane entitlement refusal, answered as the contract's 403 body (contract §2). */
export interface McpRefusal {
  refusal: { error: "product_not_enabled"; org: string };
}

/**
 * Resolve a bearer token, or null.
 *
 * Only `Authorization: Bearer`. Deliberately not the `?token=` query fallback `authMiddleware`
 * accepts: a credential in a URL is a credential in a log, and MCP clients have no reason to
 * need it. Narrowing what a new surface accepts is free; widening it later is not.
 */
export async function resolveMcpCaller(
  request: Request,
  deps: { verifyPlane?: typeof verifyPlaneBearer } = {},
): Promise<McpCaller | McpRefusal | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  if (!match) return null;

  // Agents and services are admitted here: what an agent may reach is decided by the tools it
  // is offered.
  const r = await (deps.verifyPlane ?? verifyPlaneBearer)(match[1]!);
  if (r.ok) return { principalId: r.caller.sub, kind: r.caller.principalKind };
  return r.status === 403 ? { refusal: r.body } : null;
}

/** The refusal, in the shape an MCP client can read. */
export function mcpUnauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "This endpoint takes an organization-plane token in `Authorization: Bearer`. Get one with `fleet login`.",
      },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}
