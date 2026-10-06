/**
 * The hub's evidence routes: runs, attempts and principals (superwitness contract C5; charter
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
import { and, asc, eq } from "drizzle-orm";
import type { JSONWebKeySet } from "jose";
import { PrincipalId, UNKNOWN_FINGERPRINT_VIEW, itemFirstSeq, type EvidenceFingerprint } from "@agentpod/contract";

import { publishedJwks, verifyHubToken } from "../auth/hub-token";
import { db } from "../db/drizzle";
import { acpRuns } from "../db/schema/acp";
import { bridgeDispatches } from "../db/schema/bridge";
import { principalIdentities } from "../db/schema/identities";
import { principals } from "../db/schema/organization";
import { stations } from "../db/schema/stations";
import { tenantScope } from "../db/tenant-scope";
import {
  ITEM_LIMIT_BYTES,
  byteLength,
  decodeCursor,
  encodeCursor,
  findSession,
  foldRange,
  parseLimit,
  parseRange,
  redactItem,
  selectPage,
  sessionBounds,
  truncateItem,
  type SessionRef,
  type WireItem,
} from "../services/evidence/transcript";
import { recordAudit } from "../services/audit";
import { EVIDENCE_READ, TRANSCRIPTS_READ, getGrant, type GrantScope } from "../services/grants";
import { principalById, principalForUser } from "../services/principals";
import { contentRedactor } from "../services/redact-content";

export interface EvidenceDeps {
  jwks?: () => Promise<JSONWebKeySet>;
  now?: () => Date;
}

type Authorized = { ok: true; tenant: string; principalId: string } | { ok: false; status: 401 | 403 };

/** Each route names the ONE scope it needs; holding another never stands in for it. */
async function authorize(
  header: string | undefined,
  jwks: () => Promise<JSONWebKeySet>,
  scope: GrantScope,
): Promise<Authorized> {
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
  if (!grant || !grant.scopes.includes(scope)) return { ok: false, status: 403 };
  return { ok: true, tenant: claims.tenant, principalId: principal.id };
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
    agent_principal_id: row.agentPrincipalId ?? null,
    fingerprint: fingerprintView(row),
  };
}

/**
 * A path segment -> a principal id. Either it already IS one, or it is a hub auth user id
 * (superpipeline's `decided_by_hub_sub`: the `sub` a session-minted token carries, because Better
 * Auth's jwt plugin overwrites `sub` with the user id) linked through `principal_identities`.
 * The same table `userIdForTokenSubject` reads, in the other direction. Anything else is null.
 */
async function principalIdFor(segment: string): Promise<string | null> {
  if (PrincipalId.safeParse(segment).success) return segment;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(segment)) return null;
  const [row] = await db
    .select({ principalId: principalIdentities.principalId })
    .from(principalIdentities)
    .where(and(eq(principalIdentities.system, "better-auth"), eq(principalIdentities.externalId, segment)))
    .limit(1);
  return row?.principalId ?? null;
}

/** `X-On-Behalf-Of`, kept only when it is a principal id. Recorded, never used to authorise. */
function onBehalfOf(header: string | undefined): string | null {
  const v = header?.trim() ?? "";
  return PrincipalId.safeParse(v).success ? v : null;
}

/**
 * One `station_audit` row per transcript read. Ids and counts only — `sanitizeParams` in
 * `services/audit.ts` drops any key it does not list, so content cannot ride along by accident.
 * A session outlives its station, so a deleted station's row names the session's station id.
 */
async function auditTranscriptRead(args: {
  principalId: string;
  onBehalfOf: string | null;
  session: SessionRef;
  seqFrom: number;
  seqTo: number;
  items: number;
  redactions: number;
  full: boolean;
  error?: string;
}): Promise<void> {
  const [station] = await db
    .select({ nodeId: stations.nodeId, stationKey: stations.stationKey })
    .from(stations)
    .where(eq(stations.id, args.session.stationId))
    .limit(1);
  const audit = await recordAudit(db, {
    userId: args.principalId,
    nodeId: station?.nodeId ?? "unknown",
    stationKey: station?.stationKey ?? args.session.stationId,
    verb: "evidence.transcript.read",
    params: {
      sessionId: args.session.id,
      seq_from: args.seqFrom,
      seq_to: args.seqTo,
      items: args.items,
      redactions: args.redactions,
      full: args.full,
      ...(args.onBehalfOf ? { on_behalf_of: args.onBehalfOf } : {}),
    },
  });
  await audit.done(args.error ? "error" : "ok", args.error);
}

export function createEvidenceRoutes(deps: EvidenceDeps = {}) {
  const jwks = deps.jwks ?? publishedJwks;
  const now = deps.now ?? (() => new Date());

  return new Hono()
    .get("/api/evidence/runs/:source/:externalRunId", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks, EVIDENCE_READ);
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
      const auth = await authorize(c.req.header("authorization"), jwks, EVIDENCE_READ);
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
    })
    /**
     * A principal's kind, handle and suspension, so superwitness can derive `judge_kind` for a
     * verdict it did not receive from the caller (C5, C6b). Not tenant-scoped: principals belong
     * to the organisation, of which this hub has one (`BOOTSTRAP_ORG_ID`). A suspended principal
     * is still answered: a decision made before the suspension is still that principal's.
     */
    .get("/api/evidence/principals/:principalId", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks, EVIDENCE_READ);
      if (!auth.ok) return c.json(refusal(auth.status), auth.status);
      const id = await principalIdFor(c.req.param("principalId"));
      if (!id) return c.json({ error: "not_found" }, 404);
      const [p] = await db
        .select({ id: principals.id, kind: principals.kind, handle: principals.handle, suspendedAt: principals.suspendedAt })
        .from(principals)
        .where(eq(principals.id, id))
        .limit(1);
      if (!p) return c.json({ error: "not_found" }, 404);
      return c.json({ id: p.id, kind: p.kind, handle: p.handle, suspended: p.suspendedAt !== null });
    })
    /**
     * A session's transcript, one page of items (superwitness transcripts spec §3.3). Needs
     * `transcripts:read`. Another tenant's session, or none, is 404 — never 403, which would
     * confirm it exists.
     */
    .get("/api/evidence/sessions/:sessionId/transcript", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks, TRANSCRIPTS_READ);
      if (!auth.ok) return c.json(refusal(auth.status), auth.status);
      const session = await findSession(auth.tenant, c.req.param("sessionId"));
      if (!session) return c.json({ error: "not_found" }, 404);

      const range = parseRange(
        { seq_from: c.req.query("seq_from"), seq_to: c.req.query("seq_to") },
        await sessionBounds(auth.tenant, session.id),
      );
      if (!range) return c.json({ error: "bad_range" }, 400);
      let start = range.from;
      const cursor = c.req.query("cursor");
      if (cursor !== undefined) {
        const seq = decodeCursor(cursor);
        if (seq === null || seq < range.from || seq > range.to) return c.json({ error: "bad_range" }, 400);
        start = seq;
      }

      const folded = await foldRange(auth.tenant, session.id, range.from, range.to);
      const { page, nextSeq } = selectPage(folded, start, parseLimit(c.req.query("limit")));
      const redactor = contentRedactor();
      let redactions = 0;
      let truncatedFields = 0;
      const items: WireItem[] = page.map((it) => {
        const redacted = redactItem(it, redactor);
        const { item, truncated } = truncateItem(redacted);
        redactions += redacted.redactions;
        truncatedFields += truncated;
        return item;
      });

      await auditTranscriptRead({
        principalId: auth.principalId,
        onBehalfOf: onBehalfOf(c.req.header("x-on-behalf-of")),
        session,
        seqFrom: range.from,
        seqTo: range.to,
        items: items.length,
        redactions,
        full: false,
      });
      return c.json({
        session_id: session.id,
        seq_from: range.from,
        seq_to: range.to,
        items,
        next_cursor: nextSeq === null ? null : encodeCursor(nextSeq),
        redactions,
        truncated_fields: truncatedFields,
      });
    })
    /**
     * One item, by the seq it starts at within the range (`seq_from`/`seq_to`, the same as the
     * page it came from; default the whole session). `full=1` returns it uncut up to 1 MiB
     * serialised, else 413; without it, the item is cut exactly as its page cut it.
     */
    .get("/api/evidence/sessions/:sessionId/transcript/items/:seqFrom", async (c) => {
      const auth = await authorize(c.req.header("authorization"), jwks, TRANSCRIPTS_READ);
      if (!auth.ok) return c.json(refusal(auth.status), auth.status);
      const session = await findSession(auth.tenant, c.req.param("sessionId"));
      if (!session) return c.json({ error: "not_found" }, 404);
      const range = parseRange(
        { seq_from: c.req.query("seq_from"), seq_to: c.req.query("seq_to") },
        await sessionBounds(auth.tenant, session.id),
      );
      if (!range) return c.json({ error: "bad_range" }, 400);
      const at = c.req.param("seqFrom");
      if (!/^\d{1,9}$/.test(at)) return c.json({ error: "not_found" }, 404);

      const found = (await foldRange(auth.tenant, session.id, range.from, range.to)).find(
        (it) => itemFirstSeq(it) === Number(at),
      );
      if (!found) return c.json({ error: "not_found" }, 404);

      const full = c.req.query("full") === "1";
      const redacted = redactItem(found, contentRedactor());
      const item = full ? redacted : truncateItem(redacted).item;
      const audit = {
        principalId: auth.principalId,
        onBehalfOf: onBehalfOf(c.req.header("x-on-behalf-of")),
        session,
        seqFrom: range.from,
        seqTo: range.to,
        items: 1,
        redactions: redacted.redactions,
        full,
      };
      if (byteLength(JSON.stringify(item)) > ITEM_LIMIT_BYTES) {
        await auditTranscriptRead({ ...audit, items: 0, error: "item_too_large" });
        return c.json({ error: "item_too_large" }, 413);
      }
      await auditTranscriptRead(audit);
      return c.json({ session_id: session.id, item });
    });
}

export const evidenceRoutes = createEvidenceRoutes();
