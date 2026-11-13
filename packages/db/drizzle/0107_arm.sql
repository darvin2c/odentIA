CREATE TABLE "admin"."kairos_ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"cost_micros" bigint,
	"client_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_ai_usage_purpose_check" CHECK ("admin"."kairos_ai_usage"."purpose" IN ('borrador','resumen','anotar','guion','semana','clasificar')),
	CONSTRAINT "kairos_ai_usage_tokens_check" CHECK (coalesce("admin"."kairos_ai_usage"."input_tokens", 0) >= 0 AND coalesce("admin"."kairos_ai_usage"."output_tokens", 0) >= 0
        AND coalesce("admin"."kairos_ai_usage"."cached_tokens", 0) >= 0 AND coalesce("admin"."kairos_ai_usage"."cost_micros", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin"."kairos_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expected_state" jsonb,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'espera' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"admin_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_item_kind_check" CHECK ("admin"."kairos_item"."kind" IN ('mensaje','propuesta','guion','dato','vinculo','duplicado','demo','presentacion_hecha','correo_sin_cliente')),
	CONSTRAINT "kairos_item_status_check" CHECK ("admin"."kairos_item"."status" IN ('espera','ejecutada','fallida','incierta','descartada','vencida')),
	CONSTRAINT "kairos_item_text_check" CHECK (length(trim("admin"."kairos_item"."title")) BETWEEN 1 AND 200 AND length(trim("admin"."kairos_item"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "admin"."kairos_weekly" (
	"week_start" date PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"figures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_weekly_monday_check" CHECK (extract(isodow from "admin"."kairos_weekly"."week_start") = 1),
	CONSTRAINT "kairos_weekly_text_check" CHECK (char_length(btrim("admin"."kairos_weekly"."text")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"product" text NOT NULL,
	"country_code" char(2) DEFAULT 'PE' NOT NULL,
	"city" text,
	"professionals" text,
	"current_tool" text,
	"origin" text DEFAULT 'otro' NOT NULL,
	"origin_detail" text,
	"referred_by_client_id" uuid,
	"owner_user_id" text,
	"organization_id" text,
	"archived_at" timestamp with time zone,
	"archived_by" text,
	"summary" text,
	"summary_sources" jsonb,
	"summary_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_client_name_check" CHECK (length(trim("admin"."saas_client"."name")) BETWEEN 1 AND 160),
	CONSTRAINT "saas_client_product_check" CHECK ("admin"."saas_client"."product" IN ('dental','medical','optical')),
	CONSTRAINT "saas_client_country_check" CHECK ("admin"."saas_client"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "saas_client_city_check" CHECK ("admin"."saas_client"."city" IS NULL OR length("admin"."saas_client"."city") <= 120),
	CONSTRAINT "saas_client_professionals_check" CHECK ("admin"."saas_client"."professionals" IS NULL OR "admin"."saas_client"."professionals" IN ('1','2-3','4-9','10+')),
	CONSTRAINT "saas_client_tool_check" CHECK ("admin"."saas_client"."current_tool" IS NULL OR "admin"."saas_client"."current_tool" IN ('nada','cuaderno_excel','otro_software')),
	CONSTRAINT "saas_client_origin_check" CHECK ("admin"."saas_client"."origin" IN ('web','referido','evento','whatsapp','redes','busqueda','otro')),
	CONSTRAINT "saas_client_origin_detail_check" CHECK ("admin"."saas_client"."origin_detail" IS NULL OR length("admin"."saas_client"."origin_detail") <= 300),
	CONSTRAINT "saas_client_referred_check" CHECK ("admin"."saas_client"."referred_by_client_id" IS DISTINCT FROM "admin"."saas_client"."id")
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_client_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"roles_confirmed" boolean DEFAULT true NOT NULL,
	"phone" text,
	"email" text,
	"preferred_channel" text,
	"user_id" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_client_contact_name_check" CHECK (length(trim("admin"."saas_client_contact"."name")) BETWEEN 1 AND 160),
	CONSTRAINT "saas_client_contact_title_check" CHECK ("admin"."saas_client_contact"."title" IS NULL OR length("admin"."saas_client_contact"."title") <= 120),
	CONSTRAINT "saas_client_contact_roles_check" CHECK ("admin"."saas_client_contact"."roles" <@ ARRAY['decide','usa','paga']::text[]),
	CONSTRAINT "saas_client_contact_phone_check" CHECK ("admin"."saas_client_contact"."phone" IS NULL OR "admin"."saas_client_contact"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "saas_client_contact_email_check" CHECK ("admin"."saas_client_contact"."email" IS NULL OR ("admin"."saas_client_contact"."email" = lower("admin"."saas_client_contact"."email") AND length("admin"."saas_client_contact"."email") BETWEEN 3 AND 254)),
	CONSTRAINT "saas_client_contact_channel_check" CHECK ("admin"."saas_client_contact"."preferred_channel" IS NULL OR "admin"."saas_client_contact"."preferred_channel" IN ('whatsapp','correo','llamada'))
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_client_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"admin_only" boolean DEFAULT true NOT NULL,
	"delete_after" date,
	"deleted_at" timestamp with time zone,
	"created_by" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_client_file_kind_check" CHECK ("admin"."saas_client_file"."kind" IN ('carta','propuesta','presentacion','archivo_clinica','correo','otro')),
	CONSTRAINT "saas_client_file_source_check" CHECK ("admin"."saas_client_file"."source" IS NULL OR "admin"."saas_client_file"."source" IN ('persona','kairos','correo')),
	CONSTRAINT "saas_client_file_text_check" CHECK (length(trim("admin"."saas_client_file"."filename")) BETWEEN 1 AND 255 AND "admin"."saas_client_file"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_inbound_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"mailbox" text NOT NULL,
	"product" text NOT NULL,
	"message_id" text NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_address" text NOT NULL,
	"subject" text,
	"text_body" text,
	"sender_verified" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_by" text,
	"matched_at" timestamp with time zone,
	"matched_by_user" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_inbound_email_mailbox_check" CHECK ("admin"."saas_inbound_email"."mailbox" IN ('soporte','contacto')),
	CONSTRAINT "saas_inbound_email_product_check" CHECK ("admin"."saas_inbound_email"."product" IN ('dental','medical','optical')),
	CONSTRAINT "saas_inbound_email_matched_check" CHECK ("admin"."saas_inbound_email"."matched_by" IS NULL OR "admin"."saas_inbound_email"."matched_by" IN ('contacto','solicitud','miembro','persona')),
	CONSTRAINT "saas_inbound_email_text_check" CHECK (length(trim("admin"."saas_inbound_email"."message_id")) BETWEEN 1 AND 998
        AND ("admin"."saas_inbound_email"."text_body" IS NULL OR length("admin"."saas_inbound_email"."text_body") <= 20000)
        AND ("admin"."saas_inbound_email"."subject" IS NULL OR length("admin"."saas_inbound_email"."subject") <= 998))
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"seller_id" uuid,
	"expected_on" date,
	"decision" text,
	"reason" text,
	"reason_detail" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"return_on" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_opportunity_decision_check" CHECK (("admin"."saas_opportunity"."decision" IS NULL) = ("admin"."saas_opportunity"."decided_at" IS NULL)
        AND ("admin"."saas_opportunity"."decision" IS NULL OR "admin"."saas_opportunity"."decision" IN ('entro','no_por_ahora','perdido'))
        AND ("admin"."saas_opportunity"."reason" IS NULL OR "admin"."saas_opportunity"."reason" IN ('precio','sigue_con_lo_que_usa','no_es_el_momento','no_respondio','le_falta_una_funcion','no_es_una_clinica','otro'))
        AND ("admin"."saas_opportunity"."decision" IS DISTINCT FROM 'no_por_ahora' OR "admin"."saas_opportunity"."return_on" IS NOT NULL)
        AND ("admin"."saas_opportunity"."decision" IS NULL OR "admin"."saas_opportunity"."decision" = 'entro' OR "admin"."saas_opportunity"."reason" IS NOT NULL)
        AND ("admin"."saas_opportunity"."decision" IS DISTINCT FROM 'entro' OR ("admin"."saas_opportunity"."reason" IS NULL AND "admin"."saas_opportunity"."reason_detail" IS NULL))),
	CONSTRAINT "saas_opportunity_reason_detail_check" CHECK ("admin"."saas_opportunity"."reason_detail" IS NULL OR length("admin"."saas_opportunity"."reason_detail") <= 500)
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"proposal_id" uuid,
	"kairos_item_id" uuid,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"created_by" text,
	"sent_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_outreach_channel_check" CHECK ("admin"."saas_outreach"."channel" IN ('correo','whatsapp')),
	CONSTRAINT "saas_outreach_status_check" CHECK ("admin"."saas_outreach"."status" IN ('pendiente','enviado','incierto','no_salio')),
	CONSTRAINT "saas_outreach_text_check" CHECK (length(trim("admin"."saas_outreach"."body")) BETWEEN 1 AND 5000 AND length(trim("admin"."saas_outreach"."to_address")) BETWEEN 3 AND 254
        AND ("admin"."saas_outreach"."subject" IS NULL OR length("admin"."saas_outreach"."subject") <= 200))
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"version" integer NOT NULL,
	"plan_id" uuid NOT NULL,
	"list_price_cents" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"discount_bps" integer DEFAULT 0 NOT NULL,
	"discount_months" integer,
	"trial_days" integer,
	"trial_credit_cents" integer,
	"billing_cycle" text DEFAULT 'mensual' NOT NULL,
	"valid_until" date NOT NULL,
	"status" text DEFAULT 'borrador' NOT NULL,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"accepted_note" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_proposal_status_check" CHECK ("admin"."saas_proposal"."status" IN ('borrador','por_aprobar','enviada','aceptada','no_aceptada')),
	CONSTRAINT "saas_proposal_version_check" CHECK ("admin"."saas_proposal"."version" >= 1),
	CONSTRAINT "saas_proposal_money_check" CHECK ("admin"."saas_proposal"."list_price_cents" >= 0 AND "admin"."saas_proposal"."currency" ~ '^[A-Z]{3}$'
        AND ("admin"."saas_proposal"."trial_credit_cents" IS NULL OR "admin"."saas_proposal"."trial_credit_cents" >= 0)),
	CONSTRAINT "saas_proposal_discount_check" CHECK ("admin"."saas_proposal"."discount_bps" BETWEEN 0 AND 9000 AND ("admin"."saas_proposal"."discount_months" IS NULL OR "admin"."saas_proposal"."discount_months" BETWEEN 1 AND 36)),
	CONSTRAINT "saas_proposal_trial_check" CHECK ("admin"."saas_proposal"."trial_days" IS NULL OR "admin"."saas_proposal"."trial_days" BETWEEN 0 AND 365),
	CONSTRAINT "saas_proposal_cycle_check" CHECK ("admin"."saas_proposal"."billing_cycle" IN ('mensual','quincenal')),
	CONSTRAINT "saas_proposal_note_check" CHECK ("admin"."saas_proposal"."accepted_note" IS NULL OR length("admin"."saas_proposal"."accepted_note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "admin"."saas_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"due_on" date NOT NULL,
	"due_at" timestamp with time zone,
	"assignee_user_id" text,
	"contact_id" uuid,
	"demo_id" uuid,
	"status" text DEFAULT 'abierta' NOT NULL,
	"created_by" text,
	"by_kairos" boolean DEFAULT false NOT NULL,
	"kairos_key" text,
	"done_at" timestamp with time zone,
	"done_by" text,
	"done_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_task_kind_check" CHECK ("admin"."saas_task"."kind" IN ('llamar','escribir','presentacion','propuesta','alta','cobro','otro')),
	CONSTRAINT "saas_task_status_check" CHECK ("admin"."saas_task"."status" IN ('abierta','hecha','cancelada')),
	CONSTRAINT "saas_task_title_check" CHECK (length(trim("admin"."saas_task"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "saas_task_done_note_check" CHECK ("admin"."saas_task"."done_note" IS NULL OR length("admin"."saas_task"."done_note") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" DROP CONSTRAINT "saas_follow_up_subject_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "kind" text DEFAULT 'nota' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "demo_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "happened_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "by_kairos" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD COLUMN "source" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."kairos_ai_usage" ADD CONSTRAINT "kairos_ai_usage_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" ADD CONSTRAINT "kairos_item_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" ADD CONSTRAINT "kairos_item_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client" ADD CONSTRAINT "saas_client_referred_by_client_id_saas_client_id_fk" FOREIGN KEY ("referred_by_client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client" ADD CONSTRAINT "saas_client_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client" ADD CONSTRAINT "saas_client_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client" ADD CONSTRAINT "saas_client_archived_by_user_id_fk" FOREIGN KEY ("archived_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client" ADD CONSTRAINT "saas_client_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_contact" ADD CONSTRAINT "saas_client_contact_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_contact" ADD CONSTRAINT "saas_client_contact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD CONSTRAINT "saas_client_file_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_client_file" ADD CONSTRAINT "saas_client_file_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_inbound_email" ADD CONSTRAINT "saas_inbound_email_matched_by_user_user_id_fk" FOREIGN KEY ("matched_by_user") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_opportunity" ADD CONSTRAINT "saas_opportunity_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_opportunity" ADD CONSTRAINT "saas_opportunity_seller_id_saas_seller_id_fk" FOREIGN KEY ("seller_id") REFERENCES "admin"."saas_seller"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_opportunity" ADD CONSTRAINT "saas_opportunity_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_opportunity" ADD CONSTRAINT "saas_opportunity_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_contact_id_saas_client_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "admin"."saas_client_contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_proposal_id_saas_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "admin"."saas_proposal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_kairos_item_id_kairos_item_id_fk" FOREIGN KEY ("kairos_item_id") REFERENCES "admin"."kairos_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_proposal" ADD CONSTRAINT "saas_proposal_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_proposal" ADD CONSTRAINT "saas_proposal_opportunity_id_saas_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "admin"."saas_opportunity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_proposal" ADD CONSTRAINT "saas_proposal_plan_id_saas_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "admin"."saas_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_proposal" ADD CONSTRAINT "saas_proposal_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_proposal" ADD CONSTRAINT "saas_proposal_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_proposal" ADD CONSTRAINT "saas_proposal_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_contact_id_saas_client_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "admin"."saas_client_contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_demo_id_saas_demo_id_fk" FOREIGN KEY ("demo_id") REFERENCES "admin"."saas_demo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_done_by_user_id_fk" FOREIGN KEY ("done_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kairos_ai_usage_created_idx" ON "admin"."kairos_ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kairos_item_idempotency_uidx" ON "admin"."kairos_item" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "kairos_item_status_idx" ON "admin"."kairos_item" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "kairos_item_client_idx" ON "admin"."kairos_item" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_client_org_uidx" ON "admin"."saas_client" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "saas_client_product_idx" ON "admin"."saas_client" USING btree ("product");--> statement-breakpoint
CREATE INDEX "saas_client_owner_idx" ON "admin"."saas_client" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "saas_client_name_idx" ON "admin"."saas_client" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "saas_client_contact_primary_uidx" ON "admin"."saas_client_contact" USING btree ("client_id") WHERE "admin"."saas_client_contact"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "saas_client_contact_user_uidx" ON "admin"."saas_client_contact" USING btree ("client_id","user_id") WHERE "admin"."saas_client_contact"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "saas_client_contact_email_idx" ON "admin"."saas_client_contact" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_client_file_object_uidx" ON "admin"."saas_client_file" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "saas_client_file_client_idx" ON "admin"."saas_client_file" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "saas_client_file_delete_idx" ON "admin"."saas_client_file" USING btree ("delete_after");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_inbound_email_message_uidx" ON "admin"."saas_inbound_email" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "saas_inbound_email_client_idx" ON "admin"."saas_inbound_email" USING btree ("client_id","received_at");--> statement-breakpoint
CREATE INDEX "saas_inbound_email_from_idx" ON "admin"."saas_inbound_email" USING btree ("from_address");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_opportunity_open_uidx" ON "admin"."saas_opportunity" USING btree ("client_id") WHERE "admin"."saas_opportunity"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX "saas_opportunity_client_idx" ON "admin"."saas_opportunity" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "saas_outreach_client_idx" ON "admin"."saas_outreach" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "saas_outreach_status_idx" ON "admin"."saas_outreach" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_proposal_version_uidx" ON "admin"."saas_proposal" USING btree ("client_id","version");--> statement-breakpoint
CREATE INDEX "saas_proposal_status_idx" ON "admin"."saas_proposal" USING btree ("status","valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_task_kairos_key_uidx" ON "admin"."saas_task" USING btree ("kairos_key");--> statement-breakpoint
CREATE INDEX "saas_task_status_due_idx" ON "admin"."saas_task" USING btree ("status","due_on");--> statement-breakpoint
CREATE INDEX "saas_task_client_status_idx" ON "admin"."saas_task" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "saas_task_assignee_status_idx" ON "admin"."saas_task" USING btree ("assignee_user_id","status");--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_contact_id_saas_client_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "admin"."saas_client_contact"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_demo_id_saas_demo_id_fk" FOREIGN KEY ("demo_id") REFERENCES "admin"."saas_demo"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_proposal_id_saas_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "admin"."saas_proposal"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_follow_up_client_idx" ON "admin"."saas_follow_up" USING btree ("client_id","happened_at");--> statement-breakpoint
CREATE INDEX "saas_waitlist_request_client_idx" ON "admin"."saas_waitlist_request" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_kind_check" CHECK ("admin"."saas_follow_up"."kind" IN ('llamada','whatsapp','correo','reunion','presentacion','propuesta','nota'));--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_direction_check" CHECK ("admin"."saas_follow_up"."direction" IS NULL OR "admin"."saas_follow_up"."direction" IN ('salio','entro'));--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_outcome_check" CHECK ("admin"."saas_follow_up"."outcome" IS NULL OR length("admin"."saas_follow_up"."outcome") <= 500);--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD CONSTRAINT "saas_follow_up_subject_check" CHECK ("admin"."saas_follow_up"."client_id" IS NOT NULL OR num_nonnulls("admin"."saas_follow_up"."request_id", "admin"."saas_follow_up"."organization_id") = 1);--> statement-breakpoint
ALTER TABLE "admin"."saas_waitlist_request" ADD CONSTRAINT "saas_waitlist_request_source_check" CHECK ("admin"."saas_waitlist_request"."source" IN ('web','administracion'));