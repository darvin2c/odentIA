CREATE TABLE "expense_payable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"category" text DEFAULT 'Laboratorio' NOT NULL,
	"concept" text NOT NULL,
	"supplier_id" uuid,
	"supplier_name" text NOT NULL,
	"supplier_tax_id" text,
	"receipt_type" text,
	"receipt_number" text,
	"issued_on" date NOT NULL,
	"due_on" date,
	"currency" char(3) NOT NULL,
	"amount_cents" integer NOT NULL,
	"patient_id" uuid,
	"plan_item_id" uuid,
	"notes" text,
	"request_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	CONSTRAINT "expense_payable_amount_check" CHECK ("expense_payable"."amount_cents" > 0),
	CONSTRAINT "expense_payable_due_check" CHECK ("expense_payable"."due_on" IS NULL OR "expense_payable"."due_on" >= "expense_payable"."issued_on"),
	CONSTRAINT "expense_payable_plan_item_check" CHECK ("expense_payable"."plan_item_id" IS NULL OR "expense_payable"."patient_id" IS NOT NULL),
	CONSTRAINT "expense_payable_category_check" CHECK ("expense_payable"."category" <> 'Personal')
);
--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "payable_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_supplier_org_fk" FOREIGN KEY ("organization_id","supplier_id") REFERENCES "public"."supplier"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_patient_org_fk" FOREIGN KEY ("organization_id","patient_id") REFERENCES "public"."patient"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_payable" ADD CONSTRAINT "expense_payable_plan_item_org_fk" FOREIGN KEY ("organization_id","patient_id","plan_item_id") REFERENCES "public"."treatment_plan_item"("organization_id","patient_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_payable_org_id_uidx" ON "expense_payable" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_payable_org_request_uidx" ON "expense_payable" USING btree ("organization_id","request_id") WHERE "expense_payable"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "expense_payable_org_branch_open_idx" ON "expense_payable" USING btree ("organization_id","branch_id") WHERE "expense_payable"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "expense_payable_org_patient_idx" ON "expense_payable" USING btree ("organization_id","patient_id") WHERE "expense_payable"."patient_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_payable_org_fk" FOREIGN KEY ("organization_id","payable_id") REFERENCES "public"."expense_payable"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_org_payable_idx" ON "expense" USING btree ("organization_id","payable_id") WHERE "expense"."payable_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_payable_or_purchase_check" CHECK ("expense"."payable_id" IS NULL OR "expense"."purchase_order_id" IS NULL);