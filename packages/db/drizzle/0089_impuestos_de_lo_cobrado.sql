ALTER TABLE "patient_charge" ADD COLUMN "tax_category" text;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "tax_bps" integer;--> statement-breakpoint
ALTER TABLE "patient_payment" ADD COLUMN "tax_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD COLUMN "tax_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "sales_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "tax_legal_form" text;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "services_tax_category" text;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "services_tax_bps" integer;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "products_tax_category" text;--> statement-breakpoint
ALTER TABLE "org_profile" ADD COLUMN "products_tax_bps" integer;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_tax_check" CHECK (("patient_charge"."tax_category" IS NULL) = ("patient_charge"."tax_bps" IS NULL) AND ("patient_charge"."tax_category" IS NULL OR ("patient_charge"."tax_category" = 'S' AND "patient_charge"."tax_bps" BETWEEN 1 AND 5000) OR ("patient_charge"."tax_category" IN ('E','O','Z') AND "patient_charge"."tax_bps" = 0)));--> statement-breakpoint
ALTER TABLE "patient_payment" ADD CONSTRAINT "patient_payment_tax_check" CHECK ("patient_payment"."tax_cents" BETWEEN 0 AND "patient_payment"."amount_cents");--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD CONSTRAINT "payment_refund_tax_check" CHECK ("patient_payment_refund"."tax_cents" BETWEEN 0 AND "patient_payment_refund"."amount_cents");--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_sales_tax_check" CHECK (NOT "expense"."sales_tax" OR "expense"."category" = 'Impuestos');--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_services_tax_check" CHECK (("org_profile"."services_tax_category" IS NULL) = ("org_profile"."services_tax_bps" IS NULL) AND ("org_profile"."services_tax_category" IS NULL OR ("org_profile"."services_tax_category" = 'S' AND "org_profile"."services_tax_bps" BETWEEN 1 AND 5000) OR ("org_profile"."services_tax_category" IN ('E','O','Z') AND "org_profile"."services_tax_bps" = 0)));--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_products_tax_check" CHECK (("org_profile"."products_tax_category" IS NULL) = ("org_profile"."products_tax_bps" IS NULL) AND ("org_profile"."products_tax_category" IS NULL OR ("org_profile"."products_tax_category" = 'S' AND "org_profile"."products_tax_bps" BETWEEN 1 AND 5000) OR ("org_profile"."products_tax_category" IN ('E','O','Z') AND "org_profile"."products_tax_bps" = 0)));