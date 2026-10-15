-- Ninguna conversación queda abierta (ADR 0024): el cierre guarda cuándo, quién
-- y por qué; la atención actual empieza al crear o reabrir; el agente insiste una
-- vez por atención; la clínica elige tras cuántas horas de silencio se cierra.
-- Lo que ya estaba cerrado queda como cerrado a mano, en la fecha de su último cambio.
ALTER TABLE "agent_config" ADD COLUMN "close_after_hours" integer DEFAULT 22 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "closed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "attention_started_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "nudged_at" timestamp with time zone;--> statement-breakpoint
UPDATE "conversation" SET "attention_started_at" = "created_at";--> statement-breakpoint
UPDATE "conversation" SET "status" = 'open' WHERE "status" <> 'closed';--> statement-breakpoint
UPDATE "conversation" SET "close_reason" = 'manual', "closed_at" = "updated_at" WHERE "status" = 'closed';--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_closed_by_user_id_user_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_close_after_hours_check" CHECK ("agent_config"."close_after_hours" between 6 and 23);--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_status_check" CHECK ("conversation"."status" in ('open','closed'));--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_close_reason_check" CHECK ("conversation"."close_reason" is null or "conversation"."close_reason" in ('resuelta','sin_respuesta','equipo','manual'));--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_closed_coherence_check" CHECK (("conversation"."status" = 'open' and "conversation"."closed_at" is null and "conversation"."close_reason" is null and "conversation"."closed_by_user_id" is null)
        or ("conversation"."status" = 'closed' and "conversation"."closed_at" is not null and "conversation"."close_reason" is not null));