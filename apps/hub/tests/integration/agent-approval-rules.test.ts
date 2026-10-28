/**
 * An agent's standing "Always allow" approval rules (approval scopes, part 2): workspace owners and
 * admins set and revoke them on a station; members only read. The live rules for the occupant ride
 * to Salaam on admit and every renewal of strict board work, so a revocation reaches a run in flight.
 */
process.env.NODE_ENV = "test";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { acpSessions } from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import { agentApprovalRules } from "../../src/db/schema/agent-approval-rules";
import { stationAudit } from "../../src/db/schema/audit";
import type { AuthUser } from "../../src/auth/middleware";
import { createAgentApprovalRuleRoutes } from "../../src/routes/agent-approval-rules";
import { approvalRulesFor } from "../../src/services/agent-approval-rules";
import { renewSalaamExecution } from "../../src/services/salaam-authority";
import * as broker from "../../src/services/broker";
import { fakePlane } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenant = "fleet_" + hex(),
  other = "fleet_" + hex(),
  org = "org_" + hex(),
  owner = "prn_" + hex(),
  agent = "prn_" + hex(),
  node = "node_" + hex(),
  otherNode = "node_" + hex(),
  station = "station_" + hex(),
  foreign = "station_" + hex();

beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(tenants).values([
    { id: tenant, name: "rules", externalSource: "org-plane", externalId: org },
    { id: other, name: "rules other" },
  ]);
  for (const [id, t] of [[node, tenant], [otherNode, other]] as const)
    await db.insert(nodes).values({
      id, tenantId: t, userId: owner, name: "rules " + id, hostname: "fixture",
      os: "test", arch: "test", secretHash: "not-real",
    });
  for (const [id, t] of [[station, tenant], [foreign, other]] as const)
    await db.insert(stations).values({
      id, tenantId: t, userId: owner, nodeId: t === tenant ? node : otherNode, harness: "salaam",
      stationKey: "salaam:" + hex().slice(0, 16), kind: "leaf", displayName: id,
      workspacePath: "/workspace", capabilities: ["acp"], principalId: t === tenant ? agent : null,
    });
});
afterAll(async () => {
  await db.delete(agentApprovalRules).where(eq(agentApprovalRules.tenantId, tenant));
});

function app(role: "owner" | "admin" | "member", t = tenant) {
  const a = new Hono();
  a.use("*", async (c, next) => {
    c.set("user", { id: owner, authType: "api_key", tenantId: t, workspaceRole: role } as AuthUser);
    await next();
  });
  a.route("/api", createAgentApprovalRuleRoutes());
  return a;
}
const call = async (a: Hono, method: string, path: string, body?: unknown) => {
  const res = await a.request("/api" + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
};
const path = `/stations/${station}/approval-rules`;

test("a member can read but not set or revoke a rule; owners and admins can", async () => {
  expect((await call(app("member"), "POST", path, { scope: "workspace-write" })).status).toBe(403);
  const set = await call(app("admin"), "POST", path, { scope: "workspace-write" });
  expect(set.status).toBe(201);
  expect(set.json.rule).toMatchObject({ scope: "workspace-write", setBy: owner });
  // Setting it again returns the live rule.
  const again = await call(app("owner"), "POST", path, { scope: "workspace-write" });
  expect(again.json.rule.id).toBe(set.json.rule.id);
  expect((await call(app("member"), "GET", path)).json.rules.map((r: any) => r.id)).toEqual([set.json.rule.id]);
  expect((await call(app("member"), "DELETE", `${path}/${set.json.rule.id}`)).status).toBe(403);
  expect((await call(app("owner"), "DELETE", `${path}/${set.json.rule.id}`)).status).toBe(200);
  expect((await call(app("member"), "GET", path)).json.rules).toEqual([]);
  expect((await call(app("owner"), "DELETE", `${path}/${set.json.rule.id}`)).status).toBe(404);
  const audits = await db.select().from(stationAudit).where(eq(stationAudit.tenantId, tenant));
  expect(audits.map((a) => a.verb).sort()).toEqual(["approval-rule.revoke", "approval-rule.set"]);
});

test("only known scopes and fields; another workspace's station is 404; no occupant, no rule", async () => {
  for (const body of [{ scope: "command" }, { scope: "workspace-write", paths: ["x"] }, {}])
    expect((await call(app("admin"), "POST", path, body)).status).toBe(400);
  expect((await call(app("admin"), "POST", `/stations/${foreign}/approval-rules`, { scope: "workspace-write" })).status).toBe(404);
  expect((await call(app("admin", other), "POST", `/stations/${foreign}/approval-rules`, { scope: "workspace-write" })).status).toBe(409);
});

const binding = (source: "superpipeline" | "agentpod", principal = agent) => ({
  version: 1 as const, organization_id: org, principal_id: principal, node_id: node,
  station_id: station, station_key: "salaam:0000000000000000", occupancy_epoch: 1,
  hub_session_id: "acps_" + hex(), workspace: "/workspace",
  run: { source, id: source === "superpipeline" ? "run_" + hex() : "acps_x", epoch: 1 },
});

test("the occupant's live rules go to strict board work only, and stop when revoked", async () => {
  expect(await approvalRulesFor(binding("superpipeline"))).toBeUndefined();
  const set = await call(app("admin"), "POST", path, { scope: "workspace-write" });
  expect(await approvalRulesFor(binding("superpipeline"))).toEqual([
    { id: set.json.rule.id, scope: "workspace-write", set_by: owner },
  ]);
  expect(await approvalRulesFor(binding("agentpod"))).toBeUndefined();
  // A different occupant does not inherit the rule.
  expect(await approvalRulesFor(binding("superpipeline", "prn_" + hex()))).toBeUndefined();
  await call(app("admin"), "DELETE", `${path}/${set.json.rule.id}`);
  expect(await approvalRulesFor(binding("superpipeline"))).toBeUndefined();
});

test("a renewal carries the live rules, and none once the last is revoked", async () => {
  const [row] = await db.select().from(stations).where(eq(stations.id, station));
  fakePlane.addHuman({ id: owner, grant: { mayDispatch: [agent] } });
  fakePlane.addAgent({ id: agent });
  for (const id of [owner, agent]) fakePlane.principals.get(id)!.organizationId = org;
  const b = { ...binding("superpipeline"), station_key: row!.stationKey, occupancy_epoch: row!.occupancyEpoch };
  const session = "acps_" + hex();
  await db.insert(bridgeDispatches).values({
    externalSource: "superpipeline", externalRunId: b.run.id, tenantId: tenant, boardId: "brd_" + hex(),
    externalCardId: "card_" + hex(), agentKey: "rules", stationId: station, leaseEpoch: 1, outcome: "working", eventsReceived: 0, activitiesPosted: 0, startedAt: new Date(), updatedAt: new Date(),
  } as any);
  await db.insert(acpSessions).values({
    id: session, tenantId: tenant, stationId: station, userId: owner, mode: "ask", status: "idle",
    executionAuthority: {
      binding: b, leaseSequence: 0, sessionId: crypto.randomUUID(), admissionId: crypto.randomUUID(),
      stopRequestId: "revoke:" + session, state: "active",
    } as any,
    createdAt: new Date(), lastEventAt: new Date(),
  });
  const saved = (await db.select().from(acpSessions).where(eq(acpSessions.id, session)))[0]!.executionAuthority as any;
  const sent: any[] = [];
  const mock = spyOn(broker, "request").mockImplementation(async (_n, verb, body: any) => {
    if (verb !== "salaam.renew") throw Error("unexpected " + verb);
    sent.push(body);
    return {
      ok: true,
      data: {
        admission_id: saved.admissionId, session_id: saved.sessionId, binding: body.binding,
        binding_digest: "d".repeat(64), lease_sequence: body.lease_sequence, expires_at: Date.now() + 60_000,
        authorized: true, revoked: false, owned_execution_stopped: false, unresolved_operations: [],
        active_attempts: [], interrupted_attempts: [],
      },
    };
  });
  try {
    const set = await call(app("admin"), "POST", path, { scope: "workspace-write" });
    await renewSalaamExecution(session, owner);
    expect(sent.at(-1).approval_rules).toEqual([{ id: set.json.rule.id, scope: "workspace-write", set_by: owner }]);
    await call(app("admin"), "DELETE", `${path}/${set.json.rule.id}`);
    await renewSalaamExecution(session, owner);
    expect("approval_rules" in sent.at(-1)).toBe(false);
  } finally {
    mock.mockRestore();
  }
});

// Operator ruling 2026-10-28: "Always allow" on the approval itself. The hub re-reads the answerer's
// role from the org plane, never the board's word, and sets the same rule as the console switch.
import { AlwaysAllowRefused, alwaysAllowFromAnswer } from "../../src/services/agent-approval-rules";
import * as orgPlane from "../../src/services/org-plane/client";

const person = (role: "owner" | "admin" | "member", o: { suspended?: boolean; org?: string } = {}) => {
  const id = fakePlane.addHuman({ role, suspended: o.suspended });
  fakePlane.principals.get(id)!.organizationId = o.org ?? org;
  return id;
};
const liveRules = () =>
  db.select().from(agentApprovalRules).where(eq(agentApprovalRules.stationId, station)).then((r) => r.filter((x) => !x.revokedAt));
const clear = () => db.delete(agentApprovalRules).where(eq(agentApprovalRules.stationId, station));

test("an owner's or admin's Always allow sets the occupant's workspace-write rule, once", async () => {
  await clear();
  for (const role of ["owner", "admin"] as const) {
    const who = person(role);
    const rule = await alwaysAllowFromAnswer({ tenantId: tenant, stationId: station, answeredBy: who });
    expect(rule).toMatchObject({ scope: "workspace-write", principalId: agent, stationId: station });
  }
  const rules = await liveRules();
  expect(rules).toHaveLength(1);
  expect(rules[0]!.scope).toBe("workspace-write");
  await clear();
});

test("Always allow is refused for a member, a suspended or foreign person, or nobody, and sets nothing", async () => {
  await clear();
  for (const answeredBy of [
    person("member"),
    person("admin", { suspended: true }),
    person("owner", { org: "org_" + hex() }),
    "prn_" + hex(),
  ]) {
    const refused = await alwaysAllowFromAnswer({ tenantId: tenant, stationId: station, answeredBy }).then(
      () => null,
      (e) => e,
    );
    expect(refused).toBeInstanceOf(AlwaysAllowRefused);
    expect(String(refused.message)).toContain("nothing was approved");
  }
  expect(await liveRules()).toHaveLength(0);
});

test("Always allow trusts only the org plane: an unreachable plane refuses it", async () => {
  await clear();
  const who = person("owner");
  const spy = spyOn(orgPlane, "orgPlaneClient").mockImplementation(
    () => ({ getPrincipal: async () => { throw new orgPlane.OrgPlaneError(503, "down"); } }) as never,
  );
  try {
    await expect(alwaysAllowFromAnswer({ tenantId: tenant, stationId: station, answeredBy: who })).rejects.toThrow(
      "could not check who answered",
    );
  } finally {
    spy.mockRestore();
  }
  expect(await liveRules()).toHaveLength(0);
});

test("a station with no agent cannot take Always allow; the answer is refused, not forwarded", async () => {
  const who = person("owner");
  await expect(alwaysAllowFromAnswer({ tenantId: tenant, stationId: foreign, answeredBy: who })).rejects.toThrow(
    "nothing was approved",
  );
});

test("an agent principal is never an answerer, whatever role it claims", async () => {
  await clear();
  const bot = fakePlane.addAgent({});
  const p = fakePlane.principals.get(bot)! as any;
  p.organizationId = org;
  p.role = "owner";
  await expect(alwaysAllowFromAnswer({ tenantId: tenant, stationId: station, answeredBy: bot })).rejects.toThrow(
    "workspace owner or admin",
  );
  expect(await liveRules()).toHaveLength(0);
});

test("when the rule cannot be set, the answer is refused in plain words", async () => {
  const empty = "station_" + hex();
  await db.insert(stations).values({
    id: empty, tenantId: tenant, userId: owner, nodeId: node, harness: "salaam",
    stationKey: "salaam:" + hex().slice(0, 16), kind: "leaf", displayName: empty,
    workspacePath: "/workspace", capabilities: ["acp"], principalId: null,
  });
  try {
    await expect(
      alwaysAllowFromAnswer({ tenantId: tenant, stationId: empty, answeredBy: person("owner") }),
    ).rejects.toThrow("Always allow could not be set; nothing was approved.");
  } finally {
    await db.delete(stations).where(eq(stations.id, empty));
  }
});
