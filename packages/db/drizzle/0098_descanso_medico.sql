CREATE TABLE "medical_leave" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"leave_number" integer NOT NULL,
	"status" text DEFAULT 'emitido' NOT NULL,
	"starts_on" date NOT NULL,
	"days" integer NOT NULL,
	"ends_on" date NOT NULL,
	"show_diagnosis" boolean DEFAULT false NOT NULL,
	"diagnosis_system" text,
	"diagnosis_code" text,
	"notes" text,
	"signer_name" text,
	"signer_title" text,
	"signer_registration" text,
	"issued_by" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medical_leave_diagnosis_pair_check" CHECK (("medical_leave"."diagnosis_system" IS NULL) = ("medical_leave"."diagnosis_code" IS NULL)),
	CONSTRAINT "medical_leave_status_check" CHECK ("medical_leave"."status" in ('emitido','anulado')),
	CONSTRAINT "medical_leave_days_check" CHECK ("medical_leave"."days" BETWEEN 1 AND 365),
	CONSTRAINT "medical_leave_dates_check" CHECK ("medical_leave"."ends_on" >= "medical_leave"."starts_on"),
	CONSTRAINT "medical_leave_diagnosis_check" CHECK ("medical_leave"."diagnosis_code" IS NULL OR "medical_leave"."show_diagnosis"),
	CONSTRAINT "medical_leave_cancel_check" CHECK (("medical_leave"."cancelled_at" IS NULL) = ("medical_leave"."cancel_reason" IS NULL) AND ("medical_leave"."cancelled_at" IS NULL) = ("medical_leave"."status" = 'emitido') AND ("medical_leave"."cancel_reason" IS NULL OR char_length("medical_leave"."cancel_reason") BETWEEN 1 AND 2000))
);
--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_encounter_id_encounter_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounter"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_cancelled_by_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_leave" ADD CONSTRAINT "medical_leave_diagnosis_fk" FOREIGN KEY ("diagnosis_system","diagnosis_code") REFERENCES "catalog"."diagnosis_code"("system_key","code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medical_leave_org_number_uidx" ON "medical_leave" USING btree ("organization_id","leave_number");--> statement-breakpoint
CREATE INDEX "medical_leave_org_patient_idx" ON "medical_leave" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "medical_leave_encounter_idx" ON "medical_leave" USING btree ("organization_id","encounter_id");