CREATE TABLE "clinical_follow_up" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_item_id" uuid,
	"encounter_procedure_id" uuid,
	"origin_encounter_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"completed_encounter_id" uuid,
	"outcome" text,
	"cancelled_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "clinical_follow_up_kind_check" CHECK ("clinical_follow_up"."kind" IN ('tratamiento','mantenimiento')),
	CONSTRAINT "clinical_follow_up_status_check" CHECK ("clinical_follow_up"."status" IN ('pendiente','programado','realizado','cancelado')),
	CONSTRAINT "clinical_follow_up_treatment_check" CHECK ("clinical_follow_up"."kind" <> 'tratamiento' OR "clinical_follow_up"."plan_item_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "patient_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_item_id" uuid,
	"budget_item_id" uuid,
	"encounter_procedure_id" uuid,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"due_at" timestamp with time zone,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "patient_charge_amount_check" CHECK ("patient_charge"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "patient_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"payer_contact_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "patient_payment_amount_check" CHECK ("patient_payment"."amount_cents" > 0),
	CONSTRAINT "patient_payment_method_check" CHECK ("patient_payment"."method" IN ('efectivo','tarjeta','transferencia','yape','plin','otro'))
);
--> statement-breakpoint
CREATE TABLE "patient_payment_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "payment_application_amount_check" CHECK ("patient_payment_application"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "patient_payment_refund" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"refunded_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refund_amount_check" CHECK ("patient_payment_refund"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "patient_responsibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_at" date NOT NULL,
	"ends_at" date,
	"evidence_document_id" uuid,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_reason" text,
	CONSTRAINT "patient_responsibility_kind_check" CHECK ("patient_responsibility"."kind" IN ('representante_legal','autorizado_informacion','responsable_economico','acompanante')),
	CONSTRAINT "patient_responsibility_dates_check" CHECK ("patient_responsibility"."ends_at" IS NULL OR "patient_responsibility"."ends_at" >= "patient_responsibility"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "prescription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"plan_item_id" uuid,
	"prescription_number" integer NOT NULL,
	"status" text DEFAULT 'emitida' NOT NULL,
	"notes" text,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescription_status_check" CHECK ("prescription"."status" IN ('emitida','anulada'))
);
--> statement-breakpoint
CREATE TABLE "prescription_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"medication_name" text NOT NULL,
	"dose" text NOT NULL,
	"route" text NOT NULL,
	"frequency" text NOT NULL,
	"duration" text NOT NULL,
	"quantity" integer,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescription_item_quantity_check" CHECK ("prescription_item"."quantity" IS NULL OR "prescription_item"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "budget_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "encounter_procedure_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "prescription_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "follow_up_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD COLUMN "payment_id" uuid;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_encounter_procedure_id_encounter_procedure_id_fk" FOREIGN KEY ("encounter_procedure_id") REFERENCES "public"."encounter_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_origin_encounter_id_encounter_id_fk" FOREIGN KEY ("origin_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_completed_encounter_id_encounter_id_fk" FOREIGN KEY ("completed_encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_follow_up" ADD CONSTRAINT "clinical_follow_up_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_budget_item_id_treatment_budget_item_id_fk" FOREIGN KEY ("budget_item_id") REFERENCES "public"."treatment_budget_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_encounter_procedure_id_encounter_procedure_id_fk" FOREIGN KEY ("encounter_procedure_id") REFERENCES "public"."encounter_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_payer_contact_id_contact_id_fk" FOREIGN KEY ("payer_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_charge_id_patient_charge_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."patient_charge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "patient_payment_refund_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_evidence_document_id_patient_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."patient_document"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_responsibility" ADD CONSTRAINT "patient_responsibility_contact_fk" FOREIGN KEY ("organization_id","patient_id","contact_id") REFERENCES "public"."patient_contact"("organization_id","patient_id","contact_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_plan_item_id_treatment_plan_item_id_fk" FOREIGN KEY ("plan_item_id") REFERENCES "public"."treatment_plan_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription" ADD CONSTRAINT "prescription_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_item" ADD CONSTRAINT "prescription_item_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinical_follow_up_org_patient_idx" ON "clinical_follow_up" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "clinical_follow_up_item_idx" ON "clinical_follow_up" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "clinical_follow_up_due_idx" ON "clinical_follow_up" USING btree ("organization_id","due_at");--> statement-breakpoint
CREATE INDEX "patient_charge_org_patient_idx" ON "patient_charge" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_charge_item_idx" ON "patient_charge" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "patient_charge_budget_item_idx" ON "patient_charge" USING btree ("organization_id","budget_item_id");--> statement-breakpoint
CREATE INDEX "patient_payment_org_patient_idx" ON "patient_payment" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_application_org_patient_idx" ON "patient_payment_application" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_application_payment_idx" ON "patient_payment_application" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "payment_application_charge_idx" ON "patient_payment_application" USING btree ("organization_id","charge_id");--> statement-breakpoint
CREATE INDEX "payment_refund_org_patient_idx" ON "patient_payment_refund" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_refund_payment_idx" ON "patient_payment_refund" USING btree ("organization_id","payment_id");--> statement-breakpoint
CREATE INDEX "patient_responsibility_org_patient_idx" ON "patient_responsibility" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_responsibility_active_uidx" ON "patient_responsibility" USING btree ("organization_id","patient_id","contact_id","kind") WHERE "patient_responsibility"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "prescription_org_number_uidx" ON "prescription" USING btree ("organization_id","prescription_number");--> statement-breakpoint
CREATE INDEX "prescription_org_patient_idx" ON "prescription" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "prescription_encounter_idx" ON "prescription" USING btree ("organization_id","encounter_id");--> statement-breakpoint
CREATE INDEX "prescription_item_idx" ON "prescription" USING btree ("organization_id","plan_item_id");--> statement-breakpoint
CREATE INDEX "prescription_item_org_patient_idx" ON "prescription_item" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "prescription_item_prescription_idx" ON "prescription_item" USING btree ("prescription_id");--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_budget_id_treatment_budget_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."treatment_budget"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_encounter_procedure_id_encounter_procedure_id_fk" FOREIGN KEY ("encounter_procedure_id") REFERENCES "public"."encounter_procedure"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_prescription_id_prescription_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescription"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_follow_up_id_clinical_follow_up_id_fk" FOREIGN KEY ("follow_up_id") REFERENCES "public"."clinical_follow_up"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_document_context" ADD CONSTRAINT "patient_document_context_payment_id_patient_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."patient_payment"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Aislamiento obligatorio y conservación de evidencia clínica y económica.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clinical_follow_up','prescription','prescription_item',
    'patient_charge','patient_payment','patient_payment_application','patient_payment_refund',
    'patient_responsibility']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (organization_id = nullif(current_setting(''app.org_id'', true), ''''))', t);
    EXECUTE format('REVOKE DELETE ON %I FROM dentalagent_app', t);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE UPDATE ON prescription_item, patient_payment_refund FROM dentalagent_app;