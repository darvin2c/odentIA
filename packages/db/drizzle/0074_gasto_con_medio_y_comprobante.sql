ALTER TABLE "expense" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "method_name" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "method_type_code" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "receipt_type" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "supplier_tax_id" text;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "replaces_expense_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_payment_method_org_fk" FOREIGN KEY ("organization_id","payment_method_id") REFERENCES "public"."organization_payment_method"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_supplier_org_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."supplier"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- La clave (clínica, gasto) antes de la referencia de «Corregir», que la necesita.
CREATE UNIQUE INDEX "expense_org_id_uidx" ON "expense" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_replaces_org_fk" FOREIGN KEY ("organization_id","replaces_expense_id") REFERENCES "public"."expense"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD CONSTRAINT "expense_recurring_payment_method_org_fk" FOREIGN KEY ("organization_id","payment_method_id") REFERENCES "public"."organization_payment_method"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_replaces_uidx" ON "expense" USING btree ("organization_id","replaces_expense_id") WHERE "expense"."replaces_expense_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_method_check" CHECK (("expense"."payment_method_id" IS NULL OR "expense"."method_name" IS NOT NULL) AND ("expense"."method_type_code" IS NULL OR "expense"."method_type_code" IN ('10','48','30','68','20','1')));