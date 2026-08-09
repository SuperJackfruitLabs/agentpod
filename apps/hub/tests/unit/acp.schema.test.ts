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
  const config = getTableConfig(acpSessions);
  expect(config.foreignKeys.length).toBe(0);
});

test("acpSessions has an index on station_id", () => {
  const config = getTableConfig(acpSessions);
  const idx = config.indexes.find((i) => i.config.name === "acp_sessions_station_id_idx");
  expect(idx).toBeDefined();
});

test("acpEvents.sessionId still has a foreign key to acpSessions.id ON DELETE CASCADE", () => {
  const config = getTableConfig(acpEvents);
  expect(config.foreignKeys.length).toBe(1);
  const fk = config.foreignKeys[0];
  expect(fk.onDelete).toBe("cascade");
});

test("acpEvents.sessionId column is named session_id", () => {
  const config = getTableConfig(acpEvents);
  const col = config.columns.find((c) => c.name === "session_id");
  expect(col).toBeDefined();
  expect(col?.notNull).toBe(true);
});
