ALTER TABLE "admin"."kairos_chat_turn" ADD COLUMN "agent" text DEFAULT 'kairos' NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD COLUMN "ariadna_reply" text;--> statement-breakpoint
ALTER TABLE "admin"."kairos_setting" ADD COLUMN "ariadna_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."kairos_setting" ADD COLUMN "ariadna_updated_by" text;--> statement-breakpoint
ALTER TABLE "admin"."kairos_setting" ADD COLUMN "ariadna_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD COLUMN "by_ariadna" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."saas_follow_up" ADD COLUMN "by_ariadna" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin"."kairos_setting" ADD CONSTRAINT "kairos_setting_ariadna_updated_by_user_id_fk" FOREIGN KEY ("ariadna_updated_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD CONSTRAINT "kairos_chat_turn_agent_check" CHECK ("admin"."kairos_chat_turn"."agent" IN ('kairos','ariadna'));--> statement-breakpoint
ALTER TABLE "admin"."kairos_chat_turn" ADD CONSTRAINT "kairos_chat_turn_ariadna_check" CHECK ("admin"."kairos_chat_turn"."ariadna_reply" IS NULL OR ("admin"."kairos_chat_turn"."agent" = 'ariadna' AND "admin"."kairos_chat_turn"."ariadna_reply" IN ('respuesta','oferta','datos','soporte','administracion','paciente')));--> statement-breakpoint
ALTER TABLE "admin"."saas_outreach" ADD CONSTRAINT "saas_outreach_ariadna_check" CHECK (NOT "admin"."saas_outreach"."by_ariadna" OR "admin"."saas_outreach"."by_kairos");