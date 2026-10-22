process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { newPrincipalId } from "../helpers/fake-plane";
import { db } from "../../src/db/drizzle";
import { hubOperators } from "../../src/db/schema/operators";
import { HubOperatorsConfigError, parseHubOperators, reconcileHubOperators } from "../../src/services/hub-operators";
import { collectConfigErrors } from "../../src/utils/validate-config";

/**
 * Workspace authority spec, W3: the operator seat is set from configuration, never from SQL.
 * `HUB_OPERATORS` is reconciled into `hub_operators` at boot — but only when it is set, so a
 * deployment whose env has not been given the list yet keeps the seats it has.
 */

const KEEP = newPrincipalId();
const DROP = newPrincipalId();
const ADD = newPrincipalId();
const all = [KEEP, DROP, ADD];

async function seats(): Promise<string[]> {
  const rows = await db.select({ id: hubOperators.principalId }).from(hubOperators);
  return rows.map((r) => r.id);
}

beforeAll(ensurePgMigrations);
afterAll(async () => {
  await db.delete(hubOperators).where(inArray(hubOperators.principalId, all));
});

describe("parseHubOperators", () => {
  test("unset or blank is null: leave the table alone", () => {
    expect(parseHubOperators(undefined)).toBeNull();
    expect(parseHubOperators("")).toBeNull();
    expect(parseHubOperators("  ")).toBeNull();
  });

  test("a comma list of prn_ ids, trimmed and de-duplicated", () => {
    expect(parseHubOperators(` ${KEEP} ,${ADD},${KEEP}`)).toEqual([KEEP, ADD]);
  });

  test("a malformed entry is refused, naming it", () => {
    expect(() => parseHubOperators(`${KEEP},usr_123`)).toThrow(HubOperatorsConfigError);
    expect(() => parseHubOperators(`${KEEP},usr_123`)).toThrow(/usr_123/);
    expect(() => parseHubOperators(`${KEEP},,${ADD}`)).toThrow(HubOperatorsConfigError);
    expect(() => parseHubOperators("prn_0123")).toThrow(HubOperatorsConfigError);
  });

  test("boot validation refuses a malformed HUB_OPERATORS", () => {
    const errors = collectConfigErrors(undefined, () => {}, undefined, [], "prn_nope");
    expect(errors.map((e) => e.field)).toContain("HUB_OPERATORS");
    const ok = collectConfigErrors(undefined, () => {}, undefined, [], KEEP);
    expect(ok.map((e) => e.field)).not.toContain("HUB_OPERATORS");
  });
});

describe("reconcileHubOperators", () => {
  test("unset is a no-op: existing seats stay", async () => {
    await db.insert(hubOperators).values([{ principalId: KEEP }, { principalId: DROP }]).onConflictDoNothing();
    const r = await reconcileHubOperators(undefined);
    expect(r).toBeNull();
    expect(await seats()).toEqual(expect.arrayContaining([KEEP, DROP]));
  });

  test("adds the listed and removes the unlisted", async () => {
    await db.insert(hubOperators).values([{ principalId: KEEP }, { principalId: DROP }]).onConflictDoNothing();
    const r = await reconcileHubOperators(`${KEEP},${ADD}`);
    expect(r).toEqual({ added: [ADD], removed: expect.arrayContaining([DROP]) });
    const now = await seats();
    expect(now).toContain(KEEP);
    expect(now).toContain(ADD);
    expect(now).not.toContain(DROP);
    expect(now.sort()).toEqual([KEEP, ADD].sort());
  });

  test("a second run with the same list changes nothing", async () => {
    const r = await reconcileHubOperators(`${KEEP},${ADD}`);
    expect(r).toEqual({ added: [], removed: [] });
  });

  test("a malformed list throws before touching the table", async () => {
    await expect(reconcileHubOperators(`${KEEP},bad`)).rejects.toThrow(HubOperatorsConfigError);
    expect((await seats()).sort()).toEqual([KEEP, ADD].sort());
  });
});
