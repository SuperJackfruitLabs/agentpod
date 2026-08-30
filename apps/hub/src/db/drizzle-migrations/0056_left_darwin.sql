ALTER TABLE "principal_identities" DROP CONSTRAINT "principal_identities_system_known";--> statement-breakpoint
ALTER TABLE "principal_identities" DROP CONSTRAINT "principal_identities_principal_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "principal_grants" DROP CONSTRAINT "principal_grants_principal_id_user_id_fk";
--> statement-breakpoint
-- One row today. Mint a principal for each existing user and carry the
-- identities and grants that pointed at it. Runs after the old FKs (into
-- "user") and the old system-list check are dropped, and before the new FKs
-- (into "principals") are added — those validate existing rows on add, so
-- principal_id must already hold prn_ ids by the time they land.
INSERT INTO principals (id, kind, org_id, handle, display_name)
SELECT 'prn_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
       'human', 'org_00000000000000000000',
       lower(regexp_replace(split_part(u.email, '@', 1), '[^a-z0-9._=/-]', '-', 'g')),
       u.name
  FROM "user" u;
--> statement-breakpoint

INSERT INTO principal_identities (id, principal_id, system, external_id)
SELECT gen_random_uuid()::text, p.id, 'better-auth', u.id
  FROM "user" u
  JOIN principals p ON p.handle = lower(regexp_replace(split_part(u.email, '@', 1), '[^a-z0-9._=/-]', '-', 'g'));
--> statement-breakpoint

UPDATE principal_identities pi SET principal_id = p.id
  FROM principal_identities bi JOIN principals p ON p.id = bi.principal_id
 WHERE bi.system = 'better-auth' AND pi.principal_id = bi.external_id;
--> statement-breakpoint

UPDATE principal_grants g SET principal_id = p.id
  FROM principal_identities bi JOIN principals p ON p.id = bi.principal_id
 WHERE bi.system = 'better-auth' AND g.principal_id = bi.external_id;
--> statement-breakpoint
ALTER TABLE "principal_identities" ADD CONSTRAINT "principal_identities_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_grants" ADD CONSTRAINT "principal_grants_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_identities" ADD CONSTRAINT "principal_identities_system_known" CHECK ("principal_identities"."system" IN ('better-auth', 'matrix', 'kaambaan', 'agentpod', 'org-plane'));
