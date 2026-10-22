CREATE TABLE "patient_record_opening" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_record_opening_reason_check" CHECK ("patient_record_opening"."reason" IN ('autoridad','reclamo','otro')),
	CONSTRAINT "patient_record_opening_note_check" CHECK ("patient_record_opening"."reason" <> 'otro' OR "patient_record_opening"."note" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "patient_data_request" DROP CONSTRAINT "patient_data_request_kind_check";--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "record_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "record_locked_by" text;--> statement-breakpoint
ALTER TABLE "patient_record_opening" ADD CONSTRAINT "patient_record_opening_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_opening" ADD CONSTRAINT "patient_record_opening_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_record_opening" ADD CONSTRAINT "patient_record_opening_patient_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_record_opening_org_patient_idx" ON "patient_record_opening" USING btree ("organization_id","patient_id","user_id");--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_record_locked_by_user_id_fk" FOREIGN KEY ("record_locked_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_org_locked_idx" ON "contact" USING btree ("organization_id") WHERE "record_locked_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_data_request" ADD CONSTRAINT "patient_data_request_kind_check" CHECK ("patient_data_request"."kind" IN ('copia','corregir','mensajes','borrar'));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_record_locked_check" CHECK ("contact"."record_locked_at" IS NULL OR (NOT "contact"."is_active" AND "contact"."record_locked_by" IS NOT NULL));