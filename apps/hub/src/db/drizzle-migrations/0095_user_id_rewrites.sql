CREATE TABLE "user_id_rewrites" (
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"row_key" jsonb NOT NULL,
	"old_value" text NOT NULL,
	"new_value" text NOT NULL,
	CONSTRAINT "user_id_rewrites_table_name_column_name_row_key_pk" PRIMARY KEY("table_name","column_name","row_key")
);
