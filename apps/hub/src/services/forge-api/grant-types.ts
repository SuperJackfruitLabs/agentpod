/** The station forge API's dependencies, inputs and row types, shared by every grant-*.ts file. */
import type { ForgeApiMode, ForgeApiPreset, ForgeApiProvider, ForgeApiRule } from "@agentpod/contract";

import type { Database } from "../../db/drizzle";
import type { StationForgeApiGrant } from "../../db/schema/forge-api-grants";
import type { stations } from "../../db/schema/stations";
import type { ForgeProvider } from "./providers";

/** A sealed blob not acknowledged within this window is discarded (spec: sealed-blob expiry). */
export const SEALED_BLOB_TTL_MS = 24 * 60 * 60 * 1000;

export type BrokerReply = { ok: boolean; data?: unknown; error?: string };

export interface ForgeApiDeps {
  db: Database;
  broker: { request(nodeId: string, verb: string, params: unknown, opts?: { timeoutMs?: number }): Promise<BrokerReply> };
  providers: (kind: ForgeApiProvider) => ForgeProvider;
  now: () => Date;
  /** Seal material to a station's stk handover public key (`sealHandover` in production). */
  seal: (publicKey: string, material: Record<string, string>) => Promise<string>;
  /**
   * The station's stk handover public key. Defaults to asking the node (`forge.api.status`), see
   * `fetchStationPublicKey`. Injectable so a caller with a cached key can skip the round trip.
   */
  stationPublicKey?: (station: { id: string; nodeId: string }) => Promise<string>;
  /**
   * The configured forge's URL (FORGE_URL). A minted grant's instance must be its origin, since the
   * token is minted there; absent means no minted grant is possible (fail closed).
   */
  forgeOrigin?: string | null;
}

export interface CreateForgeApiGrantInput {
  tenantId: string;
  stationId: string;
  /** The user acting (audit + created_by). Authorisation is the route's job. */
  actor: string;
  provider: ForgeApiProvider;
  instance: string;
  mode: ForgeApiMode;
  repositories: string[];
  preset: ForgeApiPreset;
  rules: ForgeApiRule[];
  allowGraphql: boolean;
  /**
   * minted: IGNORED — the expected login is the account, and the account is the station's
   * occupant, never something a caller names.
   * supplied/app: REQUIRED — the operator-declared machine/bot login (app: the App slug, without
   * `[bot]`). That is the account the operator created by hand, not necessarily the occupant.
   */
  expectedLogin?: string;
  /** The operator acknowledges a write grant in same-user mode (recorded with `actor`). */
  acknowledgeSameUser?: boolean;
}

export type Grant = StationForgeApiGrant;
export type StationRow = typeof stations.$inferSelect;
export interface GrantRef {
  tenantId: string;
  id: string;
}

export type Ref = { tenantId: string; grantId: string };
export const toRef = (r: Ref): GrantRef => ({ tenantId: r.tenantId, id: r.grantId });
