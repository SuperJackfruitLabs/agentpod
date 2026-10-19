import { z } from "zod";
import { SalaamAuthority } from "./salaam-authority";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const serverName = z.enum(["agentpod", "superlibrary"]);
const uniqueNames = (values: { name: string }[]) =>
  new Set(values.map((v) => v.name)).size === values.length;

function proxyOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(u.hostname) &&
      !!u.port &&
      !u.username &&
      !u.password &&
      u.origin === value
    );
  } catch {
    return false;
  }
}

/** Operator-reviewed affordance and policy. MCP annotations do not establish this policy. */
export const SalaamMcpProfile = z
  .object({
    version: z.literal(1),
    scope: z.literal("agentpod-proxy"),
    proxy_origin: z
      .string()
      .max(128)
      .refine(proxyOrigin, "Use a canonical literal loopback proxy origin"),
    servers: z
      .array(
        z
          .object({
            name: serverName,
            protocol_version: z.enum(["2025-06-18", "2025-11-25"]),
            catalog_digest: sha256,
            tools: z
              .array(
                z
                  .object({
                    name: z
                      .string()
                      .min(1)
                      .max(128)
                      .regex(/^[A-Za-z0-9_.-]+$/),
                    schema_digest: sha256,
                    policy: z.enum(["read", "approval"]),
                  })
                  .strict(),
              )
              .min(1)
              .max(128)
              .refine(uniqueNames, "Duplicate tool name"),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .refine(uniqueNames, "Duplicate server name"),
    limits: z
      .object({
        request_bytes: z.number().int().min(1024).max(65536),
        response_bytes: z.number().int().min(1024).max(1048576),
        timeout_ms: z.number().int().min(100).max(30000),
        calls_per_attempt: z.number().int().min(1).max(32),
      })
      .strict(),
  })
  .strict();
export type SalaamMcpProfile = z.infer<typeof SalaamMcpProfile>;

/**
 * Private node → daemon control wire ONLY. Never serialize this into Hub/ACP events,
 * provider context, tool arguments, public health or durable call receipts.
 * Shape validation is not authority: the daemon must verify the existing admission,
 * reviewed profile, generation, endpoint, and catalog before granting any call.
 */
export const SalaamMcpAssignment = z
  .object({
    version: z.literal(1),
    binding: SalaamAuthority,
    profile_digest: sha256,
    credential_generation: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER),
    servers: z
      .array(
        z
          .object({
            type: z.literal("http"),
            name: serverName,
            url: z.string().min(1).max(1024),
            headers: z
              .array(
                z
                  .object({
                    name: z.literal("X-Agentpod-Proxy-Key"),
                    value: z
                      .string()
                      .min(32)
                      .max(128)
                      .regex(/^[A-Za-z0-9_-]+$/),
                  })
                  .strict(),
              )
              .length(1),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .refine(uniqueNames, "Duplicate server name"),
  })
  .strict()
  .refine((a) => {
    const origins = new Set<string>();
    const keys = new Set<string>();
    for (const s of a.servers) {
      try {
        const u = new URL(s.url),
          parts = u.pathname.split("/");
        if (
          !proxyOrigin(u.origin) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          u.href !== s.url ||
          parts.length !== 5 ||
          parts[1] !== "stations" ||
          decodeURIComponent(parts[2]!) !== a.binding.station_id ||
          parts[3] !== "mcp" ||
          parts[4] !== (s.name === "agentpod" ? "hub" : "superlibrary")
        )
          return false;
        origins.add(u.origin);
        keys.add(s.headers[0]!.value);
      } catch {
        return false;
      }
    }
    return origins.size === 1 && keys.size === 1;
  }, "Assignment must identify one station on one loopback proxy with its exact header");
export type SalaamMcpAssignment = z.infer<typeof SalaamMcpAssignment>;
