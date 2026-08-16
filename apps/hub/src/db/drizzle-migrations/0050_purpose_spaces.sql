-- One Matrix space per purpose, and a memory of where each room hangs.
--
-- Deliberately WITHOUT a room alias, unlike the mission space. An alias is how
-- a person types a room's address, and nobody types this one — it exists to be
-- a container. Aliases are also global to a homeserver, so an alias derived
-- from a purpose name ("personal") would have one tenant's space swallow
-- another's the moment a second tenant used the same everyday word. The room id
-- stored here is the space's identity instead, which cannot collide.
CREATE TABLE IF NOT EXISTS matrix_purpose_spaces (
  tenant_id text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  purpose text NOT NULL,
  room_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, purpose)
);

-- Where this station's room currently hangs, so a purpose that changes can take
-- the room OUT of the old space as well as into the new one. Without this the
-- room would accumulate parents and show up under every purpose it ever had.
ALTER TABLE matrix_rooms ADD COLUMN space_room_id text;
