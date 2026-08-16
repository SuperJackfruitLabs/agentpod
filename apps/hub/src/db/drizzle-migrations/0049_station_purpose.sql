-- What a station is FOR, which is not where it runs.
--
-- The fleet is laid out by use case today — openclaw on superchotu is personal,
-- hermes on molt-bot is work, the rest ad hoc — so a node's name happens to
-- carry its purpose. That is an accident of how the fleet was built, and it is
-- already scheduled to break: coming use cases will span harnesses and runtimes,
-- and one node will host more than one of them. Anything derived from node name,
-- harness or runtime would encode the accident.
--
-- So purpose is a field, and it lives on the STATION. The node's is only a
-- default, applied at adoption to a station that has none — which is why both
-- columns exist and why the station's is the one anything reads.
--
-- Both nullable, and deliberately not backfilled. Null means "nobody has said",
-- and an unlabelled station is filed under no space at all rather than under an
-- invented `Unsorted` one: it still appears in All rooms, which is where a
-- fresh ad-hoc runtime belongs until somebody decides otherwise.
ALTER TABLE nodes ADD COLUMN purpose text;
ALTER TABLE stations ADD COLUMN purpose text;
