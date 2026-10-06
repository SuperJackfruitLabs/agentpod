/**
 * The organization plane's settings, and the one switch every consumer path asks.
 *
 * Absent (all five unset) is today's hub, unchanged. All five set is the plane. Anything in
 * between refuses to boot: the contract's cutover rule has no dual-accept, and a half-configured
 * hub would be exactly that.
 */
import { readFileSync } from "node:fs";

export interface ServiceCredential { id: string; secret: string }
export interface OrgPlaneConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  url: string;
  serviceCredential: ServiceCredential;
}
export interface OrgPlaneConfigError { field: string; message: string }
export type OrgPlaneConfigResult =
  | { ok: true; config: OrgPlaneConfig | null }
  | { ok: false; errors: OrgPlaneConfigError[] };

const KEYS = [
  "ORG_PLANE_ISSUER",
  "ORG_PLANE_JWKS_URL",
  "ORG_PLANE_AUDIENCE",
  "ORG_PLANE_URL",
  "ORG_PLANE_SERVICE_CREDENTIAL_FILE",
] as const;
type Key = (typeof KEYS)[number];
const URL_KEYS: Key[] = ["ORG_PLANE_ISSUER", "ORG_PLANE_JWKS_URL", "ORG_PLANE_AUDIENCE", "ORG_PLANE_URL"];
const SVC = /^(svc_[0-9a-f]{20}):(\S+)$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export function readOrgPlaneConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): OrgPlaneConfigResult {
  const value = (k: Key) => (env[k] ?? "").trim();
  const present = KEYS.filter((k) => value(k) !== "");
  if (present.length === 0) return { ok: true, config: null };

  const errors: OrgPlaneConfigError[] = [];
  if (present.length !== KEYS.length) {
    for (const k of KEYS) {
      if (value(k) === "") {
        errors.push({
          field: k,
          message: `missing while ${present.join(", ")} ${present.length === 1 ? "is" : "are"} set — the org-plane settings are all-or-none`,
        });
      }
    }
    return { ok: false, errors };
  }

  for (const k of URL_KEYS) {
    try {
      const u = new URL(value(k));
      if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
        errors.push({ field: k, message: "must be https (plain http only for a loopback host)" });
      }
    } catch {
      errors.push({ field: k, message: "is not a URL" });
    }
  }

  let raw: string | null = null;
  try {
    raw = readFile(value("ORG_PLANE_SERVICE_CREDENTIAL_FILE")).trim();
  } catch {
    errors.push({ field: "ORG_PLANE_SERVICE_CREDENTIAL_FILE", message: "cannot be read" });
  }
  const m = raw === null ? null : SVC.exec(raw);
  // An empty file is malformed too: without this, the result would be a failure with no errors,
  // which validateConfig reads as "fine" and orgPlane() as legacy mode.
  if (raw !== null && !m) {
    errors.push({
      field: "ORG_PLANE_SERVICE_CREDENTIAL_FILE",
      message: "must hold one line `svc_<20 hex>:<secret>`",
    });
  }
  if (errors.length > 0 || !m) return { ok: false, errors };

  return {
    ok: true,
    config: {
      // Exact, never normalised: the contract compares `iss` as a single string.
      issuer: value("ORG_PLANE_ISSUER"),
      jwksUrl: value("ORG_PLANE_JWKS_URL"),
      audience: value("ORG_PLANE_AUDIENCE"),
      url: value("ORG_PLANE_URL").replace(/\/+$/, ""),
      serviceCredential: { id: m[1]!, secret: m[2]! },
    },
  };
}

const fromEnv = readOrgPlaneConfig(process.env);
let override: OrgPlaneConfig | null | undefined;

export function orgPlaneConfigErrors(): OrgPlaneConfigError[] {
  return fromEnv.ok ? [] : fromEnv.errors;
}

/** Null in legacy mode. The ONLY question later code asks about the mode. */
export function orgPlane(): OrgPlaneConfig | null {
  if (override !== undefined) return override;
  return fromEnv.ok ? fromEnv.config : null;
}

export function setOrgPlaneForTests(c: OrgPlaneConfig | null): () => void {
  const previous = override;
  override = c;
  return () => {
    override = previous;
  };
}

export const TEST_PLANE: OrgPlaneConfig = {
  issuer: "https://accounts.test",
  jwksUrl: "https://accounts.test/api/auth/jwks",
  audience: "https://hub.test",
  url: "https://accounts.test",
  serviceCredential: { id: "svc_0123456789abcdef0123", secret: "s3cret" },
};
