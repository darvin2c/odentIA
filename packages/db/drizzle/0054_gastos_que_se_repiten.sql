CREATE TABLE "expense_recurring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"branch_id" uuid NOT NULL,
	"category" text NOT NULL,
	"concept" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"every_months" smallint NOT NULL,
	"day" smallint NOT NULL,
	"first_month" text NOT NULL,
	"last_month" text,
	"member_user_id" text,
	"from_cash" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_recurring_every_check" CHECK ("expense_recurring"."every_months" IN (1, 6, 12)),
	CONSTRAINT "expense_recurring_day_check" CHECK ("expense_recurring"."day" BETWEEN 1 AND 31),
	CONSTRAINT "expense_recurring_amount_check" CHECK ("expense_recurring"."amount_cents" > 0),
	CONSTRAINT "expense_recurring_month_check" CHECK ("expense_recurring"."first_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ("expense_recurring"."last_month" IS NULL OR "expense_recurring"."last_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')),
	CONSTRAINT "expense_recurring_member_check" CHECK ("expense_recurring"."member_user_id" IS NULL OR "expense_recurring"."category" = 'Personal')
);
--> statement-breakpoint
CREATE TABLE "expense_recurring_skip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"recurring_id" uuid NOT NULL,
	"month" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	CONSTRAINT "expense_recurring_skip_month_check" CHECK ("expense_recurring_skip"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "expense_recurring_org_id_uidx" ON "expense_recurring" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "recurring_id" uuid;--> statement-breakpoint
ALTER TABLE "expense" ADD COLUMN "recurring_month" text;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD CONSTRAINT "expense_recurring_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD CONSTRAINT "expense_recurring_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD CONSTRAINT "expense_recurring_member_user_id_user_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring" ADD CONSTRAINT "expense_recurring_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring_skip" ADD CONSTRAINT "expense_recurring_skip_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring_skip" ADD CONSTRAINT "expense_recurring_skip_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring_skip" ADD CONSTRAINT "expense_recurring_skip_voided_by_user_id_fk" FOREIGN KEY ("voided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring_skip" ADD CONSTRAINT "expense_recurring_skip_recurring_org_fk" FOREIGN KEY ("organization_id","recurring_id") REFERENCES "public"."expense_recurring"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_recurring_org_branch_idx" ON "expense_recurring" USING btree ("organization_id","branch_id");--> statement-breakpoint
CREATE INDEX "expense_recurring_org_member_idx" ON "expense_recurring" USING btree ("organization_id","member_user_id") WHERE "expense_recurring"."member_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_recurring_skip_uidx" ON "expense_recurring_skip" USING btree ("organization_id","recurring_id","month") WHERE "expense_recurring_skip"."voided_at" IS NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_recurring_id_org_fk" FOREIGN KEY ("organization_id","recurring_id") REFERENCES "public"."expense_recurring"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_recurring_month_uidx" ON "expense" USING btree ("organization_id","recurring_id","recurring_month") WHERE "expense"."recurring_id" IS NOT NULL AND "expense"."voided_at" IS NULL;--> statement-breakpoint
ALTER TABLE "expense" ADD CONSTRAINT "expense_recurring_link_check" CHECK (("expense"."recurring_id" IS NULL) = ("expense"."recurring_month" IS NULL) AND ("expense"."recurring_month" IS NULL OR "expense"."recurring_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'));