CREATE TABLE "storage_usage_day" (
	"organization_id" text NOT NULL,
	"day" text NOT NULL,
	"bytes" bigint NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_usage_day_check" CHECK ("storage_usage_day"."bytes" >= 0 AND "storage_usage_day"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
ALTER TABLE "saas_action" DROP CONSTRAINT "saas_action_kind_check";--> statement-breakpoint
ALTER TABLE "saas_charge_line" DROP CONSTRAINT "saas_charge_line_kind_check";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "report_question_id" uuid;--> statement-breakpoint
ALTER TABLE "saas_action" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "saas_action" ADD COLUMN "units" integer;--> statement-breakpoint
-- Lo ya contado tenía un solo precio por acción: la conversación era la de
-- «Gestiona» y la consulta la «Completa» (ADR 0085).
UPDATE "saas_action" SET "tier" = 'gestiona' WHERE "kind" = 'conversacion';--> statement-breakpoint
UPDATE "saas_action" SET "tier" = 'completa' WHERE "kind" = 'consulta';--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "conversation_inform_micros" bigint;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "conversation_agenda_micros" bigint;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "consultation_simple_micros" bigint;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "consultation_standard_micros" bigint;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "argos_included_questions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "argos_pack_questions" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "argos_pack_micros" bigint;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "storage_included_gb" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "storage_gb_micros" bigint;--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD COLUMN "fixed_price_tiers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "saas_subscription" ADD COLUMN "argos_auto_pack" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_usage_day" ADD CONSTRAINT "storage_usage_day_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_usage_day_org_day_uidx" ON "storage_usage_day" USING btree ("organization_id","day");--> statement-breakpoint
ALTER TABLE "saas_action" ADD CONSTRAINT "saas_action_tier_check" CHECK (coalesce(CASE "saas_action"."kind" WHEN 'conversacion' THEN "saas_action"."tier" IN ('informa','gestiona','agenda') WHEN 'consulta' THEN "saas_action"."tier" IN ('simple','estandar','completa') ELSE "saas_action"."tier" IS NULL END, false) AND ("saas_action"."units" IS NULL OR "saas_action"."units" > 0));--> statement-breakpoint
ALTER TABLE "saas_action" ADD CONSTRAINT "saas_action_kind_check" CHECK ("saas_action"."kind" IN ('conversacion','consulta','cita','preguntas','almacenamiento'));--> statement-breakpoint
ALTER TABLE "saas_charge_line" ADD CONSTRAINT "saas_charge_line_kind_check" CHECK ("saas_charge_line"."kind" IN ('cuota','conversacion','consulta','cita','preguntas','almacenamiento','devolucion','revision','credito','impuesto'));--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD CONSTRAINT "saas_plan_tier_check" CHECK (coalesce("admin"."saas_plan"."conversation_inform_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."conversation_agenda_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."consultation_simple_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."consultation_standard_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."argos_pack_micros", 0) >= 0 AND coalesce("admin"."saas_plan"."storage_gb_micros", 0) >= 0 AND "admin"."saas_plan"."argos_included_questions" >= 0 AND "admin"."saas_plan"."argos_pack_questions" BETWEEN 1 AND 10000 AND "admin"."saas_plan"."storage_included_gb" >= 0);--> statement-breakpoint
ALTER TABLE "admin"."saas_plan" ADD CONSTRAINT "saas_plan_fixed_tiers_check" CHECK ("admin"."saas_plan"."fixed_price_tiers" <@ ARRAY['informa','gestiona','agenda','simple','estandar','completa','cita','preguntas','almacenamiento']::text[]);