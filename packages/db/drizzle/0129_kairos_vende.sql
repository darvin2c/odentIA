CREATE TABLE "admin"."kairos_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"client_id" uuid,
	"assignee_user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pendiente' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_proposal_status_check" CHECK ("admin"."kairos_proposal"."status" IN ('pendiente','confirmada','reemplazada','vencida')),
	CONSTRAINT "kairos_proposal_expires_check" CHECK ("admin"."kairos_proposal"."expires_at" > "admin"."kairos_proposal"."created_at")
);
--> statement-breakpoint
CREATE TABLE "admin"."kairos_setting" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"sells_enabled" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_setting_single_check" CHECK ("admin"."kairos_setting"."id")
);
--> statement-breakpoint
CREATE TABLE "admin"."admin_staff_absence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_staff_absence_check" CHECK ("admin"."admin_staff_absence"."ends_at" > "admin"."admin_staff_absence"."starts_at"
        AND ("admin"."admin_staff_absence"."reason" IS NULL OR length(trim("admin"."admin_staff_absence"."reason")) BETWEEN 1 AND 200))
);
--> statement-breakpoint
CREATE TABLE "admin"."admin_staff_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"weekday" integer NOT NULL,
	"start_min" integer NOT NULL,
	"end_min" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_staff_hours_range_check" CHECK ("admin"."admin_staff_hours"."weekday" BETWEEN 0 AND 6 AND "admin"."admin_staff_hours"."start_min" >= 0 AND "admin"."admin_staff_hours"."end_min" <= 1440
        AND "admin"."admin_staff_hours"."start_min" < "admin"."admin_staff_hours"."end_min")
);
--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" DROP CONSTRAINT "kairos_item_kind_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD COLUMN "kairos_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD COLUMN "kairos_paused_by" text;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "by_kairos" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD COLUMN "channel_chat_id" uuid;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD COLUMN "needs_new_time_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD COLUMN "meeting_url" text;--> statement-breakpoint
ALTER TABLE "admin"."kairos_proposal" ADD CONSTRAINT "kairos_proposal_chat_id_saas_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_proposal" ADD CONSTRAINT "kairos_proposal_client_id_saas_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "admin"."saas_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_proposal" ADD CONSTRAINT "kairos_proposal_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_proposal" ADD CONSTRAINT "kairos_proposal_task_id_saas_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "admin"."saas_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_setting" ADD CONSTRAINT "kairos_setting_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff_absence" ADD CONSTRAINT "admin_staff_absence_user_id_admin_staff_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "admin"."admin_staff"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff_absence" ADD CONSTRAINT "admin_staff_absence_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."admin_staff_hours" ADD CONSTRAINT "admin_staff_hours_user_id_admin_staff_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "admin"."admin_staff"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kairos_proposal_chat_idx" ON "admin"."kairos_proposal" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "kairos_proposal_pending_uidx" ON "admin"."kairos_proposal" USING btree ("chat_id") WHERE "admin"."kairos_proposal"."status" = 'pendiente';--> statement-breakpoint
CREATE INDEX "admin_staff_absence_user_idx" ON "admin"."admin_staff_absence" USING btree ("user_id","ends_at");--> statement-breakpoint
CREATE INDEX "admin_staff_hours_user_idx" ON "admin"."admin_staff_hours" USING btree ("user_id","weekday");--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_kairos_paused_by_user_id_fk" FOREIGN KEY ("kairos_paused_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_channel_chat_id_saas_chat_id_fk" FOREIGN KEY ("channel_chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saas_task_presentation_idx" ON "admin"."saas_task" USING btree ("assignee_user_id","due_at") WHERE "admin"."saas_task"."kind" = 'presentacion' AND "admin"."saas_task"."status" = 'abierta';--> statement-breakpoint
ALTER TABLE "admin"."kairos_item" ADD CONSTRAINT "kairos_item_kind_check" CHECK ("admin"."kairos_item"."kind" IN ('mensaje','propuesta','guion','dato','vinculo','duplicado','demo','presentacion_hecha','correo_sin_cliente','responder_correo','posible_carga','chat_sin_cliente','responder_chat','ausencia_choca'));--> statement-breakpoint
ALTER TABLE "admin"."saas_chat" ADD CONSTRAINT "saas_chat_kairos_paused_check" CHECK ("admin"."saas_chat"."kairos_paused_at" IS NOT NULL OR "admin"."saas_chat"."kairos_paused_by" IS NULL);--> statement-breakpoint
ALTER TABLE "admin"."saas_task" ADD CONSTRAINT "saas_task_ends_check" CHECK ("admin"."saas_task"."ends_at" IS NULL OR ("admin"."saas_task"."due_at" IS NOT NULL AND "admin"."saas_task"."ends_at" > "admin"."saas_task"."due_at"));--> statement-breakpoint
ALTER TABLE "admin"."admin_staff" ADD CONSTRAINT "admin_staff_meeting_url_check" CHECK ("admin"."admin_staff"."meeting_url" IS NULL OR ("admin"."admin_staff"."meeting_url" ~ '^https://[^\s]+$' AND length("admin"."admin_staff"."meeting_url") <= 500));