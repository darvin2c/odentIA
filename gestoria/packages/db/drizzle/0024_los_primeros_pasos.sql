-- Los primeros pasos de una tienda nueva (lienzo «gestorIA como odentIA», tablero 16): lo que la
-- tienda saltó porque no le aplica y cuándo quedó lista. Lo demás de cada paso se lee de su apartado.
CREATE TABLE "store_setup" (
	"store_id" uuid PRIMARY KEY NOT NULL,
	"skipped" text[] DEFAULT '{}'::text[] NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_setup_skipped_check" CHECK (skipped <@ ARRAY['datos','catalogo','pagos','entregas','chats','sofi','equipo']::text[])
);
--> statement-breakpoint
ALTER TABLE "store_setup" ADD CONSTRAINT "store_setup_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Las tiendas que ya venden no son nuevas: no ven la lista de una tienda que empieza.
INSERT INTO "store_setup" ("store_id", "finished_at")
  SELECT DISTINCT o.store_id, now() FROM "sale_order" o WHERE o.test = false
  ON CONFLICT ("store_id") DO NOTHING;
