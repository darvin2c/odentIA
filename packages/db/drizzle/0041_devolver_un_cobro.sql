CREATE TABLE "payment_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"return_number" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"total_cents" integer NOT NULL,
	"outcome" text NOT NULL,
	"payment_method_id" uuid,
	"method_name" text,
	"method_type_code" text,
	"reason" text NOT NULL,
	"request_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_return_total_check" CHECK ("payment_return"."total_cents" > 0),
	CONSTRAINT "payment_return_outcome_check" CHECK ("payment_return"."outcome" IN ('pagado','a_favor')),
	CONSTRAINT "payment_return_method_check" CHECK (("payment_return"."outcome" = 'pagado') = ("payment_return"."method_name" IS NOT NULL) AND ("payment_return"."method_type_code" IS NULL OR "payment_return"."method_type_code" IN ('10','48','30','68','20','1')))
);
--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "original_charge_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_charge" ADD COLUMN "returned_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD COLUMN "replaces_application_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_payment_application" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_payment_refund" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "ticket_counter" ADD COLUMN "next_return_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_return" ADD CONSTRAINT "payment_return_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_return_org_id_uidx" ON "payment_return" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_return_org_number_uidx" ON "payment_return" USING btree ("organization_id","return_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_return_org_request_uidx" ON "payment_return" USING btree ("organization_id","request_id");--> statement-breakpoint
CREATE INDEX "payment_return_org_ticket_idx" ON "payment_return" USING btree ("organization_id","ticket_id");--> statement-breakpoint
CREATE INDEX "payment_return_org_patient_idx" ON "payment_return" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "patient_charge_original_idx" ON "patient_charge" USING btree ("organization_id","original_charge_id") WHERE "original_charge_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_application_org_id_uidx" ON "patient_payment_application" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "patient_charge" ADD CONSTRAINT "patient_charge_returned_check" CHECK ("patient_charge"."returned_cents" >= 0);