CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_id_is_org" CHECK ("organizations"."id" LIKE 'org\_%')
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"org_id" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principals_id_is_prn" CHECK ("principals"."id" LIKE 'prn\_%'),
	CONSTRAINT "principals_kind_known" CHECK ("principals"."kind" IN ('human','agent','service'))
);
--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "principals_org_handle_idx" ON "principals" USING btree ("org_id","handle");--> statement-breakpoint

INSERT INTO organizations (id, name) VALUES ('org_00000000000000000000', 'Super Jackfruit Labs')
  ON CONFLICT (id) DO NOTHING;

UPDATE tenants
   SET external_id = 'org_00000000000000000000', external_source = 'org-plane'
 WHERE id = 'fleet_00000000000000000000' AND external_id IS NULL;
