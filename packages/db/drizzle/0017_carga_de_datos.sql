CREATE TABLE "admin"."clinic_import_row" (
	"organization_id" text NOT NULL,
	"source_key" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"plan_sha256" text NOT NULL,
	"origin_file" text,
	"origin_row" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_import_row_pkey" PRIMARY KEY("organization_id","source_key"),
	CONSTRAINT "clinic_import_row_outcome_check" CHECK ("admin"."clinic_import_row"."outcome" IN ('creada','existente'))
);
--> statement-breakpoint
ALTER TABLE "admin"."clinic_import_row" ADD CONSTRAINT "clinic_import_row_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."clinic_import_row" ADD CONSTRAINT "clinic_import_row_contact_fkey" FOREIGN KEY ("organization_id","contact_id") REFERENCES "public"."contact"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."clinic_import_row" ADD CONSTRAINT "clinic_import_row_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_import_row_contact_idx" ON "admin"."clinic_import_row" USING btree ("organization_id","contact_id");