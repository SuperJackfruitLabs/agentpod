import { test, expect } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { acpSessions, acpEvents } from "../../src/db/schema/acp";

test("acpSessions table is defined", () => {
  expect(acpSessions).toBeDefined();
});

test("acpEvents table is defined", () => {
  expect(acpEvents).toBeDefined();
});

test("acpSessions table has required columns", () => {
  const cols = Object.keys(acpSessions);
  expect(cols).toContain("id");
  expect(cols).toContain("stationId");
  expect(cols).toContain("userId");
  expect(cols).toContain("mode");
  expect(cols).toContain("status");
  expect(cols).toContain("endedReason");
  expect(cols).toContain("nodeSessionId");
  expect(cols).toContain("createdAt");
  expect(cols).toContain("lastEventAt");
});

test("acpEvents table has required columns", () => {
  const cols = Object.keys(acpEvents);
  expect(cols).toContain("sessionId");
  expect(cols).toContain("seq");
  expect(cols).toContain("type");
  expect(cols).toContain("payload");
  expect(cols).toContain("createdAt");
});

test("acpSessions has id as primary key", () => {
  const config = getTableConfig(acpSessions);
  expect(config.primaryKeys.length + (config.columns.find(c => c.name === "id")?.primary ? 1 : 0)).toBeGreaterThan(0);
});

test("acpEvents has composite primary key on (session_id, seq)", () => {
  const config = getTableConfig(acpEvents);
  expect(config.primaryKeys.length).toBe(1);
  const pk = config.primaryKeys[0];
  const pkColumnNames = pk.columns.map((c) => c.name).sort();
  expect(pkColumnNames).toEqual(["seq", "session_id"]);
});

test("acpSessions.stationId column is named station_id", () => {
  const config = getTableConfig(acpSessions);
  const col = config.columns.find((c) => c.name === "station_id");
  expect(col).toBeDefined();
  expect(col?.notNull).toBe(true);
});

test("acpSessions.stationId has NO foreign key (transcripts must survive station deletion)", () => {
  // Asserts the property rather than a count. This used to read
  // `foreignKeys.length === 0`, which meant the right thing only for as long as
  // station_id was the sole candidate — adding the tenant FK broke it while the
  // invariant it guards was untouched. Naming the column keeps it pointed at
  // what actually matters: destroying a throwaway station must not cascade a
  // transcript away.
  const config = getTableConfig(acpSessions);
  const stationFks = config.foreignKeys.filter((fk) =>
    fk.reference().columns.some((c) => c.name === "station_id"),
  );
  expect(stationFks).toEqual([]);
});

test("acpSessions has an index on station_id", () => {
  const config = getTableConfig(acpSessions);
  const idx = config.indexes.find((i) => i.config.name === "acp_sessions_station_id_idx");
  expect(idx).toBeDefined();
});

test("acpSessions.title is a nullable text column", () => {
  const config = getTableConfig(acpSessions);
  const col = config.columns.find((c) => c.name === "title");
  expect(col).toBeDefined();
  expect(col?.notNull).toBe(false);
});

test("acpSessions.last_seq is NOT NULL with a default of 0", () => {
  const config = getTableConfig(acpSessions);
  const col = config.columns.find((c) => c.name === "last_seq");
  expect(col).toBeDefined();
  expect(col?.notNull).toBe(true);
  expect(col?.default).toBe(0);
});

test("acpSessions has a (station_id, last_event_at desc) activity index", () => {
  const config = getTableConfig(acpSessions);
  const idx = config.indexes.find((i) => i.config.name === "acp_sessions_station_activity_idx");
  expect(idx).toBeDefined();
  const cols = idx!.config.columns.map((c: any) => c.name ?? c.column?.name);
  expect(cols).toEqual(["station_id", "last_event_at"]);
});

test("acpEvents.sessionId still has a foreign key to acpSessions.id ON DELETE CASCADE", () => {
  const config = getTableConfig(acpEvents);
  const sessionFk = config.foreignKeys.find((fk) => {
    const cols = fk.reference().columns.map((c) => c.name);
    return cols.includes("session_id") && !cols.includes("tenant_id");
  });
  expect(sessionFk).toBeDefined();
  expect(sessionFk!.onDelete).toBe("cascade");
});

test("acpEvents carries a composite FK pinning an event to its session's tenant", () => {
  // The copied fact, held honest. acp_events.tenant_id duplicates
  // acp_sessions.tenant_id so the largest table in the database can be read
  // safely without a join; this is what stops the copy drifting from the
  // original, and it cascades for the same reason the plain session FK does.
  const config = getTableConfig(acpEvents);
  const composite = config.foreignKeys.find((fk) => {
    const cols = fk.reference().columns.map((c) => c.name).sort();
    return cols.join() === ["session_id", "tenant_id"].join();
  });
  expect(composite).toBeDefined();
  expect(composite!.onDelete).toBe("cascade");
});

test("acpEvents.sessionId column is named session_id", () => {
  const config = getTableConfig(acpEvents);
  const col = config.columns.find((c) => c.name === "session_id");
  expect(col).toBeDefined();
  expect(col?.notNull).toBe(true);
});
