/**
 * The hub's evidence routes (superwitness contract C5; charter
 * decisions/2026-10-04-superwitness-owns-observability-and-evaluation.md, decision 3).
 *
 * Read-only views over `acp_runs` and `bridge_dispatches`, for a principal whose grant holds
 * `evidence:read`. The grant is read from the database on EVERY request rather than trusted from
 * the token's `scope` claim: the hub is the issuer and can know the current answer, so narrowing
 * a grant or suspending a principal takes effect now, not in five minutes.
 *
 * Self-authenticating (a hub JWT, aud = this hub), so mounted ahead of `authMiddleware`
 * beside `dispatchableRoutes` in `index.ts`.
 */
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import type { JSONWebKeySet } from "jose";
import { UNKNOWN_FINGERPRINT_VIEW, type EvidenceFingerprint } from "@agentpod/contract";

import { publishedJwks, verifyHubToken } from "../auth/hub-token";
import { db } from "../db/drizzle";
import { acpRuns } from "../db/schema/acp";
import { bridgeDispatches } from "../db/schema/bridge";
import { tenantScope } from "../db/tenant-scope";
import { EVIDENCE_READ, getGrant } from "../services/grants";
import { principalById, principalForUser } from "../services/principals";

export interface EvidenceDeps {
  jwks?: () => Promise<JSONWebKeySet>;
  now?: () => Date;
}

type Authorized = { ok: true; tenant: string } | { ok: false; status: 401 | 403 };

async function authorize(header: string | undefined, jwks: () => Promise<JSONWebKeySet>): Promise<Authorized> {
  const match = /^Bearer +(\S+)$/i.exec((header ?? "").trim());
  if (!match) return { ok: false, status: 401 };
  const claims = await verifyHubToken(match[1]!, jwks);
  if (!claims || typeof claims.tenant !== "string" || !/^fleet_[0-9a-f]{20}$/.test(claims.tenant)) {
    return { ok: false, status: 401 };
  }
  // `sub` is a `prn_…` on service-minted tokens and a Better Auth user id on session tokens.
  const principal = (await principalById(claims.sub)) ?? (await principalForUser(claims.sub));
  if (!principal || principal.suspendedAt) return { ok: false, status: 403 };
  const grant = await getGrant(principal.id);
  if (!grant || !grant.scopes.includes(EVIDENCE_READ)) return { ok: false, status: 403 };
  return { ok: true, tenant: claims.tenant };
}

const refusal = (status: 401 | 403) => ({ error: status === 401 ? "unauthorized" : "forbidden" });

function fingerprintView(row: typeof acpRuns.$inferSelect): EvidenceFingerprint {
  if (!row.fingerprintDigest || !row.fingerprint) return UNKNOWN_FINGERPRINT_VIEW;
  return { digest: row.fingerprintDigest, ...row.fingerprint };
}

function attemptView(row: typeof acpRuns.$inferSelect) {
  return {
    id: row.id,
    station_id: row.stationId,
    session_id: row.sessionId,
    state: row.state,
    start_seq: row.startSeq,
    end_seq: row.endSeq ?? null,
    started_at: row.startedAt.toISOString(),
    ended_at: row.endedAt ? row.endedAt.toISOString() : null,
    fingerprint: fingerprintView(row),
  };
}

export function createEvidenceRoutes(deps: EvidenceDeps = {}) {
  const jwks = deps.jwks ?? publishedJwks;
  const now = deps.now ?? (() => new Date());

  return new Hono()
    .get("/api/evidence/runs/:source/:externalRunId", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks);
      if (!auth.ok) return c.json(refusal(auth.status), auth.status);
      const source = c.req.param("source");
      const runId = c.req.param("externalRunId");

      const [dispatch] = await db
        .select()
        .from(bridgeDispatches)
        .where(
          tenantScope(bridgeDispatches, auth.tenant, eq(bridgeDispatches.externalSource, source), eq(bridgeDispatches.externalRunId, runId)),
        )
        .limit(1);
      const attempts = await db
        .select()
        .from(acpRuns)
        .where(tenantScope(acpRuns, auth.tenant, eq(acpRuns.externalSource, source), eq(acpRuns.externalRunId, runId)))
        .orderBy(asc(acpRuns.startedAt), asc(acpRuns.startSeq));

      if (!dispatch && attempts.length === 0) return c.json({ error: "not_found" }, 404);

      return c.json({
        external_source: source,
        external_run_id: runId,
        board_id: dispatch?.boardId ?? null,
        card_id: dispatch?.externalCardId ?? null,
        dispatch: dispatch
          ? {
              outcome: dispatch.outcome,
              detail: dispatch.reason ?? null,
              station_id: dispatch.stationId,
              updated_at: dispatch.updatedAt.toISOString(),
            }
          : null,
        attempts: attempts.map(attemptView),
        as_of: now().toISOString(),
      });
    })
    .get("/api/evidence/attempts/:attemptId", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks);
      if (!auth.ok) return c.json(refusal(auth.status), auth.status);
      const [row] = await db
        .select({ externalSource: acpRuns.externalSource, externalRunId: acpRuns.externalRunId })
        .from(acpRuns)
        .where(tenantScope(acpRuns, auth.tenant, eq(acpRuns.id, c.req.param("attemptId"))))
        .limit(1);
      if (!row) return c.json({ error: "not_found" }, 404);

      let boardId: string | null = null;
      if (row.externalSource && row.externalRunId) {
        const [d] = await db
          .select({ boardId: bridgeDispatches.boardId })
          .from(bridgeDispatches)
          .where(
            tenantScope(bridgeDispatches, auth.tenant, eq(bridgeDispatches.externalSource, row.externalSource), eq(bridgeDispatches.externalRunId, row.externalRunId)),
          )
          .limit(1);
        boardId = d?.boardId ?? null;
      }
      return c.json({ external_source: row.externalSource ?? null, external_run_id: row.externalRunId ?? null, board_id: boardId });
    });
}

export const evidenceRoutes = createEvidenceRoutes();
