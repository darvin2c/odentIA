CREATE TABLE "product_minimum" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"min_quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_minimum_quantity_check" CHECK ("product_minimum"."min_quantity" BETWEEN 0 AND 1000000000)
);
--> statement-breakpoint
CREATE TABLE "service_material" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"service_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_material_quantity_check" CHECK ("service_material"."quantity" BETWEEN 1 AND 9999)
);
--> statement-breakpoint
CREATE TABLE "stock_shortage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_shortage_quantity_check" CHECK ("stock_shortage"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "purchase_order" DROP CONSTRAINT "purchase_order_status_check";--> statement-breakpoint
ALTER TABLE "stock_movement" DROP CONSTRAINT "stock_movement_kind_check";--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "product_quantity" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "used_in_care" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "for_sale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "purchase_unit" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "purchase_unit_code" text;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "purchase_factor" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "unit_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "sale_price_cents" integer;--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "sale_currency" char(3);--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "ordered_unit_cost_cents" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "purchase_unit" text;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD COLUMN "unit_factor" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD COLUMN "charge_id" uuid;--> statement-breakpoint
ALTER TABLE "warehouse" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_minimum" ADD CONSTRAINT "product_minimum_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_minimum" ADD CONSTRAINT "product_minimum_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."product"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_minimum" ADD CONSTRAINT "product_minimum_branch_fk" FOREIGN KEY ("organization_id","branch_id") REFERENCES "public"."branch"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_material" ADD CONSTRAINT "service_material_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_material" ADD CONSTRAINT "service_material_service_fk" FOREIGN KEY ("organization_id","service_id") REFERENCES "public"."service_catalog"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_material" ADD CONSTRAINT "service_material_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."product"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_shortage" ADD CONSTRAINT "stock_shortage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_shortage" ADD CONSTRAINT "stock_shortage_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."product"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_shortage" ADD CONSTRAINT "stock_shortage_warehouse_fk" FOREIGN KEY ("organization_id","warehouse_id") REFERENCES "public"."warehouse"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_minimum_org_product_branch_uidx" ON "product_minimum" USING btree ("organization_id","product_id","branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_material_org_service_product_uidx" ON "service_material" USING btree ("organization_id","service_id","product_id");--> statement-breakpoint
CREATE INDEX "service_material_org_product_idx" ON "service_material" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_shortage_org_product_warehouse_uidx" ON "stock_shortage" USING btree ("organization_id","product_id","warehouse_id");--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_encounter_fk" FOREIGN KEY ("organization_id","patient_id","encounter_id") REFERENCES "public"."encounter"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_charge_org_id_uidx" ON "patient_charge" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_charge_fk" FOREIGN KEY ("organization_id","charge_id") REFERENCES "public"."patient_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_movement_org_encounter_idx" ON "stock_movement" USING btree ("organization_id","encounter_id") WHERE "stock_movement"."encounter_id" is not null;--> statement-breakpoint
CREATE INDEX "stock_movement_org_charge_idx" ON "stock_movement" USING btree ("organization_id","charge_id") WHERE "stock_movement"."charge_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_branch_default_uidx" ON "warehouse" USING btree ("organization_id","branch_id") WHERE "is_default";--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_product_check" CHECK (("patient_charge"."product_id" IS NULL) = ("patient_charge"."product_quantity" IS NULL) AND ("patient_charge"."product_quantity" IS NULL OR "patient_charge"."product_quantity" BETWEEN 1 AND 9999));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_use_check" CHECK ("product"."used_in_care" OR "product"."for_sale");--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_purchase_factor_check" CHECK ("product"."purchase_factor" BETWEEN 1 AND 100000);--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_sale_price_check" CHECK (("product"."sale_price_cents" IS NULL) = ("product"."sale_currency" IS NULL) AND ("product"."sale_price_cents" IS NULL OR "product"."sale_price_cents" >= 0));--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_sale_currency_check" CHECK ("product"."sale_currency" IS NULL OR "product"."sale_currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_status_check" CHECK ("purchase_order"."status" IN ('borrador','confirmada','parcialmente_recibida','recibida','cerrada','cancelada'));--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_ordered_cost_check" CHECK ("purchase_order_line"."ordered_unit_cost_cents" IS NULL OR "purchase_order_line"."ordered_unit_cost_cents" >= 0);--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_factor_check" CHECK ("purchase_order_line"."unit_factor" BETWEEN 1 AND 100000);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_encounter_patient_check" CHECK ("stock_movement"."encounter_id" IS NULL OR "stock_movement"."patient_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_kind_check" CHECK ("stock_movement"."kind" IN ('ingreso','consumo','ajuste','traslado','venta','cobertura','devolucion'));