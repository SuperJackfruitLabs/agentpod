-- A node name identifies one machine, because a grant now names one.
--
-- Names come straight from `hostname` and were never unique: two Fly machines,
-- two laptops called `localhost`, two containers from one image. Harmless while
-- a name was only a label. It stopped being harmless when
-- `agentpod:<node>/<stationKey>` started deciding who may dispatch what — a
-- permission written for a staging box would silently cover production.
--
-- This is the same shape of defect as station keys not being unique across
-- nodes, which is what sent us looking: uniqueness assumed rather than checked.
--
-- Existing duplicates are renamed rather than rejected, so the constraint can
-- land on a live fleet. The suffix matches what enrollment now mints, and
-- `hostname` is untouched — the machine's own answer about itself stays true.
UPDATE nodes SET name = name || '-' || substr(id, 6, 6)
WHERE ctid NOT IN (
  SELECT min(ctid) FROM nodes GROUP BY tenant_id, name
);

CREATE UNIQUE INDEX IF NOT EXISTS "nodes_tenant_name_idx" ON "nodes" ("tenant_id", "name");
