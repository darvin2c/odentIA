CREATE TABLE "admin"."kairos_chat_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"outcome" text DEFAULT 'en_curso' NOT NULL,
	"why" text,
	"outreach_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kairos_chat_turn_outcome_check" CHECK ("admin"."kairos_chat_turn"."outcome" IN ('en_curso','respondio','paso','fallo','omitido')),
	CONSTRAINT "kairos_chat_turn_why_check" CHECK ("admin"."kairos_chat_turn"."why" IS NULL OR length("admin"."kairos_chat_turn"."why") <= 500)
);
--> statement-breakpoint
ALTER TABLE "admin"."kairos_ai_usage" DROP CONSTRAINT "kairos_ai_usage_purpose_check";--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD CONSTRAINT "kairos_chat_turn_chat_id_saas_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "admin"."saas_chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD CONSTRAINT "kairos_chat_turn_message_id_saas_inbound_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "admin"."saas_inbound_message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD CONSTRAINT "kairos_chat_turn_outreach_id_saas_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "admin"."saas_outreach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kairos_chat_turn_message_uidx" ON "admin"."kairos_chat_turn" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "kairos_chat_turn_chat_idx" ON "admin"."kairos_chat_turn" USING btree ("chat_id","created_at");--> statement-breakpoint
ALTER TABLE "admin"."kairos_ai_usage" ADD CONSTRAINT "kairos_ai_usage_purpose_check" CHECK ("admin"."kairos_ai_usage"."purpose" IN ('borrador','resumen','anotar','guion','semana','clasificar','vende'));