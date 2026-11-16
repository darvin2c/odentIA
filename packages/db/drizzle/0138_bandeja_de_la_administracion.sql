CREATE TABLE "admin"."saas_conversation_mark" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid,
	"thread_key" text,
	"attended_by" text,
	"attended_at" timestamp with time zone,
	"settled_by" text,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saas_conversation_mark_key_check" CHECK (("admin"."saas_conversation_mark"."chat_id" IS NULL) <> ("admin"."saas_conversation_mark"."thread_key" IS NULL)
        AND ("admin"."saas_conversation_mark"."thread_key" IS NULL OR length("admin"."saas_conversation_mark"."thread_key") BETWEEN 3 AND 998)),
	CONSTRAINT "saas_conversation_mark_attended_check" CHECK ("admin"."saas_conversation_mark"."attended_by" IS NULL OR "admin"."saas_conversation_mark"."attended_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "admin"."kairos_ai_usage" DROP CONSTRAINT "kairos_ai_usage_purpose_check";--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" DROP CONSTRAINT "saas_outreach_files_check";--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD COLUMN "basis" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_conversation_mark" ADD CONSTRAINT "saas_conversation_mark_chat_id_saas_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_conversation_mark" ADD CONSTRAINT "saas_conversation_mark_attended_by_user_id_fk" FOREIGN KEY ("attended_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."saas_conversation_mark" ADD CONSTRAINT "saas_conversation_mark_settled_by_user_id_fk" FOREIGN KEY ("settled_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saas_conversation_mark_chat_uidx" ON "admin"."saas_conversation_mark" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saas_conversation_mark_thread_uidx" ON "admin"."saas_conversation_mark" USING btree ("thread_key");--> statement-breakpoint
ALTER TABLE "admin"."kairos_ai_usage" ADD CONSTRAINT "kairos_ai_usage_purpose_check" CHECK ("admin"."kairos_ai_usage"."purpose" IN ('borrador','resumen','anotar','guion','semana','clasificar','vende','mejorar'));--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD CONSTRAINT "kairos_chat_turn_basis_check" CHECK (cardinality("admin"."kairos_chat_turn"."basis") <= 8);--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_delivery_check" CHECK (("admin"."saas_outreach"."delivered_at" IS NULL AND "admin"."saas_outreach"."read_at" IS NULL) OR ("admin"."saas_outreach"."chat_id" IS NOT NULL AND "admin"."saas_outreach"."channel" = 'whatsapp'));--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_files_check" CHECK (cardinality("admin"."saas_outreach"."file_ids") <= 5 AND (cardinality("admin"."saas_outreach"."file_ids") = 0 OR "admin"."saas_outreach"."channel" = 'correo'
        OR ("admin"."saas_outreach"."chat_id" IS NOT NULL AND cardinality("admin"."saas_outreach"."file_ids") = 1)));