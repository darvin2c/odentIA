CREATE TABLE "admin"."app_contract_message" (
	"app" text NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"account_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_contract_message_pkey" PRIMARY KEY("app","id"),
	CONSTRAINT "app_contract_message_id_check" CHECK (length("admin"."app_contract_message"."id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" DROP CONSTRAINT "saas_plan_product_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_account" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_account" ADD COLUMN "country" char(2);--> statement-breakpoint
ALTER TABLE "admin"."saas_account" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_account" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."app_contract_message" ADD CONSTRAINT "app_contract_message_account_id_saas_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "admin"."saas_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_account" ADD CONSTRAINT "saas_account_app_data_check" CHECK (CASE WHEN organization_id IS NOT NULL THEN name IS NULL AND country IS NULL AND owner_user_id IS NULL AND synced_at IS NULL
        ELSE (name IS NULL OR length(trim(name)) BETWEEN 1 AND 200) AND (country IS NULL OR country ~ '^[A-Z]{2}$') END);--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD CONSTRAINT "saas_plan_product_check" CHECK ("admin"."saas_plan"."product" IN ('dental','medical','optical','gestoria'));