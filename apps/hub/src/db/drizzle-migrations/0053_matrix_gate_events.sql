-- One kaambaan gate, one Matrix event.
--
-- This single table is what makes the delivery path safe to retry. kaambaan's
-- push is at-least-once within a cap, its drain re-picks failed rows, and the
-- reconciliation sweep asks independently which pending gates have no event —
-- so the same gate arrives here more than once by design, not by accident.
-- Without a record keyed on the gate, each arrival would post the same question
-- again and a reader would be asked to approve one thing three times.
--
-- `gate_id` is the primary key rather than a unique index on a surrogate,
-- because the gate IS the identity here: there is no such thing as two
-- projections of one gate, and a schema that can represent one is a schema that
-- will eventually hold one.
--
-- Tenant-scoped like matrix_rooms, and for the same reason: the room belongs to
-- a station, and the station belongs to a fleet.
CREATE TABLE IF NOT EXISTS matrix_gate_events (
  gate_id     text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  board_id    text NOT NULL,
  card_id     text NOT NULL,
  room_id     text NOT NULL,
  event_id    text NOT NULL,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matrix_gate_events_tenant_id_idx ON matrix_gate_events (tenant_id);
-- The sweep and the inbound decision both arrive holding an event id and
-- needing the gate, which is the opposite direction from the primary key.
CREATE UNIQUE INDEX IF NOT EXISTS matrix_gate_events_event_idx ON matrix_gate_events (event_id);
