CREATE TABLE "expense_gap_dismissal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"category" text NOT NULL,
	"month" text NOT NULL,
	"branch_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_gap_dismissal_month_check" CHECK ("expense_gap_dismissal"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_use" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "supplier_credit_use_amount_check" CHECK ("supplier_credit_use"."amount_cents" > 0),
	CONSTRAINT "supplier_credit_use_currency_check" CHECK ("supplier_credit_use"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD COLUMN "valid_from" date DEFAULT current_date NOT NULL;--> statement-breakpoint
ALTER TABLE "professional_schedule" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "patient" ADD COLUMN "referral_kind" text;--> statement-breakpoint
-- A mano (decisión 3 de Reportes v2): lo que ya se escribió como texto libre
-- queda como «Otro» con su texto, antes de exigir que el texto sea solo de «Otro».
-- Un texto en blanco no dice nada y se vacía.
UPDATE "patient" SET "referral_source" = NULL WHERE "referral_source" IS NOT NULL AND btrim("referral_source") = '';--> statement-breakpoint
UPDATE "patient" SET "referral_kind" = 'otro' WHERE "referral_source" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "order_number" integer;--> statement-breakpoint
ALTER TABLE "expense_gap_dismissal" ADD CONSTRAINT "expense_gap_dismissal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_gap_dismissal" ADD CONSTRAINT "expense_gap_dismissal_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_gap_dismissal" ADD CONSTRAINT "expense_gap_dismissal_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_organization_id_supplier_id_supplier_organization_id_id_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."supplier"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_use" ADD CONSTRAINT "supplier_credit_use_organization_id_order_id_purchase_order_organization_id_id_fk" FOREIGN KEY ("organization_id","order_id") REFERENCES "public"."purchase_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_credit_use_org_supplier_idx" ON "supplier_credit_use" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_credit_use_org_order_idx" ON "supplier_credit_use" USING btree ("organization_id","order_id");--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_organization_id_purchase_order_id_purchase_order_organization_id_id_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_order"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "professional_schedule_org_valid_idx" ON "professional_schedule" USING btree ("organization_id","valid_from");--> statement-breakpoint
CREATE INDEX "expense_org_purchase_idx" ON "expense" USING btree ("organization_id","purchase_order_id") WHERE "expense"."purchase_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_org_number_uidx" ON "purchase_order" USING btree ("organization_id","order_number");--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_referral_kind_check" CHECK ("patient"."referral_kind" IS NULL OR "patient"."referral_kind" IN ('recomendacion','redes_sociales','google_mapas','paso_por_aqui','convenio','otro'));--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_referral_source_check" CHECK ("patient"."referral_source" IS NULL OR "patient"."referral_kind" = 'otro');--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_purchase_category_check" CHECK ("expense"."purchase_order_id" IS NULL OR "expense"."category" = 'Materiales');