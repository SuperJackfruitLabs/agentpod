-- Spaces group by NODE, not by purpose.
--
-- Purpose was the axis for a day: an operator's fleet is laid out by use case,
-- and node lined up with it only by accident. The operator has since chosen the
-- machine as the grouping — it is the thing they can point at, it needs no
-- labelling step before a new agent lands somewhere sensible, and purpose is
-- better served later as tags, which can overlap and do not fight a hierarchy.
--
-- `purpose` on stations and nodes is deliberately KEPT. It is still the record
-- of what an agent is for, and it is what tags will be built from; nothing reads
-- it for grouping any more.
ALTER TABLE matrix_purpose_spaces RENAME TO matrix_spaces;
ALTER TABLE matrix_spaces RENAME COLUMN purpose TO space_key;

-- The existing rows named purposes ("personal", "work"). Under the new keying
-- they would be read as node names, so they are dropped and the node spaces are
-- made fresh. The rooms they point at are cleaned up on the homeserver
-- separately — a space nobody is in is invisible, not harmful.
DELETE FROM matrix_spaces;
