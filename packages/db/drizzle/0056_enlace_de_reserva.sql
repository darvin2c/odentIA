CREATE TABLE "appointment_booking_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"patient_id" uuid,
	"service_id" uuid,
	"branch_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"appointment_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_registration_link" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ADD CONSTRAINT "appointment_booking_link_appointment_id_appointment_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_booking_link_token_uidx" ON "appointment_booking_link" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "appointment_booking_link_conversation_idx" ON "appointment_booking_link" USING btree ("organization_id","conversation_id");--> statement-breakpoint
ALTER TABLE "appointment_booking_link" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "appointment_booking_link" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "appointment_booking_link"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Los enlaces se crean, se usan y se revocan; no se borran: son la constancia de quién reservó y por dónde.
GRANT SELECT, INSERT, UPDATE ON "appointment_booking_link" TO dentalagent_app;
--> statement-breakpoint
REVOKE DELETE ON "appointment_booking_link" FROM dentalagent_app;
