-- Which room belongs to which station, and the conversation running in it.
--
-- The room id is the key because that is what an inbound event carries; the
-- alias is derived and recorded only so an operator can read this table.
--
-- `acp_session_id` is what makes a room a conversation rather than a series of
-- unrelated prompts: without it every message would open a session and the
-- agent would lose its context between two consecutive sentences.
--
-- `tenant_id` is carried rather than inferred from the station, following the
-- rule in db/tenant-scope.ts: "reachable only through a scoped parent" is a
-- claim about the routes that happen to exist today. The composite foreign key
-- below is what keeps the copy honest.
CREATE TABLE matrix_rooms (
  room_id        text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  station_id     text NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  alias          text NOT NULL,
  acp_session_id text,
  created_at     timestamp NOT NULL DEFAULT now()
);

-- A room's tenant must be its station's tenant. Without this the column is a
-- second opinion rather than a copy.
CREATE UNIQUE INDEX stations_id_tenant_idx ON stations (id, tenant_id);
ALTER TABLE matrix_rooms
  ADD CONSTRAINT matrix_rooms_station_tenant_fk
  FOREIGN KEY (station_id, tenant_id) REFERENCES stations (id, tenant_id) ON DELETE CASCADE;

CREATE INDEX matrix_rooms_tenant_id_idx ON matrix_rooms (tenant_id);

-- One room per station: a second room for the same agent would split its
-- conversation in two, with each half unaware of the other.
CREATE UNIQUE INDEX matrix_rooms_station_idx ON matrix_rooms (station_id);
