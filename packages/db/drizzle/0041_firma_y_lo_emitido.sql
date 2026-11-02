CREATE TABLE "issued_paper" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"patient_initials" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issued_paper_type_check" CHECK ("issued_paper"."document_type" in ('prescription','order','medical_leave','attention_sheet')),
	CONSTRAINT "issued_paper_sha256_check" CHECK ("issued_paper"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "professional_drawn_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"strokes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "signer_name" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "signer_title" text;--> statement-breakpoint
ALTER TABLE "clinical_order" ADD COLUMN "signer_registration" text;--> statement-breakpoint
ALTER TABLE "dental"."odontogram_assessment" ADD COLUMN "paper_header" jsonb;--> statement-breakpoint
ALTER TABLE "issued_paper" ADD CONSTRAINT "issued_paper_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_paper" ADD CONSTRAINT "issued_paper_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_drawn_signature" ADD CONSTRAINT "professional_drawn_signature_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_drawn_signature" ADD CONSTRAINT "professional_drawn_signature_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issued_paper_document_uidx" ON "issued_paper" USING btree ("organization_id","document_type","document_id");--> statement-breakpoint
CREATE INDEX "professional_drawn_signature_org_user_idx" ON "professional_drawn_signature" USING btree ("organization_id","user_id","created_at");