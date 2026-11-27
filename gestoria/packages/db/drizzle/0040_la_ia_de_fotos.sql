-- La IA de fotos (lienzo «La ficha del producto», decisiones 3, 7, 9 y 10): cada vez que mira
-- (`ai_look`: lo que cuenta para el tope del día y lo que costó) y sus propuestas (`ai_proposal`),
-- que una persona usa, cambia o descarta. Nada de esto toca la ficha: usar una propuesta pasa por
-- la operación de siempre.
CREATE TABLE "ai_look" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"product_id" uuid,
	"load_id" uuid,
	"item_id" uuid,
	"photos" integer NOT NULL,
	"state" text DEFAULT 'mirando' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"cached_tokens" integer,
	"output_tokens" integer,
	"cost_micros" integer,
	"failure" text,
	"notice" text,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ai_look_store_id_key" UNIQUE("store_id","id"),
	CONSTRAINT "ai_look_check" CHECK (kind IN ('producto','carga_producto','carga','texto') and state IN ('mirando','lista','fallo') and "ai_look"."photos" between 1 and 100 and ("ai_look"."state" = 'mirando') = ("ai_look"."finished_at" is null) and ("ai_look"."failure" is null or char_length("ai_look"."failure") <= 300) and ("ai_look"."notice" is null or char_length("ai_look"."notice") <= 300) and ("ai_look"."kind" <> 'producto' or "ai_look"."product_id" is not null) and ("ai_look"."kind" not in ('carga', 'carga_producto') or "ai_look"."load_id" is not null) and ("ai_look"."kind" <> 'carga_producto' or "ai_look"."item_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"look_id" uuid NOT NULL,
	"product_id" uuid,
	"load_id" uuid,
	"item_id" uuid,
	"field" text NOT NULL,
	"value" jsonb,
	"reason" text NOT NULL,
	"state" text DEFAULT 'propuesta' NOT NULL,
	"applied_value" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "ai_proposal_check" CHECK (state IN ('propuesta','usada','cambiada','descartada') and "ai_proposal"."field" ~ '^(nombre|categoria|rubro|descripcion|palabras|color|juntar|(dato|pregunta):[a-z][a-z0-9_]{0,39})$' and char_length("ai_proposal"."reason") between 1 and 300 and ("ai_proposal"."value" is null or octet_length("ai_proposal"."value"::text) <= 8000) and ("ai_proposal"."applied_value" is null or octet_length("ai_proposal"."applied_value"::text) <= 8000) and ("ai_proposal"."state" = 'propuesta') = ("ai_proposal"."decided_at" is null) and ("ai_proposal"."decided_at" is null) = ("ai_proposal"."decided_by" is null) and ("ai_proposal"."product_id" is not null or "ai_proposal"."item_id" is not null or "ai_proposal"."load_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "ai_look" ADD CONSTRAINT "ai_look_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_look" ADD CONSTRAINT "ai_look_load_fkey" FOREIGN KEY ("store_id","load_id") REFERENCES "public"."bulk_load"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_look" ADD CONSTRAINT "ai_look_store_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposal" ADD CONSTRAINT "ai_proposal_look_fkey" FOREIGN KEY ("store_id","look_id") REFERENCES "public"."ai_look"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposal" ADD CONSTRAINT "ai_proposal_product_fkey" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposal" ADD CONSTRAINT "ai_proposal_item_fkey" FOREIGN KEY ("store_id","item_id") REFERENCES "public"."bulk_load_item"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposal" ADD CONSTRAINT "ai_proposal_load_fkey" FOREIGN KEY ("store_id","load_id") REFERENCES "public"."bulk_load"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_look_store_idx" ON "ai_look" USING btree ("store_id","requested_at");--> statement-breakpoint
CREATE INDEX "ai_proposal_product_idx" ON "ai_proposal" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_proposal_item_idx" ON "ai_proposal" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "ai_proposal_load_idx" ON "ai_proposal" USING btree ("load_id");