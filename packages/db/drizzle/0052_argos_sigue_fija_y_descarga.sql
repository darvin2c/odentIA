ALTER TABLE "report_pin" ALTER COLUMN "figure" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "report_pin" ADD COLUMN "argos" jsonb;--> statement-breakpoint
ALTER TABLE "report_question" ADD COLUMN "plan" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "report_pin_argos_uidx" ON "report_pin" USING btree ("organization_id",md5("argos" ->> 'sql')) WHERE "report_pin"."argos" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "report_pin" ADD CONSTRAINT "report_pin_kind_check" CHECK (("report_pin"."figure" IS NULL) <> ("report_pin"."argos" IS NULL));