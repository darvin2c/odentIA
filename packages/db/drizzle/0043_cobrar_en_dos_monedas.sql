ALTER TABLE "cash_movement" DROP CONSTRAINT "cash_movement_kind_check";--> statement-breakpoint
DROP INDEX "cash_movement_payment_uidx";--> statement-breakpoint
ALTER TABLE "treatment_budget" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "tender_cents" integer;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "tender_currency" char(3);--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "exchange_rate" numeric;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "business_cents" integer;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD COLUMN "tender_cents" integer;--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD COLUMN "change_currency" text;--> statement-breakpoint
ALTER TABLE "cash_closure" ADD COLUMN "cash_change_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "tender_cents" integer;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "tender_currency" char(3);--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "exchange_rate" numeric;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "business_cents" integer;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "second_currency" text;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "exchange_rate" numeric;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "exchange_factor" numeric;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "exchange_rate_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "exchange_rate_by" text;--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_exchange_rate_by_user_id_fk" FOREIGN KEY ("exchange_rate_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_payment_org_ticket_idx" ON "patient_payment" USING btree ("organization_id","ticket_id") WHERE "patient_payment"."ticket_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_payment_uidx" ON "cash_movement" USING btree ("organization_id","patient_payment_id","kind","direction") WHERE "cash_movement"."patient_payment_id" IS NOT NULL AND "cash_movement"."voided_at" IS NULL;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_tender_check" CHECK (("patient_payment"."tender_cents" IS NULL) = ("patient_payment"."tender_currency" IS NULL) AND ("patient_payment"."tender_cents" IS NULL OR ("patient_payment"."tender_cents" >= 0 AND "patient_payment"."tender_currency" <> "patient_payment"."currency" AND "patient_payment"."exchange_rate" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_value_check" CHECK (("patient_payment"."exchange_rate" IS NULL) = ("patient_payment"."business_cents" IS NULL) AND ("patient_payment"."exchange_rate" IS NULL OR ("patient_payment"."exchange_rate" > 0 AND "patient_payment"."business_cents" >= 0)));--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "payment_refund_tender_check" CHECK ("patient_payment_refund"."tender_cents" IS NULL OR "patient_payment_refund"."tender_cents" >= 0);--> statement-breakpoint
ALTER TABLE "payment_ticket" ADD CONSTRAINT "payment_ticket_change_currency_check" CHECK ("payment_ticket"."change_currency" IS NULL OR "payment_ticket"."change_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_kind_check" CHECK ("cash_movement"."kind" IN ('apertura','cobro','gasto','aporte','retiro','devolucion','vuelto'));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_tender_check" CHECK (("expense"."tender_cents" IS NULL) = ("expense"."tender_currency" IS NULL) AND ("expense"."tender_cents" IS NULL OR ("expense"."tender_cents" >= 0 AND "expense"."tender_currency" <> "expense"."currency" AND "expense"."exchange_rate" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_value_check" CHECK (("expense"."exchange_rate" IS NULL) = ("expense"."business_cents" IS NULL) AND ("expense"."exchange_rate" IS NULL OR ("expense"."exchange_rate" > 0 AND "expense"."business_cents" >= 0)));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_second_currency_check" CHECK ("org_profile"."second_currency" IS NULL OR ("org_profile"."second_currency" ~ '^[A-Z]{3}$' AND "org_profile"."second_currency" <> "org_profile"."currency"));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_exchange_check" CHECK (("org_profile"."second_currency" IS NULL) = ("org_profile"."exchange_rate" IS NULL) AND ("org_profile"."exchange_rate" IS NULL) = ("org_profile"."exchange_factor" IS NULL) AND ("org_profile"."exchange_rate" IS NULL) = ("org_profile"."exchange_rate_at" IS NULL) AND ("org_profile"."exchange_rate" IS NULL OR ("org_profile"."exchange_rate" > 0 AND "org_profile"."exchange_factor" > 0)));