-- Rooms where several agents work together.
--
-- A per-agent room is a DM: one correspondent, filed under People. A mission is
-- the other shape — several stations and several people in one place — so it is
-- an ordinary room, and it is what spaces group.
--
-- `space_room_id` is the Matrix space this mission's room hangs under. Nullable
-- because a mission can exist before its space does, and because a deployment
-- may not want the hierarchy at all.
CREATE TABLE matrix_missions (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name          text NOT NULL,
  room_id       text,
  alias         text NOT NULL,
  space_room_id text,
  created_at    timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX matrix_missions_alias_idx ON matrix_missions (alias);
CREATE INDEX matrix_missions_tenant_id_idx ON matrix_missions (tenant_id);

-- Which stations are in a mission.
--
-- A station may be in several missions at once: an agent is not consumed by the
-- work it is doing, and the alternative — one mission per agent — is the DM we
-- already have.
CREATE TABLE matrix_mission_members (
  mission_id text NOT NULL REFERENCES matrix_missions(id) ON DELETE CASCADE,
  station_id text NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  added_at   timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, station_id)
);

CREATE INDEX matrix_mission_members_tenant_id_idx ON matrix_mission_members (tenant_id);
