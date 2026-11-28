-- Sofi se configura eligiendo (tablero 8 de «gestorIA · Configuración, de nuevo»; ADR 0234): cómo
-- habla, qué puede ofrecer, cuándo pasa el chat a una persona y el horario del equipo son columnas
-- con valores fijos, nunca texto que la tienda le escribe. «Lo que debe saber» (texto libre) pasa
-- a «Lo que sabe», preguntas y respuestas (`store_agent_answer`), y «Lo que aprendió» guarda lo
-- que Sofi no supo responder (`agent_gap`), que solo propone: nada se agrega solo.
CREATE TABLE "agent_gap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"question" text NOT NULL,
	"question_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"answer_id" uuid,
	"closed_by" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "agent_gap_texts_check" CHECK (char_length(btrim("agent_gap"."question")) between 3 and 200 and char_length("agent_gap"."question_key") between 1 and 200),
	CONSTRAINT "agent_gap_closed_check" CHECK (("agent_gap"."outcome" is null) = ("agent_gap"."closed_at" is null) and ("agent_gap"."outcome" is null) = ("agent_gap"."closed_by" is null) and ("agent_gap"."outcome" is null or outcome IN ('respondida','quitada')))
);
--> statement-breakpoint
CREATE TABLE "store_agent_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_agent_answer_texts_check" CHECK (char_length(btrim("store_agent_answer"."question")) between 3 and 200 and char_length(btrim("store_agent_answer"."answer")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "tone" text DEFAULT 'cercana' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "address" text DEFAULT 'tu' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "emojis" text DEFAULT 'pocos' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "offer_shipping" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "offer_discount" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "offer_gift" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "offer_second" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "handoff_upset" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "handoff_over_cents" integer;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "team_hours" jsonb;--> statement-breakpoint
ALTER TABLE "store_agent" ADD COLUMN "after_hours_sells" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_gap" ADD CONSTRAINT "agent_gap_conversation_fkey" FOREIGN KEY ("store_id","conversation_id") REFERENCES "public"."conversation"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_gap" ADD CONSTRAINT "agent_gap_answer_fkey" FOREIGN KEY ("answer_id") REFERENCES "public"."store_agent_answer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_agent_answer" ADD CONSTRAINT "store_agent_answer_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_gap_open_uidx" ON "agent_gap" USING btree ("conversation_id","question_key") WHERE outcome is null;--> statement-breakpoint
CREATE INDEX "agent_gap_store_idx" ON "agent_gap" USING btree ("store_id","question_key");--> statement-breakpoint
CREATE INDEX "store_agent_answer_store_idx" ON "store_agent_answer" USING btree ("store_id","created_at");--> statement-breakpoint
ALTER TABLE "store_agent" ADD CONSTRAINT "store_agent_choices_check" CHECK (tone IN ('cercana','formal','directa') and address IN ('tu','usted') and emojis IN ('ninguno','pocos') and ("store_agent"."handoff_over_cents" is null or "store_agent"."handoff_over_cents" > 0));--> statement-breakpoint
-- Lo que la tienda ya le había escrito no se pierde: queda como respuesta (en dos si pasa de 1000
-- caracteres; el texto viejo llegaba a 2000), que la tienda puede partir en preguntas. La columna
-- vieja ya no se lee y se borra en un cambio siguiente.
INSERT INTO "store_agent_answer" ("store_id", "question", "answer", "created_by", "updated_by", "created_at", "updated_at")
SELECT "store_id", 'Lo que le escribiste antes a Sofi', btrim(left(btrim("knowledge"), 1000)), "updated_by", "updated_by", "updated_at", "updated_at"
FROM "store_agent"
WHERE char_length(btrim("knowledge")) > 0;--> statement-breakpoint
INSERT INTO "store_agent_answer" ("store_id", "question", "answer", "created_by", "updated_by", "created_at", "updated_at")
SELECT "store_id", 'Lo que le escribiste antes a Sofi (sigue)', btrim(substr(btrim("knowledge"), 1001, 1000)), "updated_by", "updated_by", "updated_at" + interval '1 second', "updated_at"
FROM "store_agent"
WHERE char_length(btrim(substr(btrim("knowledge"), 1001, 1000))) > 0;