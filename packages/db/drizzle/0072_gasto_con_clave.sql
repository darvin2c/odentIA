ALTER TABLE "cash_movement" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD COLUMN "request_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_org_request_uidx" ON "cash_movement" USING btree ("organization_id","request_id") WHERE "cash_movement"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_org_request_uidx" ON "expense" USING btree ("organization_id","request_id") WHERE "expense"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_recurring_org_request_uidx" ON "expense_recurring" USING btree ("organization_id","request_id") WHERE "expense_recurring"."request_id" IS NOT NULL;