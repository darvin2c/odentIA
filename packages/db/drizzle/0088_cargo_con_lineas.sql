-- Cobro por acción (ADR 0030), fase 4: el cargo del tramo lleva sus líneas
-- (cuota, acciones por encima del crédito, lo que cubrió el crédito e
-- impuesto) y la factura suma exactamente lo que la clínica vio fila por fila.
ALTER TABLE "saas_charge" ADD COLUMN "subtotal_cents" integer;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD COLUMN "tax_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD COLUMN "tax_label" text;--> statement-breakpoint
ALTER TABLE "saas_charge" ADD CONSTRAINT "saas_charge_tax_check" CHECK ("saas_charge"."tax_cents" >= 0 AND ("saas_charge"."subtotal_cents" IS NULL OR "saas_charge"."subtotal_cents" + "saas_charge"."tax_cents" = "saas_charge"."amount_cents"));--> statement-breakpoint
CREATE TABLE "saas_charge_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"charge_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_base_micros" bigint,
	"unit_price_micros" bigint,
	"amount_cents" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_charge_line_kind_check" CHECK ("saas_charge_line"."kind" IN ('cuota','conversacion','consulta','cita','credito','impuesto')),
	CONSTRAINT "saas_charge_line_amount_check" CHECK ("saas_charge_line"."amount_cents" >= 0 AND "saas_charge_line"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_charge_fk" FOREIGN KEY ("organization_id","charge_id") REFERENCES "public"."saas_charge"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_charge_line_charge_idx" ON "saas_charge_line" USING btree ("organization_id","charge_id","sort_order");--> statement-breakpoint
CREATE INDEX "saas_action_org_charge_idx" ON "saas_action" USING btree ("organization_id","charge_id");--> statement-breakpoint
ALTER TABLE "saas_charge_line" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "saas_charge_line" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "saas_charge_line"
  USING ("organization_id" = nullif(current_setting('app.org_id', true), ''));
--> statement-breakpoint
-- Histórico inmutable como el cargo: la clínica lo lee; lo emite el ciclo con owner.
GRANT SELECT ON "saas_charge_line" TO dentalagent_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "saas_charge_line" FROM dentalagent_app;
