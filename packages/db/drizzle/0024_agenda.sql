CREATE TABLE "appointment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"dentist_user_id" text NOT NULL,
	"chair_id" uuid NOT NULL,
	"service_id" uuid,
	"service_name" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"status" text DEFAULT 'programada' NOT NULL,
	"reason" text,
	"source" text DEFAULT 'recepcion' NOT NULL,
	"conversation_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_status_check" CHECK ("appointment"."status" in ('programada','confirmada','atendida','no_asistio','cancelada')),
	CONSTRAINT "appointment_range_check" CHECK ("appointment"."ends_at" > "appointment"."starts_at"),
	CONSTRAINT "appointment_duration_check" CHECK ("appointment"."duration_min" > 0)
);
--> statement-breakpoint
CREATE TABLE "schedule_chair" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_dentist_user_id_user_id_fk" FOREIGN KEY ("dentist_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_chair_id_schedule_chair_id_fk" FOREIGN KEY ("chair_id") REFERENCES "public"."schedule_chair"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_chair" ADD CONSTRAINT "schedule_chair_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_chair" ADD CONSTRAINT "schedule_chair_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appointment_org_id_uidx" ON "appointment" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "appointment_org_branch_range_idx" ON "appointment" USING btree ("organization_id","branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_org_dentist_range_idx" ON "appointment" USING btree ("organization_id","dentist_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointment_org_patient_idx" ON "appointment" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_chair_org_id_uidx" ON "schedule_chair" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "schedule_chair_org_branch_idx" ON "schedule_chair" USING btree ("organization_id","branch_id");
--> statement-breakpoint
--> No doble reserva aun con concurrencia: exclusión GiST sobre rangos UTC.
--> Solo los estados ocupantes bloquean; cancelada/no_asistio liberan.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap_dentist" EXCLUDE USING gist (
	"organization_id" WITH =,
	"dentist_user_id" WITH =,
	tstzrange("starts_at", "ends_at") WITH &&
) WHERE ("status" IN ('programada','confirmada'));--> statement-breakpoint
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_no_overlap_chair" EXCLUDE USING gist (
	"organization_id" WITH =,
	"chair_id" WITH =,
	tstzrange("starts_at", "ends_at") WITH &&
) WHERE ("status" IN ('programada','confirmada'));--> statement-breakpoint
--> RLS: aislamiento por tenant como el resto del dominio.
ALTER TABLE "schedule_chair" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "schedule_chair" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "schedule_chair"
	USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
ALTER TABLE "appointment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "appointment"
	USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "schedule_chair", "appointment" TO dentalagent_app;--> statement-breakpoint
REVOKE DELETE ON "schedule_chair", "appointment" FROM dentalagent_app;