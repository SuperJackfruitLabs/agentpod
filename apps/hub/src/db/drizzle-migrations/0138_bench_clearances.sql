-- The checkpoint attempts whose card's bench the hub has cleared (done, terminal, cancelled or dormant), and why.
CREATE TABLE IF NOT EXISTS "bench_clearances" (
	"tenant_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"card_id" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bench_clearances_tenant_id_attempt_id_pk" PRIMARY KEY("tenant_id","attempt_id"),
	CONSTRAINT "bench_clearances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
	CONSTRAINT "bench_clearances_attempt_fk" FOREIGN KEY ("tenant_id","attempt_id") REFERENCES "checkpoint_dispatches"("tenant_id","attempt_id") ON DELETE cascade,
	CONSTRAINT "bench_clearances_reason" CHECK ("reason" IN ('completed','terminal','cancelled','dormant')),
	CONSTRAINT "bench_clearances_outcome" CHECK ("outcome" IN ('reclaimed','absent','abandoned'))
);
