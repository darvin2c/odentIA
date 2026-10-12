-- Retirar cuotas conserva su evidencia; cargos y aplicaciones no se modifican.
INSERT INTO audit_event (organization_id, action, entity, entity_id, metadata)
SELECT p.organization_id, 'installment.archived', 'installment_plan', p.id::text,
       jsonb_build_object('plan', to_jsonb(p), 'quotas',
         COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.nro)
                   FROM installment_quota q WHERE q.plan_id = p.id), '[]'::jsonb))
FROM installment_plan p;
--> statement-breakpoint
-- Ninguna tasa se deduce de reglas ambiguas; la configuración anterior queda en auditoría.
INSERT INTO audit_event (organization_id, action, entity, entity_id, metadata)
SELECT organization_id, 'commission.rule_archived', 'commission_rule', id::text, to_jsonb(r)
FROM commission_rule r;
--> statement-breakpoint
DELETE FROM commission_rule r
WHERE NOT (
  r.base = 'cobrado' AND r.service_id IS NULL AND r.branch_id IS NULL
  AND r.is_active AND (r.valid_from IS NULL OR r.valid_from <= CURRENT_DATE)
  AND (r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)
  AND (SELECT count(*) FROM commission_rule other
       WHERE other.organization_id = r.organization_id
         AND other.professional_user_id = r.professional_user_id) = 1
);
--> statement-breakpoint
CREATE TABLE "payment_ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"ticket_number" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"total_cents" integer NOT NULL,
	"credit_applied_cents" integer DEFAULT 0 NOT NULL,
	"cash_received_cents" integer,
	"change_cents" integer,
	"payer_contact_id" uuid,
	"request_id" uuid,
	"snapshot" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "payment_ticket_total_check" CHECK ("payment_ticket"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ticket_counter" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_closure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"shift_id" uuid NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"opening_retained_cents" integer DEFAULT 0 NOT NULL,
	"cash_collected_cents" integer DEFAULT 0 NOT NULL,
	"expense_cash_cents" integer DEFAULT 0 NOT NULL,
	"expected_cents" integer NOT NULL,
	"counted_cents" integer NOT NULL,
	"difference_cents" integer NOT NULL,
	"retained_cents" integer NOT NULL,
	"delivered_cents" integer NOT NULL,
	"totals_by_method" jsonb NOT NULL,
	"notes" text,
	"closed_by" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_payment_method" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type_code" text DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_payment_method_type_check" CHECK ("organization_payment_method"."type_code" IN ('10','48','30','68','20','1')),
	CONSTRAINT "organization_payment_method_sort_check" CHECK ("organization_payment_method"."sort_order" >= 0),
	CONSTRAINT "organization_payment_method_name_check" CHECK (length(trim("organization_payment_method"."name")) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TABLE "promotion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"conditions" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_dates_check" CHECK ("promotion"."ends_at" IS NULL OR "promotion"."ends_at" >= "promotion"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "promotion_service_price" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"promotion_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"mode" text DEFAULT 'fixed' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_service_price_mode_check" CHECK ("promotion_service_price"."mode" IN ('fixed','from')),
	CONSTRAINT "promotion_service_price_amount_check" CHECK ("promotion_service_price"."price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "installment_plan" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installment_quota" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "installment_plan" CASCADE;--> statement-breakpoint
DROP TABLE "installment_quota" CASCADE;--> statement-breakpoint
ALTER TABLE "patient_payment" DROP CONSTRAINT "patient_payment_method_check";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP CONSTRAINT "commission_rule_base_check";--> statement-breakpoint
ALTER TABLE "commission_settlement" DROP CONSTRAINT "commission_settlement_period_check";--> statement-breakpoint
ALTER TABLE "expense" DROP CONSTRAINT "expense_receipt_check";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP CONSTRAINT "commission_rule_branch_id_branch_id_fk";
--> statement-breakpoint
DROP INDEX "commission_rule_org_prof_idx";--> statement-breakpoint
DROP INDEX "commission_settlement_org_prof_idx";--> statement-breakpoint
ALTER TABLE "commission_settlement" ALTER COLUMN "period_from" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_settlement" ALTER COLUMN "period_to" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_settlement" ALTER COLUMN "base" SET DEFAULT 'cobrado';--> statement-breakpoint
ALTER TABLE "commission_settlement" ALTER COLUMN "status" SET DEFAULT 'liquidada';--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "promotion_id" text;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "promotion_name" text;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "edit_reason" text;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "method_type_code" text;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "service_catalog" ADD COLUMN "billing_mode" text DEFAULT 'treatment' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "tariff_price_cents" integer;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "price_reason" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "promotion_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "promotion_name" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "promotion_mode" text;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "billing_mode" text DEFAULT 'treatment' NOT NULL;--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD COLUMN "sessions_planned" smallint;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "preferred_channel" text;--> statement-breakpoint
ALTER TABLE "cash_movement" ADD COLUMN "method_type_code" text;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD COLUMN "retained_cents" integer;--> statement-breakpoint
ALTER TABLE "cash_shift" ADD COLUMN "delivered_cents" integer;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD COLUMN "period_year" integer;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD COLUMN "period_month" integer;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD COLUMN "rate_bps" integer;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD COLUMN "expense_id" uuid;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "application_id" uuid;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD COLUMN "rate_bps" integer;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "category" text DEFAULT 'Otros' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "receipt_width" text DEFAULT '80' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "sheet_size" text DEFAULT 'A4' NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "ticket_footer" text DEFAULT 'Recibo interno. No es un documento fiscal.' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_payer_contact_id_contact_id_fk" FOREIGN KEY ("payer_contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_counter" ADD CONSTRAINT "ticket_counter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_shift_id_cash_shift_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."cash_shift"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD CONSTRAINT "cash_closure_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_payment_method" ADD CONSTRAINT "organization_payment_method_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion" ADD CONSTRAINT "promotion_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_promotion_id_promotion_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_service_id_service_catalog_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service_catalog"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_service_price" ADD CONSTRAINT "promotion_service_price_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_ticket_org_patient_idx" ON "payment_ticket" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "payment_ticket_org_branch_idx" ON "payment_ticket" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ticket_org_number_uidx" ON "payment_ticket" USING btree ("organization_id","ticket_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_ticket_org_request_uidx" ON "payment_ticket" USING btree ("organization_id","request_id") WHERE "payment_ticket"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cash_closure_org_branch_idx" ON "cash_closure" USING btree ("organization_id","branch_id","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_closure_shift_uidx" ON "cash_closure" USING btree ("organization_id","shift_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_payment_method_org_id_uidx" ON "organization_payment_method" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "organization_payment_method_org_active_idx" ON "organization_payment_method" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "organization_payment_method_org_sort_idx" ON "organization_payment_method" USING btree ("organization_id","sort_order","id");--> statement-breakpoint
CREATE INDEX "promotion_org_active_idx" ON "promotion" USING btree ("organization_id","is_active","starts_at");--> statement-breakpoint
CREATE INDEX "promotion_org_ends_idx" ON "promotion" USING btree ("organization_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_service_price_promo_service_uidx" ON "promotion_service_price" USING btree ("promotion_id","service_id");--> statement-breakpoint
CREATE INDEX "promotion_service_price_org_service_idx" ON "promotion_service_price" USING btree ("organization_id","service_id");--> statement-breakpoint
CREATE INDEX "promotion_service_price_org_promo_idx" ON "promotion_service_price" USING btree ("organization_id","promotion_id");--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_ticket_id_payment_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."payment_ticket"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD CONSTRAINT "patient_payment_application_ticket_id_payment_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."payment_ticket"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_expense_id_expense_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expense"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_settlement_line" ADD CONSTRAINT "commission_settlement_line_application_id_patient_payment_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."patient_payment_application"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_budget_item_org_promotion_idx" ON "treatment_budget_item" USING btree ("organization_id","promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_rule_org_prof_uidx" ON "commission_rule" USING btree ("organization_id","professional_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_settlement_month_uidx" ON "commission_settlement" USING btree ("organization_id","professional_user_id","period_year","period_month","currency") WHERE "commission_settlement"."voided_at" IS NULL AND "commission_settlement"."period_year" IS NOT NULL AND "commission_settlement"."period_month" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_rule" DROP COLUMN "base";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP COLUMN "service_id";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP COLUMN "branch_id";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP COLUMN "valid_from";--> statement-breakpoint
ALTER TABLE "commission_rule" DROP COLUMN "valid_to";--> statement-breakpoint
ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_billing_mode_check" CHECK ("service_catalog"."billing_mode" IN ('treatment','session'));--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_billing_mode_check" CHECK ("treatment_budget_item"."billing_mode" IN ('treatment','session'));--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_promotion_mode_check" CHECK ("treatment_budget_item"."promotion_mode" IS NULL OR "treatment_budget_item"."promotion_mode" IN ('fixed','from'));--> statement-breakpoint
ALTER TABLE "treatment_budget_item" ADD CONSTRAINT "treatment_budget_item_promotion_check" CHECK (("treatment_budget_item"."promotion_id" IS NULL) = ("treatment_budget_item"."promotion_name" IS NULL));--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_preferred_channel_check" CHECK ("contact"."preferred_channel" IS NULL OR "contact"."preferred_channel" IN ('email','whatsapp','telegram','messenger','instagram'));--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_month_check" CHECK ("commission_settlement"."period_month" IS NULL OR ("commission_settlement"."period_month" BETWEEN 1 AND 12));--> statement-breakpoint
ALTER TABLE "commission_settlement" ADD CONSTRAINT "commission_settlement_rate_check" CHECK ("commission_settlement"."rate_bps" IS NULL OR ("commission_settlement"."rate_bps" BETWEEN 0 AND 10000));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_receipt_width_check" CHECK ("org_profile"."receipt_width" IN ('58','80'));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_sheet_size_check" CHECK ("org_profile"."sheet_size" IN ('A4','Letter'));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_ticket_footer_check" CHECK (length(trim("org_profile"."ticket_footer")) BETWEEN 1 AND 280);