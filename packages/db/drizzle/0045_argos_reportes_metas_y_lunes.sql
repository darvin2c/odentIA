CREATE TABLE "report_digest" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_digest_send" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"week" date NOT NULL,
	"state" text DEFAULT 'reclamado' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "report_digest_send_state_check" CHECK ("report_digest_send"."state" in ('reclamado','enviado','incierto','omitido'))
);
--> statement-breakpoint
CREATE TABLE "report_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"metric" text NOT NULL,
	"from_month" date NOT NULL,
	"amount" bigint,
	"currency" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_goal_metric_check" CHECK ("report_goal"."metric" in ('cobrado','pacientes_nuevos')),
	CONSTRAINT "report_goal_amount_check" CHECK ("report_goal"."amount" is null or "report_goal"."amount" > 0),
	CONSTRAINT "report_goal_currency_check" CHECK ("report_goal"."metric" <> 'cobrado' or "report_goal"."amount" is null or "report_goal"."currency" is not null),
	CONSTRAINT "report_goal_month_check" CHECK (extract(day from "report_goal"."from_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "report_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"figure" text NOT NULL,
	"group_by" text DEFAULT 'total' NOT NULL,
	"focus" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_question" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"figure" text,
	"group_by" text,
	"used_model" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_question_outcome_check" CHECK ("report_question"."outcome" in ('respondida','pregunta','no_sabe','clinico','accion','otro','no_pudo'))
);
--> statement-breakpoint
ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_origin_check";--> statement-breakpoint
ALTER TABLE "report_digest" ADD CONSTRAINT "report_digest_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest" ADD CONSTRAINT "report_digest_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest_send" ADD CONSTRAINT "report_digest_send_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_digest_send" ADD CONSTRAINT "report_digest_send_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_goal" ADD CONSTRAINT "report_goal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_goal" ADD CONSTRAINT "report_goal_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pin" ADD CONSTRAINT "report_pin_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_pin" ADD CONSTRAINT "report_pin_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_question" ADD CONSTRAINT "report_question_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_question" ADD CONSTRAINT "report_question_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_digest_user_uidx" ON "report_digest" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_digest_send_week_uidx" ON "report_digest_send" USING btree ("organization_id","user_id","week");--> statement-breakpoint
CREATE UNIQUE INDEX "report_goal_month_uidx" ON "report_goal" USING btree ("organization_id","metric","from_month");--> statement-breakpoint
CREATE UNIQUE INDEX "report_pin_question_uidx" ON "report_pin" USING btree ("organization_id","figure","group_by","focus");--> statement-breakpoint
CREATE INDEX "report_question_org_date_idx" ON "report_question" USING btree ("organization_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_origin_check" CHECK ("ai_usage"."origin" in ('recepcion','probar','simulacion','vista_previa','dictado','practica_dictado','administrador','ya_aviso','vectores','transcripcion','comprobacion','reportes'));